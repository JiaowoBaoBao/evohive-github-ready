import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now } from './db.js';

function payloadHash(payload) {
  return `0x${crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex')}`;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function indexProofEvent({ eventName, payload, proof, meta = {} }) {
  if (!proof?.eventTxHash) return;
  const p = payload || {};

  const requestId = p.requestId || meta.requestId || null;
  const battleId = p.battleId || null;
  const memoryId = p.memoryId || null;

  db.prepare(
    `INSERT INTO proof_events
      (tx_hash, event_name, event_source, event_mode, request_id, battle_id, memory_id, payload_hash, payload_json, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tx_hash) DO UPDATE SET
      event_source=excluded.event_source,
      event_mode=excluded.event_mode,
      request_id=COALESCE(excluded.request_id, proof_events.request_id),
      battle_id=COALESCE(excluded.battle_id, proof_events.battle_id),
      memory_id=COALESCE(excluded.memory_id, proof_events.memory_id),
      payload_hash=excluded.payload_hash,
      payload_json=excluded.payload_json,
      meta_json=excluded.meta_json`
  ).run(
    proof.eventTxHash,
    eventName,
    proof.source || null,
    proof.eventMode || (proof.eventTxLive ? 'live' : 'local'),
    requestId,
    battleId,
    memoryId,
    payloadHash(payload),
    JSON.stringify(payload || {}),
    JSON.stringify({
      ...meta,
      eventTxLive: Boolean(proof.eventTxLive),
      eventTarget: proof.eventTarget || null,
      rawSource: proof.source || null
    }),
    now()
  );
}

export function searchProofEvents({ txHash, requestId, battleId, memoryId, eventName, fromTs, toTs, limit = 50 }) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = db
    .prepare(
      `SELECT tx_hash AS txHash, event_name AS eventName, event_source AS eventSource, event_mode AS eventMode,
              request_id AS requestId, battle_id AS battleId, memory_id AS memoryId,
              payload_hash AS payloadHash, payload_json AS payloadJson, meta_json AS metaJson, created_at AS createdAt
       FROM proof_events
       WHERE (? IS NULL OR tx_hash = ?)
         AND (? IS NULL OR request_id = ?)
         AND (? IS NULL OR battle_id = ?)
         AND (? IS NULL OR memory_id = ?)
         AND (? IS NULL OR event_name = ?)
         AND (? IS NULL OR created_at >= ?)
         AND (? IS NULL OR created_at <= ?)
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(
      txHash || null,
      txHash || null,
      requestId || null,
      requestId || null,
      battleId || null,
      battleId || null,
      memoryId || null,
      memoryId || null,
      eventName || null,
      eventName || null,
      fromTs || null,
      fromTs || null,
      toTs || null,
      toTs || null,
      n
    )
    .map((r) => ({
      ...r,
      payload: safeParse(r.payloadJson),
      meta: safeParse(r.metaJson)
    }));

  return rows;
}

export function decodeProofByTxHash(txHash) {
  const row = db
    .prepare(
      `SELECT tx_hash AS txHash, event_name AS eventName, event_source AS eventSource, event_mode AS eventMode,
              request_id AS requestId, battle_id AS battleId, memory_id AS memoryId,
              payload_hash AS payloadHash, payload_json AS payloadJson, meta_json AS metaJson, created_at AS createdAt
       FROM proof_events WHERE tx_hash = ?`
    )
    .get(txHash);
  if (!row) return null;
  const payload = safeParse(row.payloadJson) || {};

  return {
    ...row,
    payload,
    meta: safeParse(row.metaJson),
    decoded: {
      eventName: row.eventName,
      refs: {
        requestId: row.requestId,
        battleId: row.battleId,
        memoryId: row.memoryId
      },
      payloadDigest: row.payloadHash,
      hint: row.eventMode === 'calldata-only' ? 'calldata envelope proof' : 'structured event proof'
    }
  };
}

export function exportProofAuditPackage({ fromTs, toTs }) {
  const rows = searchProofEvents({ fromTs, toTs, limit: 2000 });
  const packageObj = {
    generatedAt: new Date().toISOString(),
    range: { fromTs: fromTs || null, toTs: toTs || null },
    total: rows.length,
    proofs: rows
  };

  const outDir = path.resolve(process.cwd(), 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const file = path.join(outDir, `proof-audit-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(packageObj, null, 2)}\n`);

  return {
    file,
    total: rows.length,
    digest: payloadHash(packageObj)
  };
}
