import { db, now } from './db.js';
import { searchProofEvents } from './proofAudit.js';

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isTxHash(v) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(v || '').trim());
}

function paymentEvidenceOk(meta = {}) {
  if (Boolean(meta.paymentTxLive) && isTxHash(meta.paymentTxHash)) return true;

  const hashType = String(meta.paymentHashType || '').toLowerCase();
  if (hashType === 'proof') {
    const proof = meta.paymentProofHash || meta.paymentTxHash;
    return isTxHash(proof);
  }

  return false;
}

function eventEvidenceLive(meta = {}) {
  return Boolean(meta.eventTxLive ?? meta.hashLive);
}

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizePrefixes(prefixes = []) {
  if (!Array.isArray(prefixes)) return [];
  return prefixes
    .map((p) => String(p || '').trim().toLowerCase())
    .filter(Boolean);
}

function isTestOnlySample(meta = {}, requestId = '', prefixes = []) {
  if (meta?.testOnly === true) return true;
  if (String(meta?.sampleClass || '').trim().toLowerCase() === 'test') return true;

  const id = String(requestId || meta?.requestId || '').trim().toLowerCase();
  if (!id) return false;

  const list = Array.isArray(prefixes) ? prefixes : normalizePrefixes(prefixes);
  return list.some((prefix) => id.startsWith(prefix));
}

export function premiumSampleCoverage(windowSec = 86400, options = {}) {
  const w = Math.max(300, Number(windowSec) || 86400);
  const requireEventLive = Boolean(options.requireEventLive);
  const minFinalitySec = Math.max(0, Number(options.minFinalitySec) || 0);
  const excludeTestOnly = options.excludeTestOnly != null ? Boolean(options.excludeTestOnly) : true;
  const testRequestIdPrefixes = normalizePrefixes(options.testRequestIdPrefixes || []);
  const sinceTs = now() - w;

  const rows = db
    .prepare(
      `SELECT ts, hash AS eventTxHash, meta_json AS metaJson
       FROM activity_logs
       WHERE action='HIVE_ACCESS_PREMIUM' AND ts >= ?
       ORDER BY id DESC
       LIMIT 1000`
    )
    .all(sinceTs);

  let latestSampleAt = null;
  let latestLiveSampleAt = null;
  let latestFinalizedSampleAt = null;
  let liveSampleCount = 0;
  let finalizedSampleCount = 0;
  let sampleCount = 0;
  let excludedTestOnlyCount = 0;

  const tsNow = now();
  for (const row of rows) {
    const meta = safeParse(row.metaJson) || {};
    const requestId = String(meta.requestId || '').trim();
    if (excludeTestOnly && isTestOnlySample(meta, requestId, testRequestIdPrefixes)) {
      excludedTestOnlyCount += 1;
      continue;
    }

    sampleCount += 1;
    const ts = Number(row.ts || 0);
    if (!latestSampleAt || ts > latestSampleAt) latestSampleAt = ts;

    const live = paymentEvidenceOk(meta) && Boolean(meta.burnTxLive) && (!requireEventLive || eventEvidenceLive(meta));

    if (live) {
      liveSampleCount += 1;
      if (!latestLiveSampleAt || ts > latestLiveSampleAt) latestLiveSampleAt = ts;

      const finalityOk = Math.max(0, tsNow - ts) >= minFinalitySec;
      if (finalityOk) {
        finalizedSampleCount += 1;
        if (!latestFinalizedSampleAt || ts > latestFinalizedSampleAt) latestFinalizedSampleAt = ts;
      }
    }
  }

  return {
    windowSec: w,
    sinceTs,
    requireEventLive,
    minFinalitySec,
    excludeTestOnly,
    testRequestIdPrefixes,
    rawSampleCount: rows.length,
    excludedTestOnlyCount,
    sampleCount,
    liveSampleCount,
    finalizedSampleCount,
    latestSampleAt,
    latestLiveSampleAt,
    latestFinalizedSampleAt,
    ok: sampleCount > 0,
    liveOk: liveSampleCount > 0,
    finalizedOk: finalizedSampleCount > 0
  };
}

