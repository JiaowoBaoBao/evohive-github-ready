import { db, now } from './db.js';

export function commitMemory(memory, sourceAgent) {
  const ts = now();
  const ttlUntil = ts + memory.ttlDays * 86400;
  db.prepare(`
    INSERT INTO memories (
      memory_id, domain, symbol_set, timeframe, risk_profile, benchmark_version,
      feature_version, content_hash, cid, memory_type, memory_sub_type, tags_json,
      classifier_confidence, encrypted_uri, encrypted_uri_hash, strategy_body, strategy_note,
      source_agent, ttl_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      domain=excluded.domain,
      symbol_set=excluded.symbol_set,
      timeframe=excluded.timeframe,
      risk_profile=excluded.risk_profile,
      benchmark_version=excluded.benchmark_version,
      feature_version=excluded.feature_version,
      content_hash=excluded.content_hash,
      cid=excluded.cid,
      memory_type=excluded.memory_type,
      memory_sub_type=excluded.memory_sub_type,
      tags_json=excluded.tags_json,
      classifier_confidence=excluded.classifier_confidence,
      encrypted_uri=excluded.encrypted_uri,
      encrypted_uri_hash=excluded.encrypted_uri_hash,
      strategy_body=excluded.strategy_body,
      strategy_note=excluded.strategy_note,
      source_agent=excluded.source_agent,
      updated_at=excluded.updated_at
  `).run(
    memory.memoryId,
    memory.domain,
    memory.symbolSet.join(','),
    memory.timeframe,
    memory.riskProfile,
    memory.benchmarkVersion,
    memory.featureVersion,
    memory.contentHash,
    memory.cid || null,
    memory.memoryType || 'semantic',
    memory.memorySubType || null,
    JSON.stringify(memory.attributes || []),
    Number(memory.classifierConfidence || 0),
    memory.encryptedUri || null,
    memory.encryptedUriHash || null,
    memory.contentText || null,
    memory.note || null,
    sourceAgent,
    ttlUntil,
    ts,
    ts
  );

  return { ttlUntil };
}

export function listBuffs({ scope = 'global', domain, premiumOnly = false }) {
  const ts = now();
  const rows = db.prepare(`
    SELECT buff_id, scope, prompt_patch, min_fitness, ttl_until, premium_only
    FROM hive_buffs
    WHERE ttl_until > ?
      AND (scope = ? OR scope = 'global')
      AND (? IS NULL OR scope != 'domain' OR prompt_patch LIKE '%' || ? || '%')
      AND premium_only <= ?
    ORDER BY min_fitness DESC, ttl_until DESC
    LIMIT 10
  `).all(ts, scope, domain ?? null, domain ?? null, premiumOnly ? 1 : 0);

  return rows;
}

export function sweepMemoryLifecycles() {
  const ts = now();
  const graceWindow = 86400;

  const toGrace = db.prepare(`
    UPDATE memories
    SET state = 'grace', updated_at = ?
    WHERE state = 'active' AND ttl_until <= ?
  `).run(ts, ts).changes;

  const toRetired = db.prepare(`
    UPDATE memories
    SET state = 'retired', updated_at = ?
    WHERE state = 'grace' AND ttl_until <= ?
  `).run(ts, ts - graceWindow).changes;

  return { toGrace, toRetired };
}
