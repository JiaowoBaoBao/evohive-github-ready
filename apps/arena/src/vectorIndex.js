import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

const DIM = 16;

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a)) || 1;
}

function cosine(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

export function embedText(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const out = new Array(DIM).fill(0);
  if (!tokens.length) return out;

  for (const token of tokens) {
    const h = crypto.createHash('sha1').update(token).digest();
    const idx = h[0] % DIM;
    const sign = h[1] % 2 === 0 ? 1 : -1;
    const weight = 1 + (h[2] % 7) / 10;
    out[idx] += sign * weight;
  }

  return out.map((v) => Number(v.toFixed(6)));
}

async function qdrantUpsert(memory) {
  if (!config.vector.qdrantUrl) throw new Error('QDRANT_URL_MISSING');
  const url = `${config.vector.qdrantUrl.replace(/\/$/, '')}/collections/${config.vector.qdrantCollection}/points`;
  const point = {
    id: memory.memoryId,
    vector: embedText(memory.embeddingText),
    payload: {
      memoryId: memory.memoryId,
      domain: memory.domain,
      sourceAgent: memory.sourceAgent,
      benchmarkVersion: memory.benchmarkVersion,
      timeframe: memory.timeframe,
      riskProfile: memory.riskProfile
    }
  };

  await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ points: [point] })
  });
}

export async function upsertMemoryVector(memory) {
  const vec = embedText(memory.embeddingText);

  db.prepare(
    `INSERT INTO memory_vectors (memory_id, domain, source_agent, embedding_json, text_blob, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
     ON CONFLICT(memory_id) DO UPDATE SET
       domain = excluded.domain,
       source_agent = excluded.source_agent,
       embedding_json = excluded.embedding_json,
       text_blob = excluded.text_blob,
       updated_at = excluded.updated_at`
  ).run(memory.memoryId, memory.domain, memory.sourceAgent, JSON.stringify(vec), memory.embeddingText);

  if (config.vector.backend === 'qdrant') {
    try {
      await qdrantUpsert(memory);
    } catch {
      // keep local sqlite vector as fallback
    }
  }
}

export function searchSimilarMemories({ query, domain, limit = 5, excludeMemoryId = null, minScore = null }) {
  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  const qv = embedText(query);

  let rows = db
    .prepare(
      `SELECT memory_id AS memoryId, domain, source_agent AS sourceAgent, embedding_json AS embeddingJson, text_blob AS textBlob
       FROM memory_vectors
       WHERE (? IS NULL OR domain = ?)
       LIMIT 200`
    )
    .all(domain || null, domain || null)
    .map((r) => {
      let emb = [];
      try {
        emb = JSON.parse(r.embeddingJson || '[]');
      } catch {
        emb = [];
      }
      return {
        memoryId: r.memoryId,
        domain: r.domain,
        sourceAgent: r.sourceAgent,
        textBlob: r.textBlob,
        score: Number(cosine(qv, emb).toFixed(6))
      };
    });

  if (!rows.length) {
    const q = String(query || '').toLowerCase();
    rows = db
      .prepare(
        `SELECT memory_id AS memoryId, domain, source_agent AS sourceAgent, symbol_set AS symbolSet, benchmark_version AS benchmarkVersion
         FROM memories
         WHERE (? IS NULL OR domain = ?)
         LIMIT 200`
      )
      .all(domain || null, domain || null)
      .map((r) => {
        const text = `${r.symbolSet || ''} ${r.benchmarkVersion || ''}`.toLowerCase();
        const hit = q && text.includes(q) ? 1 : 0;
        return {
          memoryId: r.memoryId,
          domain: r.domain,
          sourceAgent: r.sourceAgent,
          textBlob: text,
          score: hit
        };
      });
  }

  const excluded = String(excludeMemoryId || '').trim();
  const threshold = minScore == null ? null : Number(minScore);

  return rows
    .filter((r) => (!excluded || String(r.memoryId || '') !== excluded))
    .filter((r) => (threshold == null || Number(r.score || 0) >= threshold))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