export function runReconciliation(options = {}) {
  const limit = Math.max(1, Math.min(5000, Number(options.limit) || 500));
  const coverageWindowSec = Number(options.coverageWindowSec) || 86400;
  const requireEventLive = Boolean(options.requireEventLive);
  const minFinalitySec = Math.max(0, Number(options.minFinalitySec) || 0);
  const excludeTestOnly = options.excludeTestOnly != null ? Boolean(options.excludeTestOnly) : true;
  const testRequestIdPrefixes = normalizePrefixes(options.testRequestIdPrefixes || []);

  const coverage = premiumSampleCoverage(coverageWindowSec, {
    requireEventLive,
    minFinalitySec,
    excludeTestOnly,
    testRequestIdPrefixes
  });

  const premiumLogs = db
    .prepare(
      `SELECT id, ts, hash AS eventTxHash, meta_json AS metaJson
       FROM activity_logs
       WHERE action = 'HIVE_ACCESS_PREMIUM'
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit);

  const burnMap = new Map(
    db
      .prepare(
        `SELECT request_id AS requestId, burn_tx_hash AS burnTxHash, burn_from AS burnFrom, amount_usdc AS amountUsdc FROM burn_records`
      )
      .all()
      .map((r) => [r.requestId, r])
  );

  let checked = 0;
  let mismatch = 0;
  let settlementReadyCount = 0;
  let excludedTestOnlyCount = 0;
  const issues = [];
  const tsNow = now();

  for (const log of premiumLogs) {
    const meta = safeParse(log.metaJson) || {};
    const requestId = meta.requestId;
    if (!requestId) continue;
    if (excludeTestOnly && isTestOnlySample(meta, requestId, testRequestIdPrefixes)) {
      excludedTestOnlyCount += 1;
      continue;
    }
    checked += 1;

    const eventTxHash = String(log.eventTxHash || '').trim();
    const live = paymentEvidenceOk(meta) && Boolean(meta.burnTxLive) && (!requireEventLive || eventEvidenceLive(meta));
    const finalityOk = Math.max(0, tsNow - Number(log.ts || tsNow)) >= minFinalitySec;
    if (live && finalityOk) settlementReadyCount += 1;

    const paymentHashType = String(meta.paymentHashType || '').toLowerCase();
    if (paymentHashType === 'proof') {
      const proof = meta.paymentProofHash || meta.paymentTxHash;
      if (!isTxHash(proof)) {
        mismatch += 1;
        issues.push({ requestId, reason: 'PAYMENT_PROOF_INVALID', got: proof || null });
      }
    } else if (paymentHashType === 'tx' || meta.paymentTxLive) {
      if (!isTxHash(meta.paymentTxHash)) {
        mismatch += 1;
        issues.push({ requestId, reason: 'PAYMENT_TX_INVALID', got: meta.paymentTxHash || null });
      }
    } else if (!paymentEvidenceOk(meta)) {
      mismatch += 1;
      issues.push({
        requestId,
        reason: 'PAYMENT_EVIDENCE_MISSING',
        got: {
          paymentHashType: meta.paymentHashType || null,
          paymentTxHash: meta.paymentTxHash || null,
          paymentProofHash: meta.paymentProofHash || null
        }
      });
    }

    if (meta.burnTxLive && !isTxHash(meta.burnTxHash)) {
      mismatch += 1;
      issues.push({ requestId, reason: 'BURN_TX_INVALID', got: meta.burnTxHash || null });
    }

    const eventLive = eventEvidenceLive(meta);
    if (requireEventLive && !eventLive) {
      mismatch += 1;
      issues.push({ requestId, reason: 'EVENT_LIVE_REQUIRED', got: eventLive });
    }

    if (requireEventLive && eventLive && !isTxHash(eventTxHash)) {
      mismatch += 1;
      issues.push({ requestId, reason: 'EVENT_TX_INVALID', got: eventTxHash || null });
    }

    const burn = burnMap.get(requestId);
    if (!burn) {
      mismatch += 1;
      issues.push({ requestId, reason: 'BURN_RECORD_MISSING' });
      continue;
    }

    if (meta.burnTxHash && burn.burnTxHash && norm(meta.burnTxHash) !== norm(burn.burnTxHash)) {
      mismatch += 1;
      issues.push({
        requestId,
        reason: 'BURN_TX_MISMATCH',
        expected: burn.burnTxHash,
        got: meta.burnTxHash
      });
    }

    if (meta.burnFrom && burn.burnFrom && norm(meta.burnFrom) !== norm(burn.burnFrom)) {
      mismatch += 1;
      issues.push({
        requestId,
        reason: 'BURN_FROM_MISMATCH',
        expected: burn.burnFrom,
        got: meta.burnFrom
      });
    }

    const proofRows = searchProofEvents({ requestId, limit: 10 });
    if (!proofRows.length) {
      mismatch += 1;
      issues.push({ requestId, reason: 'EVENT_PROOF_INDEX_MISSING' });
      continue;
    }

    if (eventTxHash && !proofRows.some((r) => norm(r.txHash) === norm(eventTxHash))) {
      mismatch += 1;
      issues.push({
        requestId,
        reason: 'EVENT_TX_MISMATCH',
        expected: eventTxHash,
        got: proofRows.map((r) => r.txHash).slice(0, 3)
      });
    }

    if (meta.burnTxHash) {
      const hasBurnInProofPayload = proofRows.some((r) => norm(r?.payload?.burnTxHash) === norm(meta.burnTxHash));
      if (!hasBurnInProofPayload) {
        mismatch += 1;
        issues.push({
          requestId,
          reason: 'EVENT_PAYLOAD_BURN_TX_MISMATCH',
          expected: meta.burnTxHash
        });
      }
    }
  }

  if (!coverage.ok) {
    issues.push({
      reason: 'PREMIUM_SAMPLE_MISSING',
      message: `No HIVE_ACCESS_PREMIUM sample in last ${Math.floor(coverage.windowSec / 3600)}h`
    });
  } else if (!coverage.liveOk) {
    issues.push({
      reason: 'PREMIUM_LIVE_SAMPLE_MISSING',
      message: `No live premium sample (payment evidence + burnTxLive${requireEventLive ? ' + eventTxLive' : ''}) in last ${Math.floor(
        coverage.windowSec / 3600
      )}h`
    });
  } else if (!coverage.finalizedOk) {
    issues.push({
      reason: 'PREMIUM_SETTLEMENT_SAMPLE_MISSING',
      message: `No settlement-ready premium sample (minFinalitySec=${minFinalitySec}, requireEventLive=${requireEventLive}) in last ${Math.floor(
        coverage.windowSec / 3600
      )}h`
    });
  }

  const summary = {
    runAt: now(),
    checked,
    mismatch,
    settlementReadyCount,
    requireEventLive,
    minFinalitySec,
    excludeTestOnly,
    testRequestIdPrefixes,
    excludedTestOnlyCount,
    issueCount: issues.length,
    issues: issues.slice(0, 100),
    coverage
  };

  db.prepare(`INSERT INTO reconciliation_runs (run_at, summary_json) VALUES (?, ?)`).run(summary.runAt, JSON.stringify(summary));

  return summary;
}

export function latestReconciliation() {
  const row = db
    .prepare(`SELECT run_at AS runAt, summary_json AS summaryJson FROM reconciliation_runs ORDER BY id DESC LIMIT 1`)
    .get();
  if (!row) return null;
  return safeParse(row.summaryJson) || { runAt: row.runAt };
}
