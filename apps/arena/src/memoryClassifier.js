import crypto from 'node:crypto';
import { config } from './config.js';

export const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'sentiment'];

function cleanText(v) {
  return String(v || '').trim();
}

function parseJsonSafe(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeAttributes(attributes = []) {
  if (!Array.isArray(attributes)) return [];
  return attributes
    .map((x) => {
      const traitType = cleanText(x?.trait_type || x?.traitType);
      const value = cleanText(x?.value);
      if (!traitType || !value) return null;
      return { trait_type: traitType, value };
    })
    .filter(Boolean)
    .slice(0, 64);
}

function uniqueTags(tags = []) {
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const v = cleanText(t);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function keywordScore(text, patterns) {
  let score = 0;
  for (const re of patterns) {
    if (re.test(text)) score += 1;
  }
  return score;
}

function heuristicClassify(memory) {
  const text = [
    memory.domain,
    memory.timeframe,
    memory.riskProfile,
    memory.benchmarkVersion,
    memory.featureVersion,
    ...(memory.symbolSet || []),
    memory.contentText,
    memory.note,
    memory.cid,
    memory.encryptedUri
  ]
    .map((x) => cleanText(x).toLowerCase())
    .join(' ');

  const episodicPatterns = [
    /\b(bought|sold|entry|exit|filled|order|tx|transaction|executed|closed)\b/,
    /\b(today|yesterday|last\s+night|this\s+morning|on\s+\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/,
    /(买入|卖出|成交|交易哈希|开仓|平仓)/
  ];

  const proceduralPatterns = [
    /\b(script|workflow|runbook|pipeline|procedure|playbook|automation|steps?)\b/,
    /\b(how\s+to|sop|checklist|retry|deploy|rollback)\b/,
    /(脚本|流程|步骤|自动化|值班|回滚)/
  ];

  const sentimentPatterns = [
    /\b(prefer|preference|emotion|sentiment|fear|greed|anxious|confidence|risk\s*averse|risk\s*seeking)\b/,
    /\b(bullish|bearish|panic|fomo)\b/,
    /(偏好|情绪|厌恶|保守|激进|恐慌|看多|看空)/
  ];

  const semanticPatterns = [
    /\b(cycle|theory|knowledge|fact|correlation|regime|taxonomy|definition)\b/,
    /(规律|原理|知识|定义|相关性)/
  ];

  const scores = {
    episodic: keywordScore(text, episodicPatterns),
    procedural: keywordScore(text, proceduralPatterns),
    sentiment: keywordScore(text, sentimentPatterns),
    semantic: keywordScore(text, semanticPatterns)
  };

  let memoryType = 'semantic';
  let maxScore = scores.semantic;
  for (const type of ['episodic', 'procedural', 'sentiment']) {
    if (scores[type] > maxScore) {
      memoryType = type;
      maxScore = scores[type];
    }
  }

  const confidence = Number(Math.min(0.99, 0.55 + maxScore * 0.12).toFixed(3));
  const subType = memory.domain ? `${memory.domain}-${memoryType}` : memoryType;

  return { memoryType, subType, confidence };
}

async function oracleClassify(memory) {
  const url = cleanText(config.memory.classifierOracleUrl);
  if (!url) throw new Error('MEMORY_CLASSIFIER_ORACLE_URL_MISSING');

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(config.memory.classifierTimeoutMs || 4000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memory }),
      signal: controller.signal
    });

    const text = await res.text();
    const json = parseJsonSafe(text, null);
    if (!res.ok || !json) throw new Error(`ORACLE_HTTP_${res.status}`);

    const memoryType = cleanText(json.memoryType || json.type || '').toLowerCase();
    const subType = cleanText(json.subType || '');
    const confidence = Number(json.confidence);

    if (!MEMORY_TYPES.includes(memoryType)) throw new Error(`ORACLE_INVALID_TYPE:${memoryType}`);

    return {
      memoryType,
      subType: subType || `${memory.domain || 'general'}-${memoryType}`,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
      oracleTags: Array.isArray(json.tags) ? json.tags.map(String) : []
    };
  } finally {
    clearTimeout(timer);
  }
}

function defaultAttributes(memory, memoryType, subType, tags = []) {
  const attrs = [
    { trait_type: 'Memory Type', value: memoryType },
    { trait_type: 'Memory SubType', value: subType },
    { trait_type: 'Domain', value: cleanText(memory.domain || 'unknown') },
    { trait_type: 'Timeframe', value: cleanText(memory.timeframe || 'unknown') },
    { trait_type: 'Risk Profile', value: cleanText(memory.riskProfile || 'unknown') },
    { trait_type: 'Benchmark Version', value: cleanText(memory.benchmarkVersion || 'unknown') }
  ];

  for (const t of tags.slice(0, 20)) {
    attrs.push({ trait_type: 'Tag', value: t });
  }
  return attrs;
}

export async function classifyMemory({ memory, similarRows = [] }) {
  const mode = cleanText(config.memory.classifierMode || 'heuristic').toLowerCase();

  let base;
  if (mode === 'oracle') {
    try {
      base = await oracleClassify(memory);
    } catch {
      base = heuristicClassify(memory);
    }
  } else {
    base = heuristicClassify(memory);
  }

  const tags = [];
  tags.push(memory.domain);
  if (memory.riskProfile) tags.push(`risk:${memory.riskProfile}`);
  if (memory.timeframe) tags.push(`tf:${memory.timeframe}`);

  if (Array.isArray(base.oracleTags)) tags.push(...base.oracleTags);

  const threshold = Number(config.memory.autoStrategySimilarityThreshold || 0.85);
  const bestSimilar = similarRows.length ? similarRows[0] : null;
  const strategyHit = Number(bestSimilar?.score || 0) >= threshold;
  if (strategyHit) tags.push('Trading Strategy');

  const userAttributes = normalizeAttributes(memory.attributes || []);
  const normalizedTags = uniqueTags(tags);
  const attributes = [...defaultAttributes(memory, base.memoryType, base.subType, normalizedTags), ...userAttributes];

  const encryptedUri = cleanText(memory.encryptedUri || '');
  const encryptedUriHash = encryptedUri
    ? `0x${crypto.createHash('sha256').update(encryptedUri).digest('hex')}`
    : null;

  return {
    memoryType: base.memoryType,
    memorySubType: base.subType,
    classifierConfidence: Number(base.confidence || 0),
    tags: normalizedTags,
    attributes,
    strategyAutoTagged: strategyHit,
    strategySimilarity: bestSimilar ? Number(bestSimilar.score || 0) : 0,
    strategyThreshold: threshold,
    encryptedUri: encryptedUri || null,
    encryptedUriHash
  };
}
