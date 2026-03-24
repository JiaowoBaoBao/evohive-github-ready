import { db, now } from './db.js';

export function updateFitness(memoryId, raw) {
  const row = db.prepare('SELECT fitness FROM memories WHERE memory_id = ?').get(memoryId);
  if (!row) throw new Error('MEMORY_NOT_FOUND');

  const prev = Number(row.fitness ?? 0.5);
  const next = Number((0.7 * prev + 0.3 * raw).toFixed(6));

  db.prepare("UPDATE memories SET fitness = ?, updated_at = strftime('%s','now') WHERE memory_id = ?").run(next, memoryId);
  return { prev, next };
}

export function scoreToRaw(score) {
  return Math.max(0, Math.min(1, Number(score)));
}

export function applyAntiSybilDecay(raw, battleContext) {
  const lookbackTs = (battleContext.nowTs || now()) - 86400;
  let multiplier = 1;
  const reasons = [];

  // 24h repeated self-reference (same memory pair) only counts 20%
  const sameMemoryPairCount = db
    .prepare(
      `SELECT COUNT(*) c FROM battles
       WHERE status = 'settled'
         AND scheduled_at >= ?
         AND battle_id != ?
         AND ((memory_a = ? AND memory_b = ?) OR (memory_a = ? AND memory_b = ?))`
    )
    .get(
      lookbackTs,
      battleContext.battleId,
      battleContext.memoryA,
      battleContext.memoryB,
      battleContext.memoryB,
      battleContext.memoryA
    ).c;

  if (sameMemoryPairCount > 0) {
    multiplier = Math.min(multiplier, 0.2);
    reasons.push('REPEAT_SELF_REFERENCE_24H');
  }

  // Same-opponent repeated battles: from the 3rd match in 24h, weight drops to 30%
  const sameOpponentCount = db
    .prepare(
      `SELECT COUNT(*) c FROM battles
       WHERE status = 'settled'
         AND scheduled_at >= ?
         AND battle_id != ?
         AND ((challenger_agent = ? AND opponent_agent = ?) OR (challenger_agent = ? AND opponent_agent = ?))`
    )
    .get(
      lookbackTs,
      battleContext.battleId,
      battleContext.agentA,
      battleContext.agentB,
      battleContext.agentB,
      battleContext.agentA
    ).c;

  if (sameOpponentCount >= 2) {
    multiplier = Math.min(multiplier, 0.3);
    reasons.push('SAME_OPPONENT_THIRD_MATCH_DECAY');
  }

  const adjusted = Number((raw * multiplier).toFixed(6));
  return {
    raw,
    adjusted,
    multiplier,
    reasons,
    context: {
      sameMemoryPairCount,
      sameOpponentCount
    }
  };
}
