import { db, now } from './db.js';
import { searchSimilarMemories } from './vectorIndex.js';
import { config } from './config.js';

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

function toScore01FromCosine(cos) {
  return clamp((Number(cos || 0) + 1) / 2, 0, 1);
}

function parseTagsFromAttributes(tagsJson) {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      const trait = String(item?.trait_type || item?.traitType || '').trim().toLowerCase();
      const value = String(item?.value || '').trim();
      if (!value) continue;
      if (trait === 'tag' || trait === 'memory type' || trait === 'memory subtype') out.push(value.toLowerCase());
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}

function inferMemoryType(memory) {
  return String(memory.memory_type || 'semantic').trim().toLowerCase();
}

function isTradingLike(memory) {
  const domain = String(memory.domain || '').toLowerCase();
  return ['spot', 'perp', 'strategy', 'earn'].includes(domain);
}

function isOppositeRisk(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return (x === 'low' && y === 'high') || (x === 'high' && y === 'low');
}

function getVectorText(memoryId) {
  const row = db
    .prepare(`SELECT text_blob AS textBlob FROM memory_vectors WHERE memory_id = ?`)
    .get(memoryId);
  return String(row?.textBlob || '').trim();
}

function mapTypePrior(memoryType) {
  switch (memoryType) {
    case 'procedural':
      return 0.78;
    case 'sentiment':
      return 0.75;
    case 'episodic':
      return 0.58;
    case 'semantic':
    default:
      return 0.64;
  }
}

function calcQuality({ memory, vectorText, similarRows }) {
  let score = 0.55;
  const diagnostics = [];

  const hasMeta = Boolean(memory.memory_type) && Boolean(memory.tags_json);
  if (hasMeta) {
    score += 0.15;
    diagnostics.push('meta:+0.15');
  }

  const textLen = vectorText.length;
  if (textLen >= 50 && textLen <= 300) {
    score += 0.1;
    diagnostics.push('length:+0.10');
  }

  if (/(\d+(\.\d+)?%|\bsharpe\b|\bpnl\b|win[_ -]?rate|gas)/i.test(vectorText)) {
    score += 0.2;
    diagnostics.push('quant:+0.20');
  }

  const top = similarRows[0];
  if (top && Number(top.score) >= 0.92) {
    const peer = db
      .prepare(
        `SELECT risk_profile AS riskProfile, benchmark_version AS benchmarkVersion, source_agent AS sourceAgent
         FROM memories WHERE memory_id = ?`
      )
      .get(top.memoryId);

    let conflict = false;
    if (peer && isOppositeRisk(memory.risk_profile, peer.riskProfile)) conflict = true;
    if (
      peer &&
      memory.benchmark_version &&
      peer.benchmarkVersion &&
      memory.benchmark_version !== peer.benchmarkVersion &&
      Number(top.score) >= 0.96
    ) {
      conflict = true;
    }

    if (conflict) {
      score -= 0.3;
      diagnostics.push('conflict:-0.30');
    }
  }

  return {
    value: clamp(score),
    diagnostics
  };
}

function calcRelevance({ memory, taskContext }) {
  const taskQuery = [
    taskContext.domain,
    taskContext.timeframe,
    taskContext.benchmarkVersion,
    ...(taskContext.symbolSet || []),
    ...(taskContext.activeTags || [])
  ]
    .filter(Boolean)
    .join(' ');

  const rows = searchSimilarMemories({
    query: taskQuery,
    domain: taskContext.domain || memory.domain,
    limit: 300
  });

  const own = rows.find((r) => r.memoryId === memory.memory_id);
  const vecScore = own ? toScore01FromCosine(own.score) : 0.65;

  const activeTags = new Set((taskContext.activeTags || []).map((x) => String(x).toLowerCase()));
  const memTags = new Set(parseTagsFromAttributes(memory.tags_json));
  memTags.add(String(memory.domain || '').toLowerCase());
  memTags.add(String(memory.timeframe || '').toLowerCase());

  let hit = 0;
  for (const t of activeTags) {
    if (memTags.has(t)) hit += 1;
  }

  const tagBonus = activeTags.size > 0 ? (hit / activeTags.size) * 0.2 : 0;
  const value = clamp(vecScore * 0.8 + tagBonus);

  return {
    value,
    diagnostics: {
      vectorScore01: Number(vecScore.toFixed(4)),
      tagHit: hit,
      activeTagCount: activeTags.size
    }
  };
}

