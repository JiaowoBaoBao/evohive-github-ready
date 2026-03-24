import { db, now } from './db.js';
import { config } from './config.js';

const riskRank = { low: 1, mid: 2, high: 3 };

function overlapRatio(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const overlap = [...setA].filter((x) => setB.has(x)).length;
  return overlap / Math.max(setA.size, setB.size, 1);
}

export function parseSymbolSet(value) {
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function canMatch(memoryA, memoryB, challenge) {
  if (!memoryA || !memoryB) return { ok: false, reason: 'MISSING_MEMORY' };
  if (memoryA.domain !== memoryB.domain) return { ok: false, reason: 'DOMAIN_MISMATCH' };
  if (memoryA.domain !== challenge.domain) return { ok: false, reason: 'CHALLENGE_DOMAIN_MISMATCH' };

  const benchmarkAligned =
    memoryA.benchmark_version === memoryB.benchmark_version && memoryA.benchmark_version === challenge.benchmarkVersion;
  const timeframeAligned = memoryA.timeframe === memoryB.timeframe && memoryA.timeframe === challenge.timeframe;

  const ratioA = overlapRatio(parseSymbolSet(memoryA.symbol_set), challenge.symbolSet);
  const ratioB = overlapRatio(parseSymbolSet(memoryB.symbol_set), challenge.symbolSet);
  const symbolOverlap = Number(Math.min(ratioA, ratioB).toFixed(4));

  const riskDiff = Math.abs((riskRank[memoryA.risk_profile] || 2) - (riskRank[memoryB.risk_profile] || 2));

  const warnings = [];
  let score = 1;

  if (!benchmarkAligned) {
    warnings.push('BENCHMARK_MISMATCH');
    score -= 0.35;
  }

  if (!timeframeAligned) {
    warnings.push('TIMEFRAME_MISMATCH');
    score -= 0.25;
  }

  if (symbolOverlap < 0.7) {
    warnings.push('SYMBOL_SET_OVERLAP_LOW');
    score -= 0.25;
  } else if (symbolOverlap < 0.85) {
    warnings.push('SYMBOL_SET_OVERLAP_MEDIUM');
    score -= 0.1;
  }

  if (riskDiff > 1) {
    warnings.push('RISK_PROFILE_TOO_FAR');
    score -= 0.15;
  }

  const normalized = Number(Math.max(0, Math.min(1, score)).toFixed(4));
  const tier = normalized >= 0.75 ? 'high' : normalized >= 0.45 ? 'medium' : 'low';

  return {
    ok: true,
    quality: {
      tier,
      score: normalized,
      benchmarkAligned,
      timeframeAligned,
      symbolOverlap,
      riskDiff
    },
    warnings
  };
}

export function enforceRateLimit(challenger, opponent = null, options = {}) {
  const ts = now();
  const oneHourAgo = ts - 3600;
  const todayAgo = ts - 86400;
  const cooldownAgo = ts - config.battleTiming.cooldownSec;
  const skipOpponentLimits = Boolean(options?.skipOpponentLimits);
  const excludeBattleId = String(options?.excludeBattleId || '').trim() || null;

  const battlesPerHour = db.prepare(
    `SELECT COUNT(*) c FROM battles WHERE challenger_agent = ? AND scheduled_at >= ?`
  ).get(challenger, oneHourAgo).c;

  if (battlesPerHour >= config.maxBattlesPerHour) {
    return { ok: false, reason: 'CHALLENGER_RATE_LIMIT_HOURLY' };
  }

  const rival = String(opponent || '').trim();
  if (!rival || skipOpponentLimits) {
    return { ok: true };
  }

  const inCooldown = db.prepare(
    `SELECT COUNT(*) c FROM battles
     WHERE ((challenger_agent = ? AND opponent_agent = ?) OR (challenger_agent = ? AND opponent_agent = ?))
       AND scheduled_at >= ?
       AND (? IS NULL OR battle_id != ?)`
  ).get(challenger, rival, rival, challenger, cooldownAgo, excludeBattleId, excludeBattleId).c;

  if (inCooldown > 0) {
    return { ok: false, reason: 'SAME_OPPONENT_COOLDOWN' };
  }

  const sameOpponent = db.prepare(
    `SELECT COUNT(*) c FROM battles
     WHERE ((challenger_agent = ? AND opponent_agent = ?) OR (challenger_agent = ? AND opponent_agent = ?))
       AND scheduled_at >= ?
       AND (? IS NULL OR battle_id != ?)`
  ).get(challenger, rival, rival, challenger, todayAgo, excludeBattleId, excludeBattleId).c;

  if (sameOpponent >= config.maxSameOpponentPerDay) {
    return { ok: false, reason: 'SAME_OPPONENT_DAILY_LIMIT' };
  }

  return { ok: true };
}