function calcPotentialImpact({ memory, simScore }) {
  const memoryType = inferMemoryType(memory);
  const typePrior = mapTypePrior(memoryType);

  if (isTradingLike(memory)) {
    const fit = clamp(memory.fitness ?? 0.5);
    const sim = clamp(simScore ?? 0.65);
    const value = clamp(0.6 * sim + 0.25 * fit + 0.15 * typePrior);
    return {
      value,
      diagnostics: {
        sim,
        fit,
        typePrior
      }
    };
  }

  const transferCount = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM memory_transfers WHERE memory_id = ?`).get(memory.memory_id)?.c || 0
  );
  const usage = clamp(transferCount / 10);
  const value = clamp(0.7 * typePrior + 0.3 * usage);
  return {
    value,
    diagnostics: {
      transferCount,
      usage,
      typePrior
    }
  };
}

function calcNovelty({ memory, vectorText }) {
  const rows = searchSimilarMemories({
    query: vectorText || `${memory.domain} ${memory.timeframe} ${memory.benchmark_version}`,
    domain: memory.domain,
    limit: 30,
    excludeMemoryId: memory.memory_id
  });

  const top = rows[0];
  const topScore = Number(top?.score || 0);

  let novelty;
  if (top && topScore >= 0.92) {
    novelty = 0.3;
  } else if (top && topScore >= 0.75) {
    novelty = 0.8 - ((topScore - 0.75) / 0.17) * 0.2;
  } else {
    novelty = 1.0;
  }

  if (top && String(top.sourceAgent || '') !== String(memory.source_agent || '')) {
    novelty += 0.1;
  }

  return {
    value: clamp(novelty),
    diagnostics: {
      maxSimilarity: Number(topScore.toFixed(6)),
      nearestMemoryId: top?.memoryId || null,
      nearestSourceAgent: top?.sourceAgent || null
    }
  };
}

function calcFreshness({ memory, nowTs }) {
  const createdAt = Number(memory.created_at || nowTs || now());
  const ageDays = Math.max(0, Number((Number(nowTs || now()) - createdAt) / 86400));
  const decay = isTradingLike(memory) ? 0.1 : 0.02;
  const value = clamp(1 / (1 + decay * ageDays));
  return {
    value,
    diagnostics: {
      ageDays: Number(ageDays.toFixed(4)),
      decay
    }
  };
}

function normalizedWeights(raw = {}) {
  const base = {
    quality: Number(raw.quality ?? 0.25),
    relevance: Number(raw.relevance ?? 0.25),
    potentialImpact: Number(raw.potentialImpact ?? 0.2),
    novelty: Number(raw.novelty ?? 0.15),
    freshness: Number(raw.freshness ?? 0.15)
  };

  const sum = Object.values(base).reduce((s, v) => s + Math.max(0, Number(v) || 0), 0) || 1;
  return {
    quality: Number((base.quality / sum).toFixed(6)),
    relevance: Number((base.relevance / sum).toFixed(6)),
    potentialImpact: Number((base.potentialImpact / sum).toFixed(6)),
    novelty: Number((base.novelty / sum).toFixed(6)),
    freshness: Number((base.freshness / sum).toFixed(6))
  };
}

export function scoreMemoryComposite({ memory, taskContext = {}, simScore = null, nowTs = now() }) {
  const vectorText = getVectorText(memory.memory_id);
  const similarRowsForQuality = searchSimilarMemories({
    query: vectorText || `${memory.domain} ${memory.timeframe}`,
    domain: memory.domain,
    limit: 6,
    excludeMemoryId: memory.memory_id
  });

  const quality = calcQuality({ memory, vectorText, similarRows: similarRowsForQuality });
  const relevance = calcRelevance({ memory, taskContext });
  const potentialImpact = calcPotentialImpact({ memory, simScore });
  const novelty = calcNovelty({ memory, vectorText });
  const freshness = calcFreshness({ memory, nowTs });

  const weights = normalizedWeights(config.scoring?.weights || {});

  const final = clamp(
    quality.value * weights.quality +
      relevance.value * weights.relevance +
      potentialImpact.value * weights.potentialImpact +
      novelty.value * weights.novelty +
      freshness.value * weights.freshness
  );

  return {
    final: Number(final.toFixed(6)),
    weights,
    dimensions: {
      quality: Number(quality.value.toFixed(6)),
      relevance: Number(relevance.value.toFixed(6)),
      potentialImpact: Number(potentialImpact.value.toFixed(6)),
      novelty: Number(novelty.value.toFixed(6)),
      freshness: Number(freshness.value.toFixed(6))
    },
    diagnostics: {
      quality: quality.diagnostics,
      relevance: relevance.diagnostics,
      potentialImpact: potentialImpact.diagnostics,
      novelty: novelty.diagnostics,
      freshness: freshness.diagnostics
    }
  };
}
