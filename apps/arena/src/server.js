import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { ulid } from 'ulid';

import { config } from './config.js';
import { db, now } from './db.js';
import {
  memoryCommitSchema,
  memoryTransferSchema,
  memoryDeleteSchema,
  challengeSchema,
  acceptSchema,
  runBattleSchema,
  premiumBuffSchema,
  hiveMemoryCloneSchema,
  hiveMemoryRateSchema,
  memoryGenerateSchema
} from './validation.js';
import { hashPayload, validateAuthEnvelope, beginIdempotent, endIdempotent, signaturePolicyStatus } from './replayGuard.js';
import { commitMemory, listBuffs, sweepMemoryLifecycles } from './hiveService.js';
import { enforceRateLimit, parseSymbolSet, canMatch } from './matchmaker.js';
import { runPaperBattle, hashJSON } from './battleEngine.js';
import { getMarketProfile } from './marketData.js';
import { updateFitness, scoreToRaw, applyAntiSybilDecay } from './fitness.js';
import { scoreMemoryComposite } from './memoryScore.js';
import {
  verifyX402Payment,
  burnAntiSybilFee,
  emitEventProof,
  onchainRuntimeStatus,
  processOnchainRetryJobs,
  x402PreflightStatus
} from './onchain.js';
import { addActivity, listActivities } from './activityLog.js';
import { observabilityMiddleware, snapshotMetrics, markBattleMetric, markPaymentMetric, markPaymentLatency } from './observability.js';
import { sweepBattleWindows } from './battleLifecycle.js';
import { upsertMemoryVector, searchSimilarMemories } from './vectorIndex.js';
import { classifyMemory } from './memoryClassifier.js';
import { generateProceduralMemoryDraft, listProceduralDrafts, loadProceduralDraft } from './memoryDrafts.js';
import { assertActionAllowed, assertSameNamespace, resolvePrincipal } from './accessControl.js';
import { createRiskToken, requireRiskConfirmation, securitySummary } from './security.js';
import { indexProofEvent, searchProofEvents, decodeProofByTxHash, exportProofAuditPackage } from './proofAudit.js';
import { runReconciliation, latestReconciliation, premiumSampleCoverage } from './reconciliation.js';
import { retryQueueStats, quarantineNonRetryablePending, archiveFailedRetryJobs } from './resilience.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.resolve(__dirname, '../public');
const projectRoot = path.resolve(__dirname, '../../..');
const exec = promisify(execCallback);
const OPEN_BATTLE_POOL_OPPONENT = '__open_pool__';

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(observabilityMiddleware);
app.use('/panel', express.static(panelDir));

function badRequest(res, error, status = 400) {
  return res.status(status).json({ ok: false, error: String(error.message || error) });
}

function txMeta({ source, live, explorer, mode, error }) {
  return {
    source: source || 'unknown',
    hashLive: Boolean(live),
    eventTxLive: Boolean(live),
    explorerLink: explorer || null,
    eventMode: mode || null,
    sourceError: error || null
  };
}

function explorerOf(hash, live) {
  if (!live || !hash) return null;
  return `https://www.oklink.com/xlayer/tx/${String(hash).replace(/^0x/, '')}`;
}

function isTestRequestId(requestId) {
  const id = String(requestId || '').trim().toLowerCase();
  if (!id) return false;
  const prefixes = Array.isArray(config.ops.reconcileTestRequestIdPrefixes) ? config.ops.reconcileTestRequestIdPrefixes : [];
  return prefixes.some((p) => id.startsWith(String(p || '').trim().toLowerCase()));
}

function parseJsonSafeText(text, fallback = null) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function normalizeAutoEvolveMode() {
  const mode = String(config.ops.autoEvolveMode || 'copy').trim().toLowerCase();
  return mode === 'transfer' ? 'transfer' : 'copy';
}

function isOpenBattleOpponent(agentId) {
  return String(agentId || '').trim() === OPEN_BATTLE_POOL_OPPONENT;
}

function normalizeBattleMode(mode) {
  const out = String(mode || config.battleDefaultMode || 'ranked').trim().toLowerCase();
  return out === 'sparring' ? 'sparring' : 'ranked';
}

function extractTagValuesFromAttributes(attrs = []) {
  if (!Array.isArray(attrs)) return [];
  return attrs
    .filter((x) => String(x?.trait_type || '').trim().toLowerCase() === 'tag')
    .map((x) => String(x?.value || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function nextDerivedMemoryId(prefix = 'mem_evo') {
  return `${prefix}_${ulid().toLowerCase()}`;
}

function hashOptionalText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  return `0x${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

function canonicalAuthForSignature(auth) {
  return stableStringify({
    requestId: auth.requestId,
    agentId: auth.agentId,
    action: auth.action,
    payloadHash: auth.payloadHash,
    issuedAt: auth.issuedAt,
    deadline: auth.deadline,
    arenaId: auth.arenaId,
    chainId: auth.chainId,
    keyId: auth.keyId || null,
    namespace: auth.namespace || null
  });
}

function resolveHmacSecretForSigning(auth = {}) {
  const keyId = String(auth.keyId || '').trim();
  if (keyId && config.hmacKeyring[keyId]) return config.hmacKeyring[keyId];
  return config.signatureSecret || '';
}

function signAuthEnvelopeHmac(auth) {
  const secret = resolveHmacSecretForSigning(auth);
  if (!secret) return null;
  return `0x${crypto.createHmac('sha256', secret).update(canonicalAuthForSignature(auth)).digest('hex')}`;
}

function isLoopbackAddress(value) {
  const ip = String(value || '').trim().toLowerCase();
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
}

function requestIsLoopback(req) {
  return isLoopbackAddress(req.ip) || isLoopbackAddress(req.socket?.remoteAddress);
}

function strategyTransferMeta(memoryRow) {
  const strategyBody = String(memoryRow?.strategy_body || '').trim();
  const strategyNote = String(memoryRow?.strategy_note || '').trim();
  return {
    strategyBodyBytes: Buffer.byteLength(strategyBody || '', 'utf8'),
    strategyNoteBytes: Buffer.byteLength(strategyNote || '', 'utf8'),
    strategyBodyHash: hashOptionalText(strategyBody),
    strategyNoteHash: hashOptionalText(strategyNote)
  };
}

function memoryRowSummary(memoryRow, { includeStrategy = false } = {}) {
  const strategyMeta = strategyTransferMeta(memoryRow);
  const attributes = parseJsonSafeText(memoryRow?.tags_json, []);

  const out = {
    memoryId: memoryRow.memory_id,
    sourceAgent: memoryRow.source_agent,
    domain: memoryRow.domain,
    symbolSet: String(memoryRow.symbol_set || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    timeframe: memoryRow.timeframe,
    riskProfile: memoryRow.risk_profile,
    benchmarkVersion: memoryRow.benchmark_version,
    featureVersion: memoryRow.feature_version,
    contentHash: memoryRow.content_hash,
    cid: memoryRow.cid || null,
    memoryType: memoryRow.memory_type || 'semantic',
    memorySubType: memoryRow.memory_sub_type || null,
    classifierConfidence: Number(memoryRow.classifier_confidence || 0),
    encryptedUriHash: memoryRow.encrypted_uri_hash || null,
    attributes: Array.isArray(attributes) ? attributes : [],
    state: memoryRow.state,
    fitness: Number(memoryRow.fitness || 0.5),
    ttlUntil: Number(memoryRow.ttl_until || 0),
    createdAt: Number(memoryRow.created_at || 0),
    updatedAt: Number(memoryRow.updated_at || 0),
    strategyBodyHash: strategyMeta.strategyBodyHash,
    strategyNoteHash: strategyMeta.strategyNoteHash,
    strategyBodyBytes: strategyMeta.strategyBodyBytes,
    strategyNoteBytes: strategyMeta.strategyNoteBytes
  };

  if (includeStrategy) {
    out.strategyBody = String(memoryRow.strategy_body || '');
    out.strategyNote = String(memoryRow.strategy_note || '');
  }

  return out;
}

function clampListLimit(value, fallback = 20, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function hiveMemoryStats(sourceMemoryId) {
  const heat = db
    .prepare(
      `SELECT COUNT(1) AS c
       FROM hive_memory_clones
       WHERE source_memory_id = ?`
    )
    .get(sourceMemoryId);

  const rating = db
    .prepare(
      `SELECT COUNT(1) AS count, AVG(score) AS avgScore
       FROM hive_memory_ratings
       WHERE source_memory_id = ?`
    )
    .get(sourceMemoryId);

  const ratingCount = Number(rating?.count || 0);
  const avgScore = Number(rating?.avgScore || 0);
  const priorMean = Math.max(0, Math.min(5, Number(config.ops.ratingBayesPriorMean || 3.8)));
  const priorWeight = Math.max(0.0001, Number(config.ops.ratingBayesPriorWeight || 3));
  const weightedScore = (avgScore * ratingCount + priorMean * priorWeight) / (ratingCount + priorWeight);

  return {
    heat: Number(heat?.c || 0),
    ratingCount,
    avgScore,
    weightedScore: Number(weightedScore || 0)
  };
}

function hasCloneEligibility(sourceMemoryId, agentId) {
  const row = db
    .prepare(
      `SELECT id
       FROM hive_memory_clones
       WHERE source_memory_id = ?
         AND target_agent_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(sourceMemoryId, agentId);
  return Boolean(row?.id);
}

function hiveLeaderboardRows({ type = 'heat', limit = 20, minRatingCount = 1, hiveAgentId }) {
  const topLimit = clampListLimit(limit, 20, 200);
  const minRatings = Math.max(1, Math.floor(Number(minRatingCount) || 1));
  const priorMean = Math.max(0, Math.min(5, Number(config.ops.ratingBayesPriorMean || 3.8)));
  const priorWeight = Math.max(0.0001, Number(config.ops.ratingBayesPriorWeight || 3));
  const orderBy =
    type === 'rating'
      ? 'weightedScore DESC, ratingCount DESC, heat DESC, m.updated_at DESC'
      : 'heat DESC, weightedScore DESC, ratingCount DESC, m.updated_at DESC';

  return db
    .prepare(
      `SELECT m.memory_id AS memoryId,
              m.domain AS domain,
              m.memory_type AS memoryType,
              m.fitness AS fitness,
              m.updated_at AS updatedAt,
              COALESCE(c.heat, 0) AS heat,
              COALESCE(r.ratingCount, 0) AS ratingCount,
              COALESCE(r.avgScore, 0) AS avgScore,
              ((COALESCE(r.avgScore, 0) * COALESCE(r.ratingCount, 0) + (? * ?)) / (COALESCE(r.ratingCount, 0) + ?)) AS weightedScore
       FROM memories m
       LEFT JOIN (
         SELECT source_memory_id, COUNT(1) AS heat
         FROM hive_memory_clones
         GROUP BY source_memory_id
       ) c ON c.source_memory_id = m.memory_id
       LEFT JOIN (
         SELECT source_memory_id, COUNT(1) AS ratingCount, AVG(score) AS avgScore
         FROM hive_memory_ratings
         GROUP BY source_memory_id
       ) r ON r.source_memory_id = m.memory_id
       WHERE m.source_agent = ?
         AND m.state = 'active'
         AND (? = 0 OR COALESCE(r.ratingCount, 0) >= ?)
       ORDER BY ${orderBy}
       LIMIT ?`
    )
    .all(priorMean, priorWeight, priorWeight, hiveAgentId, type === 'rating' ? 1 : 0, minRatings, topLimit)
    .map((row, idx) => ({
      rank: idx + 1,
      memoryId: row.memoryId,
      domain: row.domain,
      memoryType: row.memoryType,
      fitness: Number(row.fitness || 0),
      heat: Number(row.heat || 0),
      ratingCount: Number(row.ratingCount || 0),
      avgScore: Number(row.avgScore || 0),
      weightedScore: Number(row.weightedScore || 0),
      updatedAt: Number(row.updatedAt || 0)
    }));
}

function normalizeTagToken(v) {
  return String(v || '').trim().toLowerCase();
}

function memoryTagTokens(memoryRow) {
  const attrs = parseJsonSafeText(memoryRow?.tags_json, []);
  const set = new Set(
    extractTagValuesFromAttributes(attrs)
      .map(normalizeTagToken)
      .filter(Boolean)
  );

  // fallback context tags if explicit tag traits are sparse
  [memoryRow?.domain, memoryRow?.timeframe, memoryRow?.risk_profile]
    .map(normalizeTagToken)
    .filter(Boolean)
    .forEach((x) => set.add(x));

  return [...set];
}

function jaccardSimilarity(a = [], b = []) {
  const setA = new Set((Array.isArray(a) ? a : []).map(normalizeTagToken).filter(Boolean));
  const setB = new Set((Array.isArray(b) ? b : []).map(normalizeTagToken).filter(Boolean));

  if (!setA.size && !setB.size) return 0;
  let inter = 0;
  for (const x of setA) {
    if (setB.has(x)) inter += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  if (!union) return 0;
  return inter / union;
}

function splitStrategyChunks(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const lineChunks = raw
    .split(/\r?\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lineChunks.length >= 3) return lineChunks;

  return raw
    .split(/[。！？!?;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function mutateNumericText(text, mutationRate = 0.15) {
  const rate = Math.max(0, Math.min(1, Number(mutationRate) || 0));
  if (rate <= 0) return String(text || '');

  return String(text || '').replace(/\b\d+(?:\.\d+)?\b/g, (token) => {
    if (Math.random() > rate) return token;
    const n = Number(token);
    if (!Number.isFinite(n) || n === 0) return token;

    const delta = (Math.random() * 2 - 1) * 0.18; // [-18%, +18%]
    const mutated = n * (1 + delta);
    if (!Number.isFinite(mutated) || mutated <= 0) return token;

    if (Number.isInteger(n)) {
      return String(Math.max(1, Math.round(mutated)));
    }

    return String(Number(mutated.toFixed(4))).replace(/\.0+$/, '');
  });
}

function countRecentHiveRecombine(sinceTs) {
  const row = db
    .prepare(
      `SELECT COUNT(1) AS c
       FROM hive_memory_recombinations
       WHERE created_at >= ?`
    )
    .get(sinceTs);
  return Number(row?.c || 0);
}

function wasPairRecombinedRecently(pairKey, sinceTs) {
  const row = db
    .prepare(
      `SELECT id
       FROM hive_memory_recombinations
       WHERE pair_key = ?
         AND created_at >= ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(pairKey, sinceTs);
  return Boolean(row?.id);
}

function countRecentClusterRecombine(clusterKey, sinceTs) {
  if (!clusterKey) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(1) AS c
       FROM hive_memory_recombinations
       WHERE cluster_key = ?
         AND created_at >= ?`
    )
    .get(clusterKey, sinceTs);
  return Number(row?.c || 0);
}

function normalizeDayKey(ts = now()) {
  const d = new Date(Number(ts) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function dailyBudgetUsage(dayKey = normalizeDayKey()) {
  const row = db
    .prepare(
      `SELECT day_key AS dayKey,
              clone_calls AS cloneCalls,
              clone_usdc AS cloneUsdc,
              chain_calls AS chainCalls,
              recombine_runs AS recombineRuns,
              updated_at AS updatedAt
       FROM ops_daily_budget_usage
       WHERE day_key = ?`
    )
    .get(dayKey);

  return {
    dayKey,
    cloneCalls: Number(row?.cloneCalls || 0),
    cloneUsdc: Number(row?.cloneUsdc || 0),
    chainCalls: Number(row?.chainCalls || 0),
    recombineRuns: Number(row?.recombineRuns || 0),
    updatedAt: Number(row?.updatedAt || 0)
  };
}

function bumpDailyBudgetUsage({ cloneCalls = 0, cloneUsdc = 0, chainCalls = 0, recombineRuns = 0 } = {}) {
  const dayKey = normalizeDayKey();
  const ts = now();
  db.prepare(
    `INSERT INTO ops_daily_budget_usage (day_key, clone_calls, clone_usdc, chain_calls, recombine_runs, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_key) DO UPDATE SET
       clone_calls = clone_calls + excluded.clone_calls,
       clone_usdc = clone_usdc + excluded.clone_usdc,
       chain_calls = chain_calls + excluded.chain_calls,
       recombine_runs = recombine_runs + excluded.recombine_runs,
       updated_at = excluded.updated_at`
  ).run(dayKey, Number(cloneCalls || 0), Number(cloneUsdc || 0), Number(chainCalls || 0), Number(recombineRuns || 0), ts);
  return dailyBudgetUsage(dayKey);
}

function dailyBudgetSnapshot() {
  const usage = dailyBudgetUsage();
  const limits = {
    cloneCallsMax: Math.max(0, Number(config.ops.dailyBudgetCloneCallsMax || 0)),
    usdcMax: Math.max(0, Number(config.ops.dailyBudgetUsdcMax || 0)),
    chainCallsMax: Math.max(0, Number(config.ops.dailyBudgetChainCallsMax || 0)),
    recombineRunsMax: Math.max(0, Number(config.ops.dailyBudgetRecombineRunsMax || 0))
  };

  const breaches = [];
  if (limits.cloneCallsMax > 0 && usage.cloneCalls >= limits.cloneCallsMax) breaches.push('clone_calls');
  if (limits.usdcMax > 0 && usage.cloneUsdc >= limits.usdcMax) breaches.push('clone_usdc');
  if (limits.chainCallsMax > 0 && usage.chainCalls >= limits.chainCallsMax) breaches.push('chain_calls');
  if (limits.recombineRunsMax > 0 && usage.recombineRuns >= limits.recombineRunsMax) breaches.push('recombine_runs');

  return {
    enabled: Boolean(config.ops.dailyBudgetEnabled),
    usage,
    limits,
    breaches,
    ok: breaches.length === 0
  };
}

function enforceDailyBudgetOrThrow(kind) {
  if (!config.ops.dailyBudgetEnabled) return;

  const snap = dailyBudgetSnapshot();
  if (snap.ok) return;

  if (kind === 'clone' && (snap.breaches.includes('clone_calls') || snap.breaches.includes('clone_usdc') || snap.breaches.includes('chain_calls'))) {
    throw new Error(`DAILY_BUDGET_EXCEEDED:${snap.breaches.join(',')}`);
  }
  if (kind === 'recombine' && (snap.breaches.includes('recombine_runs') || snap.breaches.includes('chain_calls'))) {
    throw new Error(`DAILY_BUDGET_EXCEEDED:${snap.breaches.join(',')}`);
  }
}

function loadHiveRecombineCandidates({ hiveAgentId, minAvgScore, minRatingCount, minHeat, limit = 80 }) {
  const topLimit = clampListLimit(limit, 50, 200);
  return db
    .prepare(
      `SELECT m.*,
              COALESCE(r.ratingCount, 0) AS ratingCount,
              COALESCE(r.avgScore, 0) AS avgScore,
              COALESCE(c.heat, 0) AS heat
       FROM memories m
       LEFT JOIN (
         SELECT source_memory_id, COUNT(1) AS ratingCount, AVG(score) AS avgScore
         FROM hive_memory_ratings
         GROUP BY source_memory_id
       ) r ON r.source_memory_id = m.memory_id
       LEFT JOIN (
         SELECT source_memory_id, COUNT(1) AS heat
         FROM hive_memory_clones
         GROUP BY source_memory_id
       ) c ON c.source_memory_id = m.memory_id
       WHERE m.source_agent = ?
         AND m.state = 'active'
         AND COALESCE(r.avgScore, 0) >= ?
         AND COALESCE(r.ratingCount, 0) >= ?
         AND COALESCE(c.heat, 0) >= ?
         AND (trim(COALESCE(m.strategy_body, '')) <> '' OR trim(COALESCE(m.strategy_note, '')) <> '')
       ORDER BY r.avgScore DESC, c.heat DESC, m.updated_at DESC
       LIMIT ?`
    )
    .all(hiveAgentId, minAvgScore, minRatingCount, minHeat, topLimit);
}

function clusterKeyFromPair(a, b, tagsA = [], tagsB = []) {
  const shared = (Array.isArray(tagsA) ? tagsA : [])
    .filter((x) => (Array.isArray(tagsB) ? tagsB : []).includes(x))
    .slice(0, 3)
    .join(',');
  const domain = String(a?.domain || b?.domain || 'strategy');
  const timeframe = String(a?.timeframe || b?.timeframe || '1h');
  const risk = String(a?.risk_profile || b?.risk_profile || 'mid');
  return `${domain}|${timeframe}|${risk}|${shared || 'no-shared-tags'}`;
}

function chooseRecombinePair(candidates, { similarityMin, similarityMax, pairCooldownSec, clusterWindowSec = 43200, clusterMaxInWindow = 1, tsNow }) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length < 2) return null;

  const minSim = Math.max(0, Number(similarityMin) || 0);
  const maxSim = Math.min(1, Number(similarityMax) || 1);
  const cooldownSec = Math.max(0, Number(pairCooldownSec) || 0);

  let best = null;
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (!a || !b) continue;

      const tagsA = memoryTagTokens(a);
      const tagsB = memoryTagTokens(b);
      const similarity = jaccardSimilarity(tagsA, tagsB);
      if (similarity < minSim || similarity > maxSim) continue;

      const pairKey = [a.memory_id, b.memory_id].sort().join('|');
      if (cooldownSec > 0 && wasPairRecombinedRecently(pairKey, tsNow - cooldownSec)) {
        continue;
      }

      const clusterKey = clusterKeyFromPair(a, b, tagsA, tagsB);
      if (clusterWindowSec > 0 && clusterMaxInWindow >= 0) {
        const clusterRecent = countRecentClusterRecombine(clusterKey, tsNow - clusterWindowSec);
        if (clusterRecent >= clusterMaxInWindow) {
          continue;
        }
      }

      const avgParentScore = (Number(a.avgScore || 0) + Number(b.avgScore || 0)) / 2;
      const novelty = 1 - similarity;
      const score = avgParentScore * 1.2 + novelty * 0.8 + Math.min(Number(a.heat || 0), Number(b.heat || 0)) * 0.03;

      if (!best || score > best.rankScore) {
        best = { a, b, tagsA, tagsB, similarity, pairKey, clusterKey, avgParentScore, rankScore: score };
      }
    }
  }

  return best;
}

function combineSymbolSet(a, b) {
  const set = new Set();
  String(a || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((x) => set.add(x));
  String(b || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((x) => set.add(x));
  return [...set].slice(0, 12).join(',') || 'BTCUSDT,ETHUSDT,SOLUSDT';
}

function buildRecombinedStrategy(parentA, parentB, { mutationRate = 0.15, similarity = 0, pairKey = '' } = {}) {
  const aBody = String(parentA?.strategy_body || '').trim();
  const bBody = String(parentB?.strategy_body || '').trim();
  const aNote = String(parentA?.strategy_note || '').trim();
  const bNote = String(parentB?.strategy_note || '').trim();

  const aChunks = splitStrategyChunks(aBody || aNote);
  const bChunks = splitStrategyChunks(bBody || bNote);

  const keepA = Math.max(1, Math.ceil(aChunks.length * 0.6));
  const takeB = Math.max(1, Math.ceil(bChunks.length * 0.6));

  const mergedChunks = [...aChunks.slice(0, keepA), ...bChunks.slice(-takeB)].filter(Boolean);
  const mergedBodyBase = mergedChunks.join('\n');
  const mergedBodyRaw = mergedBodyBase || `${aBody}\n\n---\n\n${bBody}`.trim();

  const lineageHeader = [
    '[AUTO_HIVE_RECOMBINE_V1]',
    `pair=${pairKey}`,
    `similarity=${Number(similarity || 0).toFixed(4)}`,
    `parents=${parentA?.memory_id || 'N/A'},${parentB?.memory_id || 'N/A'}`
  ].join(' ');

  const mutatedBody = mutateNumericText(mergedBodyRaw, mutationRate);
  const strategyBody = `${lineageHeader}\n${mutatedBody}`.trim();

  const strategyNoteBase = [aNote, bNote].filter(Boolean).join(' | ').slice(0, 900);
  const strategyNote = mutateNumericText(strategyNoteBase || 'auto recombined memory', mutationRate / 2);

  return { strategyBody, strategyNote };
}

async function runAutoHiveRecombination({ force = false } = {}) {
  const enabled = Boolean(config.ops.autoHiveRecombineEnabled);
  if (!enabled && !force) {
    return { enabled, executed: false, reason: 'DISABLED' };
  }

  const ts = now();
  const maxPerDay = Math.max(0, Number(config.ops.autoHiveRecombineMaxPerDay || 0));
  if (maxPerDay > 0) {
    const dailyCount = countRecentHiveRecombine(ts - 86400);
    if (dailyCount >= maxPerDay) {
      return { enabled, executed: false, reason: 'DAILY_LIMIT_REACHED', dailyCount, maxPerDay };
    }
  }

  const hiveAgentId = String(config.ops.autoEvolveBackupAgentId || 'hive/backup').trim() || 'hive/backup';
  const minAvgScore = Number(config.ops.autoHiveRecombineMinAvgScore || 0);
  const minRatingCount = Math.max(1, Number(config.ops.autoHiveRecombineMinRatingCount || 1));
  const minHeat = Math.max(0, Number(config.ops.autoHiveRecombineMinHeat || 0));

  const candidates = loadHiveRecombineCandidates({
    hiveAgentId,
    minAvgScore,
    minRatingCount,
    minHeat,
    limit: 80
  });

  if (candidates.length < 2) {
    return {
      enabled,
      executed: false,
      reason: 'INSUFFICIENT_CANDIDATES',
      candidateCount: candidates.length,
      minAvgScore,
      minRatingCount,
      minHeat
    };
  }

  const pair = chooseRecombinePair(candidates, {
    similarityMin: config.ops.autoHiveRecombineSimilarityMin,
    similarityMax: config.ops.autoHiveRecombineSimilarityMax,
    pairCooldownSec: config.ops.autoHiveRecombinePairCooldownSec,
    clusterWindowSec: config.ops.autoHiveRecombineClusterWindowSec,
    clusterMaxInWindow: config.ops.autoHiveRecombineClusterMaxInWindow,
    tsNow: ts
  });

  if (!pair) {
    return {
      enabled,
      executed: false,
      reason: 'NO_MATCHING_PAIR',
      candidateCount: candidates.length,
      similarityMin: Number(config.ops.autoHiveRecombineSimilarityMin || 0),
      similarityMax: Number(config.ops.autoHiveRecombineSimilarityMax || 1)
    };
  }

  const { a, b, similarity, pairKey, clusterKey, avgParentScore } = pair;
  const childMemoryId = nextDerivedMemoryId('mem_hive_mut');

  enforceDailyBudgetOrThrow('recombine');

  const stronger = Number(a.avgScore || 0) >= Number(b.avgScore || 0) ? a : b;
  const weaker = stronger === a ? b : a;
  const domain = stronger.domain === weaker.domain ? stronger.domain : 'strategy';
  const timeframe = stronger.timeframe || weaker.timeframe || '1h';
  const riskProfile = stronger.risk_profile || weaker.risk_profile || 'mid';

  const attrsA = parseJsonSafeText(a.tags_json, []);
  const attrsB = parseJsonSafeText(b.tags_json, []);
  const inheritedAttributes = [...(Array.isArray(attrsA) ? attrsA : []), ...(Array.isArray(attrsB) ? attrsB : [])].filter(
    (x) => x && x.trait_type && x.value
  );

  const mutationRate = Math.max(0, Math.min(1, Number(config.ops.autoHiveRecombineMutationRate || 0.15)));
  const recombined = buildRecombinedStrategy(a, b, { mutationRate, similarity, pairKey });

  const childAttributes = [
    ...inheritedAttributes.slice(0, 48),
    { trait_type: 'Tag', value: 'HiveRecombined' },
    { trait_type: 'Tag', value: 'AutoMutated' },
    { trait_type: 'Recombine Parent A', value: a.memory_id },
    { trait_type: 'Recombine Parent B', value: b.memory_id },
    { trait_type: 'Recombine Similarity', value: Number(similarity).toFixed(4) }
  ].slice(0, 64);

  const contentHash = `0x${crypto
    .createHash('sha256')
    .update([recombined.strategyBody, recombined.strategyNote, a.content_hash, b.content_hash, String(ts)].join('\n'))
    .digest('hex')}`;

  const ttlUntil = Math.max(Number(a.ttl_until || 0), Number(b.ttl_until || 0), ts + 30 * 86400);
  const classifierConfidence = (Number(a.classifier_confidence || 0) + Number(b.classifier_confidence || 0)) / 2;
  const childFitness = (Number(a.fitness || 0.5) + Number(b.fitness || 0.5)) / 2;

  db.prepare(
    `INSERT INTO memories (
      memory_id, domain, symbol_set, timeframe, risk_profile, benchmark_version, feature_version,
      content_hash, cid, memory_type, memory_sub_type, tags_json, classifier_confidence,
      encrypted_uri, encrypted_uri_hash, strategy_body, strategy_note,
      source_agent, fitness, state, ttl_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'incubating', ?, ?, ?)`
  ).run(
    childMemoryId,
    domain,
    combineSymbolSet(a.symbol_set, b.symbol_set),
    timeframe,
    riskProfile,
    `recombine:${String(a.benchmark_version || 'na').slice(0, 32)}|${String(b.benchmark_version || 'na').slice(0, 32)}`,
    'hive-recombine-v1',
    contentHash,
    null,
    'procedural',
    'recombined',
    JSON.stringify(childAttributes),
    classifierConfidence,
    null,
    null,
    recombined.strategyBody,
    recombined.strategyNote,
    hiveAgentId,
    childFitness,
    ttlUntil,
    ts,
    ts
  );

  await upsertMemoryVector({
    memoryId: childMemoryId,
    domain,
    sourceAgent: hiveAgentId,
    benchmarkVersion: 'hive-recombine-v1',
    timeframe,
    riskProfile,
    embeddingText: `${domain} ${timeframe} ${riskProfile} ${combineSymbolSet(a.symbol_set, b.symbol_set)} ${recombined.strategyBody.slice(0, 1200)}`
  });

  db.prepare(
    `INSERT INTO hive_memory_recombinations (
      child_memory_id, parent_a_memory_id, parent_b_memory_id, pair_key, cluster_key, similarity, avg_parent_score, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(childMemoryId, a.memory_id, b.memory_id, pairKey, clusterKey, Number(similarity), Number(avgParentScore), ts);

  const eventPayload = {
    requestId: `AUTO_HIVE_RECOMBINE:${childMemoryId}`,
    childMemoryId,
    parentAMemoryId: a.memory_id,
    parentBMemoryId: b.memory_id,
    pairKey,
    similarity,
    avgParentScore,
    mutationRate,
    strategyBodyHash: hashOptionalText(recombined.strategyBody),
    strategyNoteHash: hashOptionalText(recombined.strategyNote),
    timestamp: ts
  };

  const proof = await emitEventProof('HiveMemoryRecombined', eventPayload);
  recordProof('HiveMemoryRecombined', eventPayload, proof, {
    requestId: `AUTO_HIVE_RECOMBINE:${childMemoryId}`,
    memoryId: childMemoryId
  });

  const budget = bumpDailyBudgetUsage({ recombineRuns: 1, chainCalls: 1 });

  addActivity({
    agentId: 'ops',
    action: 'AUTO_HIVE_RECOMBINE',
    message: `Hive recombined memory ${childMemoryId} from ${a.memory_id} + ${b.memory_id}`,
    hash: proof.eventTxHash,
    hashType: 'tx',
    meta: {
      childMemoryId,
      parentAMemoryId: a.memory_id,
      parentBMemoryId: b.memory_id,
      pairKey,
      clusterKey,
      similarity,
      avgParentScore,
      mutationRate,
      incubationState: 'incubating',
      budget,
      ...strategyTransferMeta({ strategy_body: recombined.strategyBody, strategy_note: recombined.strategyNote }),
      ...txMeta({
        source: proof.source,
        live: proof.eventTxLive,
        mode: proof.eventMode,
        explorer: explorerOf(proof.eventTxHash, proof.eventTxLive),
        error: proof?.raw?.error || null
      })
    }
  });

  return {
    enabled,
    executed: true,
    childMemoryId,
    parentAMemoryId: a.memory_id,
    parentBMemoryId: b.memory_id,
    pairKey,
    clusterKey,
    similarity,
    avgParentScore,
    mutationRate,
    state: 'incubating',
    budget,
    eventTxHash: proof.eventTxHash,
    eventSource: proof.source || null,
    eventTxLive: Boolean(proof.eventTxLive)
  };
}

function runHiveIncubationSweep({ limit = 50 } = {}) {
  if (!config.ops.autoHiveIncubationEnabled) {
    return { enabled: false, activated: 0, retired: 0, pending: 0, scanned: 0, reason: 'DISABLED' };
  }

  const ts = now();
  const minMaturitySec = Math.max(0, Number(config.ops.autoHiveIncubationMinMaturitySec || 0));
  const minScore = Math.max(0, Math.min(1, Number(config.ops.autoHiveIncubationMinScore || 0.68)));
  const maxAgeSec = Math.max(minMaturitySec, Number(config.ops.autoHiveIncubationMaxAgeSec || 172800));
  const maxRows = clampListLimit(limit, 50, 500);

  const rows = db
    .prepare(
      `SELECT m.memory_id AS memoryId,
              m.created_at AS createdAt,
              m.updated_at AS updatedAt,
              r.parent_a_memory_id AS parentAMemoryId,
              r.parent_b_memory_id AS parentBMemoryId,
              r.similarity AS similarity,
              r.avg_parent_score AS avgParentScore,
              r.cluster_key AS clusterKey
       FROM memories m
       INNER JOIN hive_memory_recombinations r ON r.child_memory_id = m.memory_id
       WHERE m.state = 'incubating'
       ORDER BY m.created_at ASC
       LIMIT ?`
    )
    .all(maxRows);

  let activated = 0;
  let retired = 0;
  let pending = 0;

  for (const row of rows) {
    const ageSec = Math.max(0, ts - Number(row.createdAt || 0));
    if (ageSec < minMaturitySec) {
      pending += 1;
      continue;
    }

    const parentScore = Math.max(0, Math.min(5, Number(row.avgParentScore || 0))) / 5;
    const diversity = Math.max(0, Math.min(1, 1 - Number(row.similarity || 0)));
    const incubationScore = Number((parentScore * 0.7 + diversity * 0.3).toFixed(6));

    if (incubationScore >= minScore) {
      db.prepare(`UPDATE memories SET state = 'active', updated_at = ? WHERE memory_id = ?`).run(ts, row.memoryId);
      activated += 1;
      addActivity({
        agentId: 'ops',
        action: 'AUTO_HIVE_INCUBATION_ACTIVATE',
        message: `incubating memory activated ${row.memoryId}`,
        meta: {
          memoryId: row.memoryId,
          parentAMemoryId: row.parentAMemoryId,
          parentBMemoryId: row.parentBMemoryId,
          similarity: Number(row.similarity || 0),
          avgParentScore: Number(row.avgParentScore || 0),
          incubationScore,
          minScore,
          ageSec
        }
      });
      continue;
    }

    if (ageSec >= maxAgeSec) {
      db.prepare(`UPDATE memories SET state = 'retired', updated_at = ? WHERE memory_id = ?`).run(ts, row.memoryId);
      retired += 1;
      addActivity({
        agentId: 'ops',
        action: 'AUTO_HIVE_INCUBATION_REJECT',
        message: `incubating memory retired ${row.memoryId}`,
        meta: {
          memoryId: row.memoryId,
          parentAMemoryId: row.parentAMemoryId,
          parentBMemoryId: row.parentBMemoryId,
          similarity: Number(row.similarity || 0),
          avgParentScore: Number(row.avgParentScore || 0),
          incubationScore,
          minScore,
          ageSec,
          maxAgeSec
        }
      });
    } else {
      pending += 1;
    }
  }

  return {
    enabled: true,
    scanned: rows.length,
    activated,
    retired,
    pending,
    minMaturitySec,
    minScore,
    maxAgeSec
  };
}

function listRecentHiveRecombinations(limit = 20) {
  const n = clampListLimit(limit, 20, 200);
  return db
    .prepare(
      `SELECT r.child_memory_id AS childMemoryId,
              r.parent_a_memory_id AS parentAMemoryId,
              r.parent_b_memory_id AS parentBMemoryId,
              r.pair_key AS pairKey,
              r.cluster_key AS clusterKey,
              r.similarity AS similarity,
              r.avg_parent_score AS avgParentScore,
              r.created_at AS createdAt,
              m.state AS childState,
              m.domain AS childDomain
       FROM hive_memory_recombinations r
       LEFT JOIN memories m ON m.memory_id = r.child_memory_id
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .all(n)
    .map((row) => ({
      childMemoryId: row.childMemoryId,
      parentAMemoryId: row.parentAMemoryId,
      parentBMemoryId: row.parentBMemoryId,
      pairKey: row.pairKey,
      clusterKey: row.clusterKey || null,
      similarity: Number(row.similarity || 0),
      avgParentScore: Number(row.avgParentScore || 0),
      createdAt: Number(row.createdAt || 0),
      childState: row.childState || null,
      childDomain: row.childDomain || null
    }));
}

function hiveMemoryLineage(memoryId, depth = 3) {
  const maxDepth = Math.max(1, Math.min(6, Math.floor(Number(depth) || 3)));
  const start = String(memoryId || '').trim();
  if (!start) return { rootMemoryId: start, depth: maxDepth, nodes: [], edges: [] };

  const queue = [{ id: start, d: 0 }];
  const seen = new Set();
  const nodes = new Map();
  const edges = [];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur.id) || cur.d > maxDepth) continue;
    seen.add(cur.id);

    const m = db
      .prepare(
        `SELECT memory_id AS memoryId, source_agent AS sourceAgent, state, domain, timeframe,
                risk_profile AS riskProfile, memory_type AS memoryType, fitness, updated_at AS updatedAt
         FROM memories WHERE memory_id = ?`
      )
      .get(cur.id);

    if (m) {
      nodes.set(cur.id, {
        memoryId: m.memoryId,
        sourceAgent: m.sourceAgent,
        state: m.state,
        domain: m.domain,
        timeframe: m.timeframe,
        riskProfile: m.riskProfile,
        memoryType: m.memoryType,
        fitness: Number(m.fitness || 0),
        updatedAt: Number(m.updatedAt || 0),
        depth: cur.d
      });
    }

    const parentEdge = db
      .prepare(
        `SELECT child_memory_id AS childMemoryId,
                parent_a_memory_id AS parentAMemoryId,
                parent_b_memory_id AS parentBMemoryId,
                similarity,
                pair_key AS pairKey,
                cluster_key AS clusterKey,
                created_at AS createdAt
         FROM hive_memory_recombinations
         WHERE child_memory_id = ?
         LIMIT 1`
      )
      .get(cur.id);

    if (parentEdge) {
      edges.push({
        type: 'recombine-parent',
        childMemoryId: parentEdge.childMemoryId,
        parentAMemoryId: parentEdge.parentAMemoryId,
        parentBMemoryId: parentEdge.parentBMemoryId,
        similarity: Number(parentEdge.similarity || 0),
        pairKey: parentEdge.pairKey,
        clusterKey: parentEdge.clusterKey || null,
        createdAt: Number(parentEdge.createdAt || 0)
      });

      if (cur.d < maxDepth) {
        queue.push({ id: parentEdge.parentAMemoryId, d: cur.d + 1 });
        queue.push({ id: parentEdge.parentBMemoryId, d: cur.d + 1 });
      }
    }

    const childEdges = db
      .prepare(
        `SELECT child_memory_id AS childMemoryId,
                parent_a_memory_id AS parentAMemoryId,
                parent_b_memory_id AS parentBMemoryId,
                similarity,
                pair_key AS pairKey,
                cluster_key AS clusterKey,
                created_at AS createdAt
         FROM hive_memory_recombinations
         WHERE parent_a_memory_id = ? OR parent_b_memory_id = ?
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all(cur.id, cur.id);

    for (const e of childEdges) {
      edges.push({
        type: 'recombine-child',
        childMemoryId: e.childMemoryId,
        parentAMemoryId: e.parentAMemoryId,
        parentBMemoryId: e.parentBMemoryId,
        similarity: Number(e.similarity || 0),
        pairKey: e.pairKey,
        clusterKey: e.clusterKey || null,
        createdAt: Number(e.createdAt || 0)
      });

      if (cur.d < maxDepth) {
        queue.push({ id: e.childMemoryId, d: cur.d + 1 });
      }
    }
  }

  const dedupEdges = [];
  const edgeSeen = new Set();
  for (const e of edges) {
    const key = `${e.type}|${e.childMemoryId}|${e.parentAMemoryId}|${e.parentBMemoryId}|${e.createdAt}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    dedupEdges.push(e);
  }

  return {
    rootMemoryId: start,
    depth: maxDepth,
    nodeCount: nodes.size,
    edgeCount: dedupEdges.length,
    nodes: [...nodes.values()],
    edges: dedupEdges
  };
}

function cloneMemoryForAgent({ sourceMemory, targetMemoryId, targetAgentId, ts, extraAttributes = [] }) {
  const baseAttributes = parseJsonSafeText(sourceMemory?.tags_json, []);
  const mergedAttributes = [
    ...(Array.isArray(baseAttributes) ? baseAttributes : []),
    ...extraAttributes.filter((x) => x && x.trait_type && x.value)
  ].slice(0, 64);

  const ttlUntil = Math.max(Number(sourceMemory?.ttl_until || 0), ts + 7 * 86400);

  db.prepare(
    `INSERT INTO memories (
      memory_id, domain, symbol_set, timeframe, risk_profile, benchmark_version, feature_version,
      content_hash, cid, memory_type, memory_sub_type, tags_json, classifier_confidence,
      encrypted_uri, encrypted_uri_hash, strategy_body, strategy_note,
      source_agent, fitness, state, ttl_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).run(
    targetMemoryId,
    sourceMemory.domain,
    sourceMemory.symbol_set,
    sourceMemory.timeframe,
    sourceMemory.risk_profile,
    sourceMemory.benchmark_version,
    sourceMemory.feature_version,
    sourceMemory.content_hash,
    sourceMemory.cid || null,
    sourceMemory.memory_type || 'semantic',
    sourceMemory.memory_sub_type || null,
    JSON.stringify(mergedAttributes),
    Number(sourceMemory.classifier_confidence || 0),
    sourceMemory.encrypted_uri || null,
    sourceMemory.encrypted_uri_hash || null,
    sourceMemory.strategy_body || null,
    sourceMemory.strategy_note || null,
    targetAgentId,
    Number(sourceMemory.fitness || 0.5),
    ttlUntil,
    ts,
    ts
  );

  return { ttlUntil, attributes: mergedAttributes };
}

async function cloneMemoryVectorForAgent({ sourceMemory, targetMemoryId, targetAgentId, ts }) {
  const vec = db
    .prepare(
      `SELECT embedding_json AS embeddingJson, text_blob AS textBlob
       FROM memory_vectors
       WHERE memory_id = ?`
    )
    .get(sourceMemory.memory_id);

  if (vec?.embeddingJson) {
    db.prepare(
      `INSERT INTO memory_vectors (memory_id, domain, source_agent, embedding_json, text_blob, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         domain = excluded.domain,
         source_agent = excluded.source_agent,
         embedding_json = excluded.embedding_json,
         text_blob = excluded.text_blob,
         updated_at = excluded.updated_at`
    ).run(targetMemoryId, sourceMemory.domain, targetAgentId, vec.embeddingJson, vec.textBlob || null, ts, ts);
    return;
  }

  const embeddingText = [
    sourceMemory.domain,
    sourceMemory.timeframe,
    sourceMemory.risk_profile,
    sourceMemory.benchmark_version,
    sourceMemory.feature_version,
    sourceMemory.symbol_set
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(' ');

  await upsertMemoryVector({
    memoryId: targetMemoryId,
    domain: sourceMemory.domain,
    sourceAgent: targetAgentId,
    benchmarkVersion: sourceMemory.benchmark_version,
    timeframe: sourceMemory.timeframe,
    riskProfile: sourceMemory.risk_profile,
    embeddingText
  });
}

function countAutoEvolveForLoserDay(loserAgentId, sinceTs) {
  const needle = `%"loserAgentId":"${String(loserAgentId || '').replaceAll('"', '')}"%`;
  const row = db
    .prepare(
      `SELECT COUNT(1) AS c
       FROM activity_logs
       WHERE ts >= ?
         AND action IN ('AUTO_EVOLVE_COPY', 'AUTO_EVOLVE_TRANSFER')
         AND meta_json LIKE ?`
    )
    .get(sinceTs, needle);
  return Number(row?.c || 0);
}

async function autoEvolveAfterBattle({ battle, memoryA, memoryB, result }) {
  if (!config.ops.autoEvolveEnabled) {
    return { enabled: false, executed: false, reason: 'DISABLED' };
  }

  const winnerSide = result?.winner === 'A' ? 'A' : result?.winner === 'B' ? 'B' : null;
  if (!winnerSide) {
    return { enabled: true, executed: false, reason: 'DRAW' };
  }

  const scoreGap = Math.abs(Number(result?.scoreA || 0) - Number(result?.scoreB || 0));
  const minGap = Math.max(0, Number(config.ops.autoEvolveMinScoreGap || 0));
  if (scoreGap < minGap) {
    return { enabled: true, executed: false, reason: 'SCORE_GAP_TOO_SMALL', scoreGap, minGap };
  }

  const winnerMemory = winnerSide === 'A' ? memoryA : memoryB;
  const loserAgentId = winnerSide === 'A' ? battle.opponent_agent : battle.challenger_agent;
  const winnerAgentId = winnerSide === 'A' ? battle.challenger_agent : battle.opponent_agent;

  const ts = now();
  const maxPerDay = Math.max(0, Number(config.ops.autoEvolveMaxPerLoserPerDay || 0));
  if (maxPerDay > 0) {
    const recentCount = countAutoEvolveForLoserDay(loserAgentId, ts - 86400);
    if (recentCount >= maxPerDay) {
      return {
        enabled: true,
        executed: false,
        reason: 'DAILY_LIMIT_REACHED',
        loserAgentId,
        dailyCount: recentCount,
        maxPerDay
      };
    }
  }

  const mode = normalizeAutoEvolveMode();
  const summary = {
    enabled: true,
    executed: true,
    mode,
    winnerAgentId,
    loserAgentId,
    winnerMemoryId: winnerMemory.memory_id,
    scoreGap,
    backup: null
  };

  if (config.ops.autoEvolveBackupToHive) {
    const backupMemoryId = nextDerivedMemoryId('mem_backup');
    const backupAgentId = String(config.ops.autoEvolveBackupAgentId || 'hive/backup').trim() || 'hive/backup';
    const { ttlUntil, attributes } = cloneMemoryForAgent({
      sourceMemory: winnerMemory,
      targetMemoryId: backupMemoryId,
      targetAgentId: backupAgentId,
      ts,
      extraAttributes: [
        { trait_type: 'Tag', value: 'AutoEvolveBackup' },
        { trait_type: 'AutoEvolve Source Battle', value: battle.battle_id },
        { trait_type: 'AutoEvolve Source Winner', value: winnerAgentId }
      ]
    });

    await cloneMemoryVectorForAgent({ sourceMemory: winnerMemory, targetMemoryId: backupMemoryId, targetAgentId: backupAgentId, ts });

    const backupPayload = {
      memoryId: backupMemoryId,
      memoryHash: winnerMemory.content_hash,
      encryptedUriHash: winnerMemory.encrypted_uri_hash || null,
      memoryType: winnerMemory.memory_type || 'semantic',
      memorySubType: winnerMemory.memory_sub_type || null,
      classifierConfidence: Number(winnerMemory.classifier_confidence || 0),
      agent: backupAgentId,
      tags: ['AutoEvolveBackup', winnerMemory.domain, winnerMemory.timeframe],
      attributes,
      cid: winnerMemory.cid || null,
      timestamp: ts,
      originMemoryId: winnerMemory.memory_id,
      battleId: battle.battle_id,
      strategyBodyHash: hashOptionalText(winnerMemory.strategy_body),
      strategyNoteHash: hashOptionalText(winnerMemory.strategy_note)
    };

    const backupProof = await emitEventProof('MemoryRecorded', backupPayload);
    recordProof('MemoryRecorded', backupPayload, backupProof, {
      requestId: `AUTO_EVOLVE_BACKUP:${battle.battle_id}`,
      memoryId: backupMemoryId,
      battleId: battle.battle_id
    });

    addActivity({
      agentId: winnerAgentId,
      action: 'AUTO_EVOLVE_BACKUP',
      message: `Battle ${battle.battle_id} winner memory backed up as ${backupMemoryId}`,
      hash: backupProof.eventTxHash,
      hashType: 'tx',
      meta: {
        battleId: battle.battle_id,
        originMemoryId: winnerMemory.memory_id,
        backupMemoryId,
        backupAgentId,
        ttlUntil,
        winnerAgentId,
        loserAgentId,
        ...strategyTransferMeta(winnerMemory),
        ...txMeta({
          source: backupProof.source,
          live: backupProof.eventTxLive,
          mode: backupProof.eventMode,
          explorer: explorerOf(backupProof.eventTxHash, backupProof.eventTxLive),
          error: backupProof?.raw?.error || null
        })
      }
    });

    summary.backup = {
      memoryId: backupMemoryId,
      agentId: backupAgentId,
      eventTxHash: backupProof.eventTxHash,
      eventSource: backupProof.source || null,
      eventTxLive: Boolean(backupProof.eventTxLive)
    };
  }

  if (mode === 'transfer') {
    db.prepare('UPDATE memories SET source_agent = ?, updated_at = ? WHERE memory_id = ?').run(
      loserAgentId,
      ts,
      winnerMemory.memory_id
    );
    db.prepare('UPDATE memory_vectors SET source_agent = ?, updated_at = ? WHERE memory_id = ?').run(
      loserAgentId,
      ts,
      winnerMemory.memory_id
    );

    const transferPayload = {
      memoryId: winnerMemory.memory_id,
      memoryHash: winnerMemory.content_hash,
      from: winnerAgentId,
      to: loserAgentId,
      operator: 'auto-evolve',
      note: `auto evolve from battle ${battle.battle_id}`,
      timestamp: ts,
      strategyBodyHash: hashOptionalText(winnerMemory.strategy_body),
      strategyNoteHash: hashOptionalText(winnerMemory.strategy_note)
    };

    const transferProof = await emitEventProof('MemoryTransferred', transferPayload);
    const transferRequestId = `AUTO_EVO_TRANSFER_${battle.battle_id}_${ulid().toLowerCase()}`;
    recordProof('MemoryTransferred', transferPayload, transferProof, {
      requestId: transferRequestId,
      memoryId: winnerMemory.memory_id,
      battleId: battle.battle_id
    });

    db.prepare(
      `INSERT OR REPLACE INTO memory_transfers (request_id, memory_id, from_agent, to_agent, note, transferred_at, event_tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      transferRequestId,
      winnerMemory.memory_id,
      winnerAgentId,
      loserAgentId,
      `auto evolve from battle ${battle.battle_id}`,
      ts,
      transferProof.eventTxHash
    );

    addActivity({
      agentId: winnerAgentId,
      action: 'AUTO_EVOLVE_TRANSFER',
      message: `Battle ${battle.battle_id} memory ${winnerMemory.memory_id} auto-transferred to ${loserAgentId}`,
      hash: transferProof.eventTxHash,
      hashType: 'tx',
      meta: {
        battleId: battle.battle_id,
        winnerAgentId,
        loserAgentId,
        winnerMemoryId: winnerMemory.memory_id,
        scoreGap,
        ...strategyTransferMeta(winnerMemory),
        ...txMeta({
          source: transferProof.source,
          live: transferProof.eventTxLive,
          mode: transferProof.eventMode,
          explorer: explorerOf(transferProof.eventTxHash, transferProof.eventTxLive),
          error: transferProof?.raw?.error || null
        })
      }
    });

    summary.transferredMemoryId = winnerMemory.memory_id;
    summary.eventTxHash = transferProof.eventTxHash;
    summary.eventSource = transferProof.source || null;
    summary.eventTxLive = Boolean(transferProof.eventTxLive);
    return summary;
  }

  const derivedMemoryId = nextDerivedMemoryId('mem_evo');
  const { ttlUntil, attributes } = cloneMemoryForAgent({
    sourceMemory: winnerMemory,
    targetMemoryId: derivedMemoryId,
    targetAgentId: loserAgentId,
    ts,
    extraAttributes: [
      { trait_type: 'Tag', value: 'AutoEvolve' },
      { trait_type: 'AutoEvolve Source Battle', value: battle.battle_id },
      { trait_type: 'AutoEvolve Source Winner', value: winnerAgentId }
    ]
  });

  await cloneMemoryVectorForAgent({ sourceMemory: winnerMemory, targetMemoryId: derivedMemoryId, targetAgentId: loserAgentId, ts });

  const copiedPayload = {
    memoryId: derivedMemoryId,
    memoryHash: winnerMemory.content_hash,
    encryptedUriHash: winnerMemory.encrypted_uri_hash || null,
    memoryType: winnerMemory.memory_type || 'semantic',
    memorySubType: winnerMemory.memory_sub_type || null,
    classifierConfidence: Number(winnerMemory.classifier_confidence || 0),
    agent: loserAgentId,
    tags: ['AutoEvolve', ...extractTagValuesFromAttributes(attributes), winnerMemory.domain, winnerMemory.timeframe].slice(0, 20),
    attributes,
    cid: winnerMemory.cid || null,
    timestamp: ts,
    originMemoryId: winnerMemory.memory_id,
    battleId: battle.battle_id,
    strategyBodyHash: hashOptionalText(winnerMemory.strategy_body),
    strategyNoteHash: hashOptionalText(winnerMemory.strategy_note)
  };

  const copiedProof = await emitEventProof('MemoryRecorded', copiedPayload);
  recordProof('MemoryRecorded', copiedPayload, copiedProof, {
    requestId: `AUTO_EVOLVE_COPY:${battle.battle_id}`,
    memoryId: derivedMemoryId,
    battleId: battle.battle_id
  });

  addActivity({
    agentId: winnerAgentId,
    action: 'AUTO_EVOLVE_COPY',
    message: `Battle ${battle.battle_id} winner memory copied to loser ${loserAgentId}`,
    hash: copiedProof.eventTxHash,
    hashType: 'tx',
    meta: {
      battleId: battle.battle_id,
      winnerAgentId,
      loserAgentId,
      sourceMemoryId: winnerMemory.memory_id,
      copiedMemoryId: derivedMemoryId,
      ttlUntil,
      scoreGap,
      ...strategyTransferMeta(winnerMemory),
      ...txMeta({
        source: copiedProof.source,
        live: copiedProof.eventTxLive,
        mode: copiedProof.eventMode,
        explorer: explorerOf(copiedProof.eventTxHash, copiedProof.eventTxLive),
        error: copiedProof?.raw?.error || null
      })
    }
  });

  summary.copiedMemoryId = derivedMemoryId;
  summary.ttlUntil = ttlUntil;
  summary.eventTxHash = copiedProof.eventTxHash;
  summary.eventSource = copiedProof.source || null;
  summary.eventTxLive = Boolean(copiedProof.eventTxLive);
  return summary;
}

function recordProof(eventName, payload, proof, extra = {}) {
  indexProofEvent({
    eventName,
    payload,
    proof,
    meta: extra
  });
}

const opsAlertState = {
  lastSentByKey: Object.create(null),
  lastDigestByKey: Object.create(null),
  circuitOpenSince: Object.create(null),
  lastPremiumAcceptanceRunAt: 0,
  lastBalanceCheckAt: 0,
  lastBalanceSnapshot: null,
  lastHiveIncubationRunAt: 0,
  hiveIncubationRunning: false,
  lastHiveRecombineRunAt: 0,
  hiveRecombineRunning: false
};

async function postAlertWebhook(payload) {
  const url = String(config.ops.alertWebhookUrl || '').trim();
  if (!url) return { sent: false, reason: 'WEBHOOK_DISABLED' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(config.ops.alertWebhookTimeoutMs) || 5000));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WEBHOOK_HTTP_${res.status}:${text}`);
    }

    return { sent: true };
  } finally {
    clearTimeout(timer);
  }
}

function allowAlertNow(key, cooldownSec = config.ops.alertIntervalSec) {
  const ts = now();
  const last = Number(opsAlertState.lastSentByKey[key] || 0);
  if (ts - last < Math.max(1, Number(cooldownSec) || 1)) return false;
  opsAlertState.lastSentByKey[key] = ts;
  return true;
}

async function emitOpsAlert({
  key,
  action = 'OPS_ALERT',
  severity = 'warn',
  message,
  meta = {},
  cooldownSec = config.ops.alertIntervalSec,
  dedupeSec = config.ops.alertDedupeSec
}) {
  const digest = crypto
    .createHash('sha256')
    .update(`${key}|${action}|${severity}|${String(message || '')}|${JSON.stringify(meta || {})}`)
    .digest('hex');

  const ts = now();
  const prev = opsAlertState.lastDigestByKey[key];
  if (prev && prev.digest === digest && ts - Number(prev.ts || 0) < Math.max(1, Number(dedupeSec) || 1)) {
    return { skipped: true, reason: 'DEDUPE' };
  }

  if (!allowAlertNow(key, cooldownSec)) return { skipped: true, reason: 'COOLDOWN' };
  opsAlertState.lastDigestByKey[key] = { digest, ts };

  const enrichedMeta = { ...meta, severity };

  addActivity({
    agentId: 'ops',
    action,
    message,
    meta: enrichedMeta
  });

  try {
    await postAlertWebhook({
      kind: action,
      severity,
      key,
      message,
      at: now(),
      meta: enrichedMeta
    });
  } catch (err) {
    addActivity({
      agentId: 'ops',
      action: 'OPS_ALERT_WEBHOOK_ERROR',
      message: String(err?.message || err),
      meta: { key, alertAction: action, severity }
    });
  }

  return { skipped: false };
}

function uiState() {
  const memories = db
    .prepare(
      `SELECT memory_id AS memoryId, source_agent AS sourceAgent, domain, timeframe, risk_profile AS riskProfile,
              benchmark_version AS benchmarkVersion, fitness, state, ttl_until AS ttlUntil,
              memory_type AS memoryType, memory_sub_type AS memorySubType, tags_json AS tagsJson,
              classifier_confidence AS classifierConfidence, encrypted_uri_hash AS encryptedUriHash
       FROM memories
       ORDER BY source_agent, memory_id`
    )
    .all()
    .map((m) => {
      let attributes = [];
      try {
        attributes = m.tagsJson ? JSON.parse(m.tagsJson) : [];
      } catch {
        attributes = [];
      }
      return {
        ...m,
        attributes
      };
    });

  const pendingBattles = db
    .prepare(
      `SELECT battle_id AS battleId, challenger_agent AS challengerAgent, opponent_agent AS opponentAgent,
              memory_a AS memoryA, memory_b AS memoryB, domain, status, rounds, benchmark_version AS benchmarkVersion,
              match_mode AS matchMode, scheduled_at AS scheduledAt, accepted_at AS acceptedAt
       FROM battles
       WHERE status IN ('challenged', 'accepted')
       ORDER BY scheduled_at DESC
       LIMIT 50`
    )
    .all()
    .map((b) => ({
      ...b,
      matchMode: normalizeBattleMode(b.matchMode),
      isOpen: isOpenBattleOpponent(b.opponentAgent),
      opponentAgent: isOpenBattleOpponent(b.opponentAgent) ? null : b.opponentAgent
    }));

  const recentBattles = db
    .prepare(
      `SELECT battle_id AS battleId, challenger_agent AS challengerAgent, opponent_agent AS opponentAgent,
              status, settled_at AS settledAt, result_hash AS resultHash
       FROM battles
       WHERE status = 'settled'
       ORDER BY settled_at DESC
       LIMIT 20`
    )
    .all();

  return {
    memories,
    pendingBattles,
    recentBattles,
    agents: ['agent-a', 'agent-b'],
    runtime: {
      onchainMode: config.onchain.mode,
      signatureMode: config.authSignatureMode,
      vectorBackend: config.vector.backend,
      marketMode: config.marketData.mode,
      scoringMode: config.scoring.useComposite ? 'composite' : 'sim-only'
    }
  };
}

async function withProtectedAction(expectedAction, payload, auth, req, res, handler) {
  const payloadHash = hashPayload(payload);
  try {
    const principal = resolvePrincipal(req);
    assertActionAllowed(principal, expectedAction);
    validateAuthEnvelope(auth, expectedAction, payloadHash);
    requireRiskConfirmation(expectedAction, auth, payloadHash);
    enforceHardThresholdOrThrow(expectedAction);
  } catch (error) {
    return badRequest(res, error, 401);
  }

  const idem = beginIdempotent(auth);
  if (idem.replay && idem.response) {
    return res.json({ ok: true, replay: true, ...idem.response });
  }

  try {
    const response = await handler(payload);
    endIdempotent(auth.requestId, response, 'done');
    return res.json({ ok: true, replay: false, ...response });
  } catch (error) {
    endIdempotent(auth.requestId, { error: String(error.message || error) }, 'failed');
    return badRequest(res, error);
  }
}

app.get('/health', (_req, res) => {
  const security = securitySummary();
  res.json({
    ok: true,
    service: 'evohive-arena',
    time: now(),
    arenaId: config.arenaId,
    onchainMode: config.onchain.mode,
    signatureMode: config.authSignatureMode,
    vectorBackend: config.vector.backend,
    marketMode: config.marketData.mode,
    retryQueue: retryQueueStats(),
    security: config.security.redactSecretsInHealth ? {
      inlineSensitiveEnvCount: security.inlineSensitiveEnvKeys.length,
      riskConfirmationEnabled: security.riskConfirmation.enabled
    } : security
  });
});

app.get('/api/ui/state', (_req, res) => {
  res.json({
    ok: true,
    ...uiState(),
    buffs: listBuffs({ scope: 'global', premiumOnly: false }),
    runtime: {
      onchainMode: config.onchain.mode,
      signatureMode: config.authSignatureMode,
      marketDataMode: config.marketData.mode,
      vectorBackend: config.vector.backend,
      scoringMode: config.scoring.useComposite ? 'composite' : 'sim-only'
    }
  });
});

app.get('/api/ui/logs', (req, res) => {
  const limit = Number(req.query.limit || 200);
  const afterId = Number(req.query.afterId || 0);
  const logs = listActivities({ limit, afterId });
  const nextCursor = logs.length ? Number(logs[logs.length - 1].id || 0) : Math.max(0, afterId);
  res.json({
    ok: true,
    logs,
    nextCursor,
    incremental: afterId > 0,
    onchainMode: config.onchain.mode,
    signatureMode: config.authSignatureMode
  });
});

app.post('/api/ui/auth/sign', (req, res) => {
  if (!config.ui.panelAuthSignerEnabled) {
    return badRequest(res, new Error('UI_AUTH_SIGNER_DISABLED'), 404);
  }

  if (config.ui.panelAuthSignerLocalOnly && !requestIsLoopback(req)) {
    return badRequest(res, new Error('UI_AUTH_SIGNER_LOCALHOST_ONLY'), 403);
  }

  const agentId = String(req.body?.agentId || '').trim();
  const action = String(req.body?.action || '').trim();
  const payload = req.body?.payload;
  const requestIdInput = String(req.body?.requestId || '').trim();
  const requestId = requestIdInput || `${action || 'ACTION'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const namespace = req.body?.namespace ? String(req.body.namespace).trim() : undefined;
  const keyIdInput = req.body?.keyId ? String(req.body.keyId).trim() : '';
  const keyId = keyIdInput || String(config.authDefaultKeyId || '').trim() || undefined;

  if (!agentId) return badRequest(res, new Error('AGENT_ID_REQUIRED'));
  if (!action) return badRequest(res, new Error('ACTION_REQUIRED'));
  if (payload === undefined) return badRequest(res, new Error('PAYLOAD_REQUIRED'));

  const ts = now();
  const ttlInput = Number(req.body?.ttlSec);
  const ttlSec = Number.isFinite(ttlInput)
    ? Math.max(5, Math.min(Math.floor(ttlInput), config.requestTtlSec))
    : config.requestTtlSec;

  const auth = {
    requestId,
    agentId,
    action,
    payloadHash: hashPayload(payload),
    issuedAt: ts,
    deadline: ts + ttlSec,
    arenaId: config.arenaId,
    chainId: config.chainId,
    ...(namespace ? { namespace } : {}),
    ...(keyId ? { keyId } : {})
  };

  const policy = signaturePolicyStatus();
  if (policy.mode === 'eip712' || policy.effectiveMode === 'eip712') {
    return badRequest(res, new Error('UI_AUTH_SIGNER_UNSUPPORTED_FOR_EIP712'), 501);
  }

  const signature = signAuthEnvelopeHmac(auth);
  if (!signature) {
    return badRequest(res, new Error('HMAC_SECRET_NOT_CONFIGURED'), 500);
  }

  res.json({
    ok: true,
    auth: {
      ...auth,
      signature
    },
    signatureMode: 'hmac'
  });
});

app.get('/api/system/status', (_req, res) => {
  res.json({
    ok: true,
    runtime: {
      onchainMode: config.onchain.mode,
      signatureMode: config.authSignatureMode,
      marketMode: config.marketData.mode,
      vectorBackend: config.vector.backend,
      scoringMode: config.scoring.useComposite ? 'composite' : 'sim-only'
    },
    metrics: snapshotMetrics(),
    onchain: onchainRuntimeStatus(),
    retryQueue: retryQueueStats(),
    reconciliation: latestReconciliation(),
    checks: {
      x402: x402PreflightStatus(),
      premiumCoverage24h: premiumSampleCoverage(86400, {
        requireEventLive: config.ops.reconcileRequireEventLive,
        minFinalitySec: config.ops.reconcileMinFinalitySec,
        excludeTestOnly: config.ops.reconcileExcludeTestOnly,
        testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
      }),
      premiumCapacity: currentPremiumCapacitySnapshot(),
      budget: dailyBudgetSnapshot(),
      hardThresholds: hardThresholdStatus(),
      signaturePolicy: signaturePolicyStatus(),
      hiveIncubation: {
        enabled: Boolean(config.ops.autoHiveIncubationEnabled),
        intervalSec: Number(config.ops.autoHiveIncubationIntervalSec || 0),
        minMaturitySec: Number(config.ops.autoHiveIncubationMinMaturitySec || 0),
        minScore: Number(config.ops.autoHiveIncubationMinScore || 0),
        maxAgeSec: Number(config.ops.autoHiveIncubationMaxAgeSec || 0),
        lastRunAt: Number(opsAlertState.lastHiveIncubationRunAt || 0),
        running: Boolean(opsAlertState.hiveIncubationRunning)
      },
      hiveRecombine: {
        enabled: Boolean(config.ops.autoHiveRecombineEnabled),
        intervalSec: Number(config.ops.autoHiveRecombineIntervalSec || 0),
        maxPerDay: Number(config.ops.autoHiveRecombineMaxPerDay || 0),
        minAvgScore: Number(config.ops.autoHiveRecombineMinAvgScore || 0),
        minRatingCount: Number(config.ops.autoHiveRecombineMinRatingCount || 0),
        minHeat: Number(config.ops.autoHiveRecombineMinHeat || 0),
        similarityMin: Number(config.ops.autoHiveRecombineSimilarityMin || 0),
        similarityMax: Number(config.ops.autoHiveRecombineSimilarityMax || 1),
        mutationRate: Number(config.ops.autoHiveRecombineMutationRate || 0),
        clusterWindowSec: Number(config.ops.autoHiveRecombineClusterWindowSec || 0),
        clusterMaxInWindow: Number(config.ops.autoHiveRecombineClusterMaxInWindow || 0),
        dailyCount: countRecentHiveRecombine(now() - 86400),
        lastRunAt: Number(opsAlertState.lastHiveRecombineRunAt || 0),
        running: Boolean(opsAlertState.hiveRecombineRunning)
      }
    },
    security: {
      ...securitySummary(),
      signaturePolicy: signaturePolicyStatus()
    }
  });
});

app.post('/api/security/risk-token', (req, res) => {
  const action = String(req.body?.action || '').trim();
  if (!action) return badRequest(res, new Error('ACTION_REQUIRED'));
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;
  const payloadHash = req.body?.payloadHash ? String(req.body.payloadHash) : null;
  const token = createRiskToken({ action, requestId, payloadHash });
  res.json({ ok: true, ...token });
});

app.get('/api/proofs/search', (req, res) => {
  const rows = searchProofEvents({
    txHash: req.query.txHash ? String(req.query.txHash) : null,
    requestId: req.query.requestId ? String(req.query.requestId) : null,
    battleId: req.query.battleId ? String(req.query.battleId) : null,
    memoryId: req.query.memoryId ? String(req.query.memoryId) : null,
    eventName: req.query.eventName ? String(req.query.eventName) : null,
    fromTs: req.query.fromTs ? Number(req.query.fromTs) : null,
    toTs: req.query.toTs ? Number(req.query.toTs) : null,
    limit: req.query.limit ? Number(req.query.limit) : 50
  });
  res.json({ ok: true, count: rows.length, results: rows });
});

app.get('/api/proofs/:txHash/decode', (req, res) => {
  const row = decodeProofByTxHash(req.params.txHash);
  if (!row) return badRequest(res, new Error('PROOF_NOT_FOUND'), 404);
  res.json({ ok: true, proof: row });
});

app.post('/api/proofs/export', (req, res) => {
  const fromTs = req.body?.fromTs ? Number(req.body.fromTs) : null;
  const toTs = req.body?.toTs ? Number(req.body.toTs) : null;
  const out = exportProofAuditPackage({ fromTs, toTs });
  res.json({ ok: true, ...out });
});

app.post('/api/memories/generate', async (req, res) => {
  const parsed = memoryGenerateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  try {
    const out = await generateProceduralMemoryDraft(parsed.data);
    addActivity({
      agentId: parsed.data.agentId,
      action: 'MEMORY_DRAFT_GENERATED',
      message: `memory draft generated (${out.draftId})`,
      meta: {
        draftId: out.draftId,
        relativePath: out.relativePath,
        memoryId: out?.draft?.memory?.memoryId || null,
        memoryType: out?.draft?.procedural?.memory_type || 'procedural',
        importance: Number(out?.draft?.procedural?.importance || 0)
      }
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    badRequest(res, err);
  }
});

app.get('/api/memories/drafts', async (req, res) => {
  const agentId = String(req.query.agentId || '').trim();
  if (!agentId) return badRequest(res, new Error('AGENT_ID_REQUIRED'));

  try {
    const stage = String(req.query.stage || 'inbox');
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const drafts = await listProceduralDrafts({ agentId, stage, limit });
    res.json({ ok: true, agentId, stage, count: drafts.length, drafts });
  } catch (err) {
    badRequest(res, err);
  }
});

app.get('/api/memories/drafts/:agentId/:draftId', async (req, res) => {
  try {
    const stage = String(req.query.stage || 'inbox');
    const out = await loadProceduralDraft({
      agentId: String(req.params.agentId || ''),
      draftId: String(req.params.draftId || ''),
      stage
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    badRequest(res, err, 404);
  }
});

app.post('/api/memories/commit', async (req, res) => {
  const parsed = memoryCommitSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const { auth, memory } = parsed.data;
  const payload = { memory };

  return withProtectedAction('COMMIT_MEMORY', payload, auth, req, res, async (input) => {
    const embeddingText = [
      input.memory.domain,
      input.memory.timeframe,
      input.memory.riskProfile,
      input.memory.benchmarkVersion,
      input.memory.featureVersion,
      ...(input.memory.symbolSet || []),
      input.memory.contentText || '',
      input.memory.note || ''
    ].join(' ');

    const similarRows = searchSimilarMemories({
      query: embeddingText,
      domain: input.memory.domain,
      limit: 5,
      excludeMemoryId: input.memory.memoryId
    });

    const classified = await classifyMemory({ memory: input.memory, similarRows });
    const normalizedMemory = {
      ...input.memory,
      ...classified
    };

    const { ttlUntil } = commitMemory(normalizedMemory, auth.agentId);

    await upsertMemoryVector({
      memoryId: normalizedMemory.memoryId,
      domain: normalizedMemory.domain,
      sourceAgent: auth.agentId,
      benchmarkVersion: normalizedMemory.benchmarkVersion,
      timeframe: normalizedMemory.timeframe,
      riskProfile: normalizedMemory.riskProfile,
      embeddingText
    });

    const strategyBody = String(normalizedMemory.contentText || '').trim();
    const strategyNote = String(normalizedMemory.note || '').trim();

    const eventPayload = {
      memoryId: normalizedMemory.memoryId,
      memoryHash: normalizedMemory.contentHash,
      encryptedUriHash: normalizedMemory.encryptedUriHash || null,
      memoryType: normalizedMemory.memoryType,
      memorySubType: normalizedMemory.memorySubType,
      classifierConfidence: normalizedMemory.classifierConfidence,
      agent: auth.agentId,
      tags: normalizedMemory.tags || [normalizedMemory.domain, normalizedMemory.timeframe],
      attributes: normalizedMemory.attributes || [],
      cid: normalizedMemory.cid || null,
      timestamp: now(),
      strategyBodyHash: hashOptionalText(strategyBody),
      strategyNoteHash: hashOptionalText(strategyNote)
    };

    const proof = await emitEventProof('MemoryRecorded', eventPayload);
    recordProof('MemoryRecorded', eventPayload, proof, { requestId: auth.requestId });

    addActivity({
      agentId: auth.agentId,
      action: 'MEMORY_COMMIT',
      message: `Memory ${normalizedMemory.memoryId} committed on-chain`,
      hash: proof.eventTxHash,
      hashType: 'tx',
      meta: {
        memoryId: normalizedMemory.memoryId,
        contentHash: normalizedMemory.contentHash,
        encryptedUriHash: normalizedMemory.encryptedUriHash || null,
        memoryType: normalizedMemory.memoryType,
        memorySubType: normalizedMemory.memorySubType,
        classifierConfidence: normalizedMemory.classifierConfidence,
        strategyAutoTagged: Boolean(normalizedMemory.strategyAutoTagged),
        strategySimilarity: Number(normalizedMemory.strategySimilarity || 0),
        strategyBodyBytes: Buffer.byteLength(strategyBody || '', 'utf8'),
        strategyNoteBytes: Buffer.byteLength(strategyNote || '', 'utf8'),
        strategyBodyHash: hashOptionalText(strategyBody),
        strategyNoteHash: hashOptionalText(strategyNote),
        ttlUntil,
        ...txMeta({
          source: proof.source,
          live: proof.eventTxLive,
          mode: proof.eventMode,
          explorer: explorerOf(proof.eventTxHash, proof.eventTxLive),
          error: proof?.raw?.error || null
        })
      }
    });

    return {
      memoryId: normalizedMemory.memoryId,
      ttlUntil,
      memoryType: normalizedMemory.memoryType,
      memorySubType: normalizedMemory.memorySubType,
      classifierConfidence: normalizedMemory.classifierConfidence,
      strategyAutoTagged: Boolean(normalizedMemory.strategyAutoTagged),
      strategySimilarity: Number(normalizedMemory.strategySimilarity || 0),
      encryptedUriHash: normalizedMemory.encryptedUriHash || null,
      strategyBodyHash: hashOptionalText(strategyBody),
      strategyNoteHash: hashOptionalText(strategyNote),
      strategyBodyBytes: Buffer.byteLength(strategyBody || '', 'utf8'),
      strategyNoteBytes: Buffer.byteLength(strategyNote || '', 'utf8'),
      attributes: normalizedMemory.attributes || [],
      eventTxHash: proof.eventTxHash,
      eventSource: proof.source,
      eventTxLive: Boolean(proof.eventTxLive),
      eventMode: proof.eventMode || null,
      eventTarget: proof.eventTarget || null
    };
  });
});

app.post('/api/memories/transfer', (req, res) => {
  const parsed = memoryTransferSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const { auth, memoryId, toAgentId, note } = parsed.data;
  const payload = { memoryId, toAgentId, note: note || null };

  return withProtectedAction('TRANSFER_MEMORY', payload, auth, req, res, async (input) => {
    assertSameNamespace(auth.agentId, input.toAgentId);

    const memory = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(input.memoryId);
    if (!memory) throw new Error('MEMORY_NOT_FOUND');
    if (memory.source_agent !== auth.agentId) throw new Error('MEMORY_OWNER_MISMATCH');
    if (input.toAgentId === auth.agentId) throw new Error('TRANSFER_TARGET_SAME_AS_SOURCE');

    db.prepare('UPDATE memories SET source_agent = ?, updated_at = ? WHERE memory_id = ?').run(
      input.toAgentId,
      now(),
      input.memoryId
    );
    db.prepare('UPDATE memory_vectors SET source_agent = ?, updated_at = ? WHERE memory_id = ?').run(
      input.toAgentId,
      now(),
      input.memoryId
    );

    const eventPayload = {
      memoryId: input.memoryId,
      memoryHash: memory.content_hash,
      from: auth.agentId,
      to: input.toAgentId,
      operator: auth.agentId,
      note: input.note || null,
      timestamp: now(),
      strategyBodyHash: hashOptionalText(memory.strategy_body),
      strategyNoteHash: hashOptionalText(memory.strategy_note)
    };

    const proof = await emitEventProof('MemoryTransferred', eventPayload);
    recordProof('MemoryTransferred', eventPayload, proof, { requestId: auth.requestId });

    db.prepare(
      `INSERT INTO memory_transfers (request_id, memory_id, from_agent, to_agent, note, transferred_at, event_tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(auth.requestId, input.memoryId, auth.agentId, input.toAgentId, input.note || null, now(), proof.eventTxHash);

    addActivity({
      agentId: auth.agentId,
      action: 'MEMORY_TRANSFER',
      message: `Memory ${input.memoryId} transferred to ${input.toAgentId}`,
      hash: proof.eventTxHash,
      hashType: 'tx',
      meta: {
        memoryId: input.memoryId,
        from: auth.agentId,
        to: input.toAgentId,
        note: input.note || null,
        ...strategyTransferMeta(memory),
        ...txMeta({
          source: proof.source,
          live: proof.eventTxLive,
          mode: proof.eventMode,
          explorer: explorerOf(proof.eventTxHash, proof.eventTxLive),
          error: proof?.raw?.error || null
        })
      }
    });

    return {
      memoryId: input.memoryId,
      fromAgent: auth.agentId,
      toAgent: input.toAgentId,
      ...strategyTransferMeta(memory),
      eventTxHash: proof.eventTxHash,
      eventSource: proof.source || null,
      eventTxLive: Boolean(proof.eventTxLive),
      eventMode: proof.eventMode || null,
      eventTarget: proof.eventTarget || null
    };
  });
});

app.post('/api/memories/delete', (req, res) => {
  const parsed = memoryDeleteSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const { auth, memoryId } = parsed.data;
  const payload = { memoryId };

  return withProtectedAction('DELETE_MEMORY', payload, auth, req, res, (input) => {
    const memory = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(input.memoryId);
    if (!memory) throw new Error('MEMORY_NOT_FOUND');
    if (memory.source_agent !== auth.agentId) throw new Error('MEMORY_OWNER_MISMATCH');

    const activeBattle = db
      .prepare(
        `SELECT battle_id AS battleId, status
         FROM battles
         WHERE status IN ('challenged', 'accepted')
           AND (memory_a = ? OR memory_b = ?)
         ORDER BY scheduled_at DESC
         LIMIT 1`
      )
      .get(input.memoryId, input.memoryId);

    if (activeBattle) {
      throw new Error(`MEMORY_IN_ACTIVE_BATTLE:${activeBattle.battleId}:${activeBattle.status}`);
    }

    const ts = now();
    db.prepare(`UPDATE memories SET state = 'retired', ttl_until = ?, updated_at = ? WHERE memory_id = ?`).run(ts - 1, ts, input.memoryId);

    addActivity({
      agentId: auth.agentId,
      action: 'MEMORY_DELETE',
      message: `Memory ${input.memoryId} retired by owner`,
      meta: {
        memoryId: input.memoryId,
        previousState: memory.state,
        ...strategyTransferMeta(memory),
        source: 'local',
        live: false
      }
    });

    return {
      memoryId: input.memoryId,
      status: 'retired',
      previousState: memory.state
    };
  });
});

app.post('/api/memories/delete', (req, res) => {
  const parsed = memoryDeleteSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const { auth, memoryId } = parsed.data;
  const payload = { memoryId };

  return withProtectedAction('DELETE_MEMORY', payload, auth, req, res, (input) => {
    const memory = db
      .prepare('SELECT memory_id AS memoryId, source_agent AS sourceAgent, state FROM memories WHERE memory_id = ?')
      .get(input.memoryId);
    if (!memory) throw new Error('MEMORY_NOT_FOUND');
    if (memory.sourceAgent !== auth.agentId) throw new Error('MEMORY_OWNER_MISMATCH');

    const activeBattle = db
      .prepare(
        `SELECT battle_id AS battleId, status
         FROM battles
         WHERE status IN ('challenged', 'accepted')
           AND (memory_a = ? OR memory_b = ?)
         ORDER BY scheduled_at DESC
         LIMIT 1`
      )
      .get(input.memoryId, input.memoryId);
    if (activeBattle) {
      throw new Error(`MEMORY_IN_ACTIVE_BATTLE:${activeBattle.battleId}:${activeBattle.status}`);
    }

    const alreadyRetired = String(memory.state || '').toLowerCase() === 'retired';
    if (!alreadyRetired) {
      db.prepare(`UPDATE memories SET state = 'retired', updated_at = ? WHERE memory_id = ?`).run(now(), input.memoryId);
      db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(input.memoryId);

      addActivity({
        agentId: auth.agentId,
        action: 'MEMORY_DELETE',
        message: `Memory ${input.memoryId} retired manually`,
        meta: {
          memoryId: input.memoryId,
          state: 'retired',
          source: 'manual'
        }
      });
    }

    return {
      memoryId: input.memoryId,
      status: 'retired',
      alreadyRetired
    };
  });
});

app.post('/api/battles/challenge', (req, res) => {
  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const { auth, challengerMemoryId, opponentAgentId, matchMode, rounds, benchmarkVersion, timeframe, symbolSet } = parsed.data;
  const payload = {
    challengerMemoryId,
    rounds,
    benchmarkVersion,
    timeframe,
    symbolSet,
    ...(opponentAgentId ? { opponentAgentId } : {}),
    ...(typeof matchMode === 'string' && matchMode.trim() ? { matchMode: normalizeBattleMode(matchMode) } : {})
  };

  return withProtectedAction('CHALLENGE_BATTLE', payload, auth, req, res, (input) => {
    const targetOpponent = String(input.opponentAgentId || '').trim();
    const openPool = !targetOpponent;
    const matchMode = normalizeBattleMode(input.matchMode);

    if (!openPool) {
      assertSameNamespace(auth.agentId, targetOpponent);
      if (targetOpponent === auth.agentId) throw new Error('SELF_CHALLENGE_FORBIDDEN');
    }

    const challengerMemory = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(input.challengerMemoryId);
    if (!challengerMemory) throw new Error('CHALLENGER_MEMORY_NOT_FOUND');
    if (challengerMemory.source_agent !== auth.agentId) throw new Error('MEMORY_OWNER_MISMATCH');

    const limiter = enforceRateLimit(auth.agentId, openPool ? null : targetOpponent, {
      skipOpponentLimits: matchMode === 'sparring'
    });
    if (!limiter.ok) throw new Error(limiter.reason);

    const opponentStored = openPool ? OPEN_BATTLE_POOL_OPPONENT : targetOpponent;

    const battleId = ulid();
    const seed = crypto
      .createHash('sha256')
      .update(`${config.arenaId}:${battleId}:${auth.agentId}:${opponentStored}`)
      .digest('hex');

    db.prepare(`
      INSERT INTO battles (
        battle_id, challenger_agent, opponent_agent, memory_a, domain,
        benchmark_version, seed, rounds, match_mode, status, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'challenged', ?)
    `).run(
      battleId,
      auth.agentId,
      opponentStored,
      input.challengerMemoryId,
      challengerMemory.domain,
      input.benchmarkVersion,
      seed,
      input.rounds,
      matchMode,
      now()
    );

    addActivity({
      agentId: auth.agentId,
      action: 'BATTLE_CHALLENGE',
      message: openPool ? `Battle ${battleId} challenged (open pool)` : `Battle ${battleId} challenged ${targetOpponent}`,
      meta: {
        battleId,
        challengerMemoryId: input.challengerMemoryId,
        opponentAgentId: openPool ? null : targetOpponent,
        openPool,
        matchMode,
        ...txMeta({ source: 'local', live: false })
      }
    });
    markBattleMetric('challenged');

    return {
      battleId,
      status: 'challenged',
      matchMode,
      seed,
      config: {
        challengeWindowSec: config.battleTiming.challengeWindowSec,
        acceptLockSec: config.battleTiming.acceptLockSec,
        executionSec: config.battleTiming.executionSec,
        settlementSec: config.battleTiming.settlementSec,
        disputeSec: config.battleTiming.disputeSec,
        cooldownSec: config.battleTiming.cooldownSec,
        matchMode,
        benchmarkVersion: input.benchmarkVersion,
        timeframe: input.timeframe,
        symbolSet: input.symbolSet
      }
    };
  });
});

app.post('/api/battles/:battleId/accept', (req, res) => {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const battleId = req.params.battleId;
  const { auth, opponentMemoryId } = parsed.data;
  const payload = { battleId, opponentMemoryId };

  return withProtectedAction('ACCEPT_BATTLE', payload, auth, req, res, (input) => {
    const battle = db.prepare('SELECT * FROM battles WHERE battle_id = ?').get(input.battleId);
    if (!battle) throw new Error('BATTLE_NOT_FOUND');
    if (battle.status !== 'challenged') throw new Error('BATTLE_STATUS_INVALID');

    const openPool = isOpenBattleOpponent(battle.opponent_agent);
    const matchMode = normalizeBattleMode(battle.match_mode);
    if (battle.challenger_agent === auth.agentId) throw new Error('SELF_ACCEPT_FORBIDDEN');
    if (!openPool && battle.opponent_agent !== auth.agentId) throw new Error('NOT_ASSIGNED_OPPONENT');

    assertSameNamespace(battle.challenger_agent, auth.agentId);

    const limiter = enforceRateLimit(battle.challenger_agent, auth.agentId, {
      skipOpponentLimits: matchMode === 'sparring',
      excludeBattleId: input.battleId
    });
    if (!limiter.ok) throw new Error(limiter.reason);

    const ts = now();
    if (ts > battle.scheduled_at + config.battleTiming.challengeWindowSec) {
      throw new Error('CHALLENGE_WINDOW_EXPIRED');
    }

    const memoryA = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(battle.memory_a);
    const memoryB = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(input.opponentMemoryId);
    if (!memoryB) throw new Error('OPPONENT_MEMORY_NOT_FOUND');
    if (memoryB.source_agent !== auth.agentId) throw new Error('MEMORY_OWNER_MISMATCH');

    const challenge = {
      domain: battle.domain,
      benchmarkVersion: battle.benchmark_version,
      timeframe: memoryA.timeframe,
      symbolSet: parseSymbolSet(memoryA.symbol_set)
    };
    const matched = canMatch(memoryA, memoryB, challenge);
    if (!matched.ok) throw new Error(matched.reason);
    const matchQuality = matched.quality || null;

    const update = db
      .prepare(
        `UPDATE battles
         SET opponent_agent = ?, memory_b = ?, accepted_at = ?, status = 'accepted'
         WHERE battle_id = ?
           AND status = 'challenged'
           AND (opponent_agent = ? OR opponent_agent = ?)`
      )
      .run(auth.agentId, input.opponentMemoryId, ts, input.battleId, auth.agentId, OPEN_BATTLE_POOL_OPPONENT);

    if (Number(update.changes || 0) !== 1) {
      throw new Error('BATTLE_ALREADY_ACCEPTED');
    }

    addActivity({
      agentId: auth.agentId,
      action: 'BATTLE_ACCEPT',
      message: `Battle ${input.battleId} accepted by ${auth.agentId}`,
      meta: {
        battleId: input.battleId,
        challengerAgentId: battle.challenger_agent,
        opponentMemoryId: input.opponentMemoryId,
        openPool,
        matchMode,
        matchQuality,
        matchWarnings: matched.warnings || [],
        ...txMeta({ source: 'local', live: false })
      }
    });
    markBattleMetric('accepted');

    return { battleId: input.battleId, status: 'accepted', matchMode, matchQuality, warnings: matched.warnings || [] };
  });
});

app.post('/api/battles/:battleId/run', (req, res) => {
  const parsed = runBattleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const battleId = req.params.battleId;
  const { auth, mode } = parsed.data;
  const payload = { battleId, mode };

  return withProtectedAction('RUN_BATTLE', payload, auth, req, res, async (input) => {
    const battle = db.prepare('SELECT * FROM battles WHERE battle_id = ?').get(input.battleId);
    if (!battle) throw new Error('BATTLE_NOT_FOUND');
    if (battle.status !== 'accepted') throw new Error('BATTLE_NOT_READY');

    assertSameNamespace(battle.challenger_agent, battle.opponent_agent);

    const ts = now();
    if (!battle.accepted_at) throw new Error('BATTLE_ACCEPT_TIME_MISSING');
    if (ts < battle.accepted_at + config.battleTiming.acceptLockSec) {
      throw new Error('ACCEPT_LOCK_ACTIVE');
    }

    const runWindowDeadline =
      battle.accepted_at + config.battleTiming.acceptLockSec + config.battleTiming.executionSec + config.battleTiming.settlementSec;
    if (ts > runWindowDeadline) {
      throw new Error('RUN_WINDOW_EXPIRED');
    }

    const memoryA = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(battle.memory_a);
    const memoryB = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(battle.memory_b);

    const symbols = parseSymbolSet(memoryA.symbol_set);
    const matchCheck = canMatch(memoryA, memoryB, {
      domain: battle.domain,
      benchmarkVersion: battle.benchmark_version,
      timeframe: memoryA.timeframe,
      symbolSet: symbols
    });
    if (!matchCheck.ok) throw new Error(matchCheck.reason || 'MATCH_INVALID_AT_SETTLEMENT');

    const matchQuality = matchCheck.quality || { tier: 'high', score: 1 };
    const fitnessWeight = matchQuality.tier === 'high' ? 1 : matchQuality.tier === 'medium' ? 0.5 : 0;

    const market = await getMarketProfile({
      rounds: battle.rounds,
      symbols
    });

    const { result, trace } = runPaperBattle({
      seed: battle.seed,
      rounds: battle.rounds,
      memoryA,
      memoryB,
      mode: input.mode,
      marketShocks: market.shocks,
      marketSource: market.source
    });

    const simScoreA = scoreToRaw(result.scoreA);
    const simScoreB = scoreToRaw(result.scoreB);

    const taskContext = {
      domain: battle.domain,
      timeframe: memoryA.timeframe,
      benchmarkVersion: battle.benchmark_version,
      symbolSet: symbols,
      activeTags: ['trading', battle.domain, memoryA.timeframe, `bench:${battle.benchmark_version}`]
    };

    const compositeA = scoreMemoryComposite({
      memory: memoryA,
      taskContext,
      simScore: simScoreA,
      nowTs: ts
    });
    const compositeB = scoreMemoryComposite({
      memory: memoryB,
      taskContext,
      simScore: simScoreB,
      nowTs: ts
    });

    const finalScoreA = config.scoring.useComposite ? compositeA.final : simScoreA;
    const finalScoreB = config.scoring.useComposite ? compositeB.final : simScoreB;

    result.simWinner = result.winner;
    result.simScoreA = simScoreA;
    result.simScoreB = simScoreB;
    result.compositeScoreA = compositeA.final;
    result.compositeScoreB = compositeB.final;
    result.compositeBreakdownA = compositeA;
    result.compositeBreakdownB = compositeB;
    result.scoreA = Number(finalScoreA.toFixed(6));
    result.scoreB = Number(finalScoreB.toFixed(6));
    result.winner = result.scoreA === result.scoreB ? 'draw' : result.scoreA > result.scoreB ? 'A' : 'B';
    result.matchQuality = matchQuality;
    result.matchWarnings = matchCheck.warnings || [];
    result.fitnessWeight = fitnessWeight;

    const resultHash = hashJSON(result);

    const insertMetric = db.prepare(`
      INSERT INTO battle_metrics (battle_id, round_no, pnl_a, pnl_b, risk_a, risk_b, latency_a, latency_b, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of trace) {
      insertMetric.run(
        input.battleId,
        r.roundNo,
        r.pnlA,
        r.pnlB,
        r.riskA,
        r.riskB,
        r.latencyA,
        r.latencyB,
        now()
      );
    }

    const scoreRawA = scoreToRaw(result.scoreA);
    const scoreRawB = scoreToRaw(result.scoreB);

    const decayA = applyAntiSybilDecay(scoreRawA, {
      battleId: input.battleId,
      memoryA: memoryA.memory_id,
      memoryB: memoryB.memory_id,
      agentA: battle.challenger_agent,
      agentB: battle.opponent_agent,
      nowTs: ts
    });

    const decayB = applyAntiSybilDecay(scoreRawB, {
      battleId: input.battleId,
      memoryA: memoryA.memory_id,
      memoryB: memoryB.memory_id,
      agentA: battle.challenger_agent,
      agentB: battle.opponent_agent,
      nowTs: ts
    });

    const applyFitnessWeighted = (memoryId, adjustedRaw) => {
      if (fitnessWeight >= 0.999) return updateFitness(memoryId, adjustedRaw);
      const row = db.prepare('SELECT fitness FROM memories WHERE memory_id = ?').get(memoryId);
      if (!row) throw new Error('MEMORY_NOT_FOUND');
      const prev = Number(row.fitness ?? 0.5);
      const weightedRaw = Number((prev + (Number(adjustedRaw) - prev) * fitnessWeight).toFixed(6));
      return updateFitness(memoryId, weightedRaw);
    };

    const fitA = applyFitnessWeighted(memoryA.memory_id, decayA.adjusted);
    const fitB = applyFitnessWeighted(memoryB.memory_id, decayB.adjusted);

    db.prepare(
      `UPDATE battles
       SET status = 'settled', settled_at = ?, result_json = ?, trace_hash = ?, result_hash = ?
       WHERE battle_id = ?`
    ).run(ts, JSON.stringify(result), result.traceHash, resultHash, input.battleId);

    const winnerAgentId =
      result.winner === 'A' ? battle.challenger_agent : result.winner === 'B' ? battle.opponent_agent : null;

    const eventPayload = {
      battleId: input.battleId,
      winner: result.winner,
      winnerAgentId,
      scoreA: result.scoreA,
      scoreB: result.scoreB,
      simScoreA: result.simScoreA,
      simScoreB: result.simScoreB,
      resultHash
    };

    const proof = await emitEventProof('BattleResult', eventPayload);
    recordProof('BattleResult', eventPayload, proof, { requestId: auth.requestId, battleId: input.battleId });

    let autoEvolution = { enabled: config.ops.autoEvolveEnabled, executed: false, reason: 'SKIPPED' };
    try {
      autoEvolution = await autoEvolveAfterBattle({ battle, memoryA, memoryB, result });
    } catch (err) {
      autoEvolution = {
        enabled: config.ops.autoEvolveEnabled,
        executed: false,
        reason: 'ERROR',
        error: String(err?.message || err)
      };
      addActivity({
        agentId: auth.agentId,
        action: 'AUTO_EVOLVE_ERROR',
        message: `Battle ${input.battleId} auto-evolve failed`,
        meta: {
          battleId: input.battleId,
          winner: result.winner,
          error: String(err?.message || err)
        }
      });
    }

    addActivity({
      agentId: auth.agentId,
      action: 'BATTLE_SETTLE',
      message: `Battle ${input.battleId} settled, winner=${result.winner}`,
      hash: proof.eventTxHash,
      hashType: 'tx',
      meta: {
        battleId: input.battleId,
        winner: result.winner,
        scoreA: result.scoreA,
        scoreB: result.scoreB,
        simScoreA: result.simScoreA,
        simScoreB: result.simScoreB,
        compositeScoreA: result.compositeScoreA,
        compositeScoreB: result.compositeScoreB,
        qualityA: result?.compositeBreakdownA?.dimensions?.quality ?? null,
        relevanceA: result?.compositeBreakdownA?.dimensions?.relevance ?? null,
        impactA: result?.compositeBreakdownA?.dimensions?.potentialImpact ?? null,
        noveltyA: result?.compositeBreakdownA?.dimensions?.novelty ?? null,
        freshnessA: result?.compositeBreakdownA?.dimensions?.freshness ?? null,
        qualityB: result?.compositeBreakdownB?.dimensions?.quality ?? null,
        relevanceB: result?.compositeBreakdownB?.dimensions?.relevance ?? null,
        impactB: result?.compositeBreakdownB?.dimensions?.potentialImpact ?? null,
        noveltyB: result?.compositeBreakdownB?.dimensions?.novelty ?? null,
        freshnessB: result?.compositeBreakdownB?.dimensions?.freshness ?? null,
        marketSource: market.source,
        matchQuality,
        matchWarnings: matchCheck.warnings || [],
        fitnessWeight,
        autoEvolution,
        ...txMeta({
          source: proof.source,
          live: proof.eventTxLive,
          mode: proof.eventMode,
          explorer: explorerOf(proof.eventTxHash, proof.eventTxLive),
          error: proof?.raw?.error || null
        })
      }
    });
    markBattleMetric('settled');

    return {
      battleId: input.battleId,
      status: 'settled',
      winner: result.winner,
      result,
      market,
      fitness: {
        [memoryA.memory_id]: fitA,
        [memoryB.memory_id]: fitB
      },
      antiSybilDecay: {
        [memoryA.memory_id]: decayA,
        [memoryB.memory_id]: decayB
      },
      matchQuality,
      matchWarnings: matchCheck.warnings || [],
      fitnessWeight,
      autoEvolution,
      eventTxHash: proof.eventTxHash,
      eventSource: proof.source || null,
      eventTxLive: Boolean(proof.eventTxLive),
      eventMode: proof.eventMode || null,
      eventTarget: proof.eventTarget || null
    };
  });
});

app.get('/api/hive/memories', (req, res) => {
  const hiveAgentId = String(req.query.hiveAgentId || config.ops.autoEvolveBackupAgentId || 'hive/backup').trim() || 'hive/backup';
  const domain = typeof req.query.domain === 'string' ? String(req.query.domain).trim() : '';
  const query = String(req.query.q || '').trim().toLowerCase();
  const limit = clampListLimit(req.query.limit, 50, 200);

  const rows = db
    .prepare(
      `SELECT *
       FROM memories
       WHERE source_agent = ?
         AND state = 'active'
         AND (? = '' OR domain = ?)
         AND (
           ? = ''
           OR lower(memory_id) LIKE '%' || ? || '%'
           OR lower(symbol_set) LIKE '%' || ? || '%'
           OR lower(benchmark_version) LIKE '%' || ? || '%'
           OR lower(feature_version) LIKE '%' || ? || '%'
           OR lower(content_hash) LIKE '%' || ? || '%'
         )
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(hiveAgentId, domain, domain, query, query, query, query, query, query, limit);

  const memories = rows.map((row) => {
    const stats = hiveMemoryStats(row.memory_id);
    return {
      ...memoryRowSummary(row, { includeStrategy: false }),
      heat: stats.heat,
      ratingCount: stats.ratingCount,
      avgScore: stats.avgScore,
      weightedScore: stats.weightedScore
    };
  });

  addActivity({
    agentId: typeof req.query.agentId === 'string' ? req.query.agentId : null,
    action: 'HIVE_LIBRARY_ACCESS',
    message: `Hive memory library accessed (agent=${hiveAgentId}, count=${memories.length})`,
    meta: {
      hiveAgentId,
      domain: domain || null,
      query: query || null,
      count: memories.length,
      ...txMeta({ source: 'local', live: false })
    }
  });

  res.json({ ok: true, hiveAgentId, domain: domain || null, query: query || null, count: memories.length, memories });
});

app.post('/api/hive/memories/:memoryId/clone', async (req, res) => {
  const parsed = hiveMemoryCloneSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const memoryId = String(req.params.memoryId || '').trim();
  if (!memoryId) return badRequest(res, new Error('MEMORY_ID_REQUIRED'));

  const { auth, note } = parsed.data;
  const payload = {
    memoryId,
    ...(note !== undefined ? { note } : {})
  };
  const requestIsTestOnly = isTestRequestId(auth.requestId);

  return withProtectedAction('CLONE_HIVE_MEMORY', payload, auth, req, res, async (input) => {
    markPaymentMetric('premiumCalls');
    enforceDailyBudgetOrThrow('clone');

    const hiveAgentId = String(config.ops.autoEvolveBackupAgentId || 'hive/backup').trim() || 'hive/backup';
    const sourceMemory = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(input.memoryId);
    if (!sourceMemory) throw new Error('MEMORY_NOT_FOUND');
    if (String(sourceMemory.source_agent || '') !== hiveAgentId) throw new Error('MEMORY_NOT_IN_HIVE_LIBRARY');
    if (String(sourceMemory.state || 'active') !== 'active') throw new Error('MEMORY_NOT_ACTIVE');

    const burnSenderReadiness = await checkBurnSenderReadiness();
    if (!burnSenderReadiness.ok) {
      throw new Error(
        `BURN_SENDER_NOT_READY:from=${burnSenderReadiness.burnFrom}:gas=${burnSenderReadiness.gasBalance}:min=${burnSenderReadiness.minGas}`
      );
    }

    await ensureX402SenderSelected();

    return verifyX402Payment({ requestId: auth.requestId, amountUsdc: config.premiumBuffFeeUsdc }).then((payment) => {
      if (!payment.ok) throw new Error('PAYMENT_NOT_VERIFIED');
      markPaymentMetric('verified');

      return burnAntiSybilFee({
        requestId: auth.requestId,
        payerAgent: auth.agentId,
        amountUsdc: config.premiumBuffFeeUsdc
      }).then(async (burnResult) => {
        if (!burnResult.ok) throw new Error('BURN_FAILED');
        markPaymentMetric('burned');
        if (burnResult.topupTxHash) markPaymentMetric('topup');
        if (burnResult.topupLatencyMs != null) markPaymentLatency('topupLatencyMs', burnResult.topupLatencyMs);
        if (burnResult.burnLatencyMs != null) markPaymentLatency('burnLatencyMs', burnResult.burnLatencyMs);

        db.prepare(
          `INSERT INTO burn_records (request_id, payer_agent, amount_usdc, burn_address, burn_from, burn_tx_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          auth.requestId,
          auth.agentId,
          config.premiumBuffFeeUsdc,
          burnResult.burnAddress,
          burnResult.burnFrom || null,
          burnResult.burnTxHash,
          now()
        );

        const ts = now();
        const clonedMemoryId = nextDerivedMemoryId('mem_hive');

        const { ttlUntil } = cloneMemoryForAgent({
          sourceMemory,
          targetMemoryId: clonedMemoryId,
          targetAgentId: auth.agentId,
          ts,
          extraAttributes: [
            { trait_type: 'hiveSourceMemoryId', value: sourceMemory.memory_id },
            { trait_type: 'hiveCloneAt', value: String(ts) }
          ]
        });

        await cloneMemoryVectorForAgent({
          sourceMemory,
          targetMemoryId: clonedMemoryId,
          targetAgentId: auth.agentId,
          ts
        });

        const eventPayload = {
          requestId: auth.requestId,
          sourceMemoryId: sourceMemory.memory_id,
          clonedMemoryId,
          from: hiveAgentId,
          to: auth.agentId,
          amountUsdc: config.premiumBuffFeeUsdc,
          burnAddress: burnResult.burnAddress,
          burnTxHash: burnResult.burnTxHash,
          paymentTxHash: payment.paymentTxHash,
          paymentProofHash: payment.paymentProofHash || null,
          paymentHashType: payment.paymentHashType || null,
          note: input.note || null,
          timestamp: ts,
          strategyBodyHash: hashOptionalText(sourceMemory.strategy_body),
          strategyNoteHash: hashOptionalText(sourceMemory.strategy_note)
        };

        const proof = await emitEventProof('HiveMemoryCloned', eventPayload);
        recordProof('HiveMemoryCloned', eventPayload, proof, {
          requestId: auth.requestId,
          memoryId: clonedMemoryId
        });

        db.prepare(
          `INSERT INTO hive_memory_clones (
             request_id, source_memory_id, cloned_memory_id, hive_agent_id, target_agent_id,
             payment_tx_hash, burn_tx_hash, event_tx_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          auth.requestId,
          sourceMemory.memory_id,
          clonedMemoryId,
          hiveAgentId,
          auth.agentId,
          payment.paymentTxHash || null,
          burnResult.burnTxHash || null,
          proof.eventTxHash || null,
          ts
        );

        const budget = bumpDailyBudgetUsage({
          cloneCalls: 1,
          cloneUsdc: Number(config.premiumBuffFeeUsdc || 0),
          chainCalls: 3
        });

        addActivity({
          agentId: auth.agentId,
          action: 'HIVE_ACCESS_PREMIUM',
          message: `Hive memory cloned from ${sourceMemory.memory_id} to ${clonedMemoryId}`,
          hash: proof.eventTxHash,
          hashType: 'tx',
          meta: {
            requestId: auth.requestId,
            sourceMemoryId: sourceMemory.memory_id,
            clonedMemoryId,
            hiveAgentId,
            note: input.note || null,
            budget,
            paymentTxHash: payment.paymentTxHash,
            paymentProofHash: payment.paymentProofHash || null,
            paymentHashType: payment.paymentHashType || null,
            burnTxHash: burnResult.burnTxHash,
            burnTopupTxHash: burnResult.topupTxHash || null,
            burnTopupLatencyMs: burnResult.topupLatencyMs || null,
            burnLatencyMs: burnResult.burnLatencyMs || null,
            burnFrom: burnResult.burnFrom || null,
            paymentSource: payment.source || null,
            paymentTxLive: Boolean(payment.paymentTxLive),
            burnSource: burnResult.source || null,
            burnTxLive: Boolean(burnResult.burnTxLive),
            testOnly: requestIsTestOnly,
            sampleClass: requestIsTestOnly ? 'test' : 'prod',
            ...strategyTransferMeta(sourceMemory),
            ...txMeta({
              source: proof.source,
              live: proof.eventTxLive,
              mode: proof.eventMode,
              explorer: explorerOf(proof.eventTxHash, proof.eventTxLive),
              error: proof?.raw?.error || null
            })
          }
        });

        const stats = hiveMemoryStats(sourceMemory.memory_id);

        return {
          sourceMemoryId: sourceMemory.memory_id,
          clonedMemoryId,
          ttlUntil,
          paymentTxHash: payment.paymentTxHash,
          paymentProofHash: payment.paymentProofHash || null,
          paymentHashType: payment.paymentHashType || null,
          paymentSource: payment.source || null,
          paymentTxLive: Boolean(payment.paymentTxLive),
          burnTxHash: burnResult.burnTxHash,
          burnTopupTxHash: burnResult.topupTxHash || null,
          burnTopupLatencyMs: burnResult.topupLatencyMs || null,
          burnLatencyMs: burnResult.burnLatencyMs || null,
          burnFrom: burnResult.burnFrom || null,
          burnSource: burnResult.source || null,
          burnTxLive: Boolean(burnResult.burnTxLive),
          burnAddress: burnResult.burnAddress,
          eventTxHash: proof.eventTxHash,
          eventSource: proof.source || null,
          eventTxLive: Boolean(proof.eventTxLive),
          eventMode: proof.eventMode || null,
          eventTarget: proof.eventTarget || null,
          testOnly: requestIsTestOnly,
          sampleClass: requestIsTestOnly ? 'test' : 'prod',
          budget,
          heat: stats.heat,
          ratingCount: stats.ratingCount,
          avgScore: stats.avgScore,
          weightedScore: stats.weightedScore,
          ...strategyTransferMeta(sourceMemory)
        };
      }).catch(async (err) => {
        markPaymentMetric('burnFailures');
        const parsedFailure = parseBurnAfterTopupFailure(String(err?.message || err));
        if (parsedFailure?.topupTxHash) {
          markPaymentMetric('burnAfterTopupFailures');
          await emitOpsAlert({
            key: 'hive-clone-burn-incomplete',
            action: 'OPS_PREMIUM_BURN_INCOMPLETE',
            severity: 'critical',
            message: `hive clone burn incomplete for request=${auth.requestId}`,
            meta: {
              requestId: auth.requestId,
              topupTxHash: parsedFailure.topupTxHash,
              detail: parsedFailure.detail,
              burnFrom: resolveBurnSenderAddress() || null
            }
          });
        }
        throw err;
      });
    });
  });
});

app.post('/api/hive/memories/:memoryId/rate', async (req, res) => {
  const parsed = hiveMemoryRateSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const sourceMemoryId = String(req.params.memoryId || '').trim();
  if (!sourceMemoryId) return badRequest(res, new Error('MEMORY_ID_REQUIRED'));

  const { auth, score, note } = parsed.data;
  const payload = {
    memoryId: sourceMemoryId,
    score: Number(score),
    ...(note !== undefined ? { note } : {})
  };

  return withProtectedAction('RATE_HIVE_MEMORY', payload, auth, req, res, async (input) => {
    const hiveAgentId = String(config.ops.autoEvolveBackupAgentId || 'hive/backup').trim() || 'hive/backup';
    const sourceMemory = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(sourceMemoryId);
    if (!sourceMemory) throw new Error('MEMORY_NOT_FOUND');
    if (String(sourceMemory.source_agent || '') !== hiveAgentId) throw new Error('MEMORY_NOT_IN_HIVE_LIBRARY');

    const eligible = hasCloneEligibility(sourceMemoryId, auth.agentId);
    if (!eligible) throw new Error('AGENT_NOT_ELIGIBLE_TO_RATE');

    const ts = now();
    db.prepare(
      `INSERT INTO hive_memory_ratings (source_memory_id, agent_id, score, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_memory_id, agent_id)
       DO UPDATE SET
         score = excluded.score,
         note = excluded.note,
         updated_at = excluded.updated_at`
    ).run(sourceMemoryId, auth.agentId, Number(input.score), input.note || null, ts, ts);

    const stats = hiveMemoryStats(sourceMemoryId);

    addActivity({
      agentId: auth.agentId,
      action: 'HIVE_MEMORY_RATED',
      message: `Hive memory rated ${sourceMemoryId} score=${Number(input.score).toFixed(2)}`,
      meta: {
        memoryId: sourceMemoryId,
        score: Number(input.score),
        note: input.note || null,
        heat: stats.heat,
        ratingCount: stats.ratingCount,
        avgScore: stats.avgScore,
        weightedScore: stats.weightedScore,
        ...txMeta({ source: 'local', live: false })
      }
    });

    return {
      memoryId: sourceMemoryId,
      score: Number(input.score),
      note: input.note || null,
      heat: stats.heat,
      ratingCount: stats.ratingCount,
      avgScore: stats.avgScore,
      weightedScore: stats.weightedScore
    };
  });
});

app.get('/api/hive/memories/leaderboards', (req, res) => {
  const hiveAgentId = String(req.query.hiveAgentId || config.ops.autoEvolveBackupAgentId || 'hive/backup').trim() || 'hive/backup';
  const limit = clampListLimit(req.query.limit, 20, 200);
  const minRatingCount = Math.max(1, Math.floor(Number(req.query.minRatingCount) || 1));

  const heat = hiveLeaderboardRows({ type: 'heat', limit, hiveAgentId });
  const rating = hiveLeaderboardRows({ type: 'rating', limit, minRatingCount, hiveAgentId });

  res.json({
    ok: true,
    hiveAgentId,
    limit,
    minRatingCount,
    heat,
    rating
  });
});

app.get('/api/hive/recombinations/recent', (req, res) => {
  const limit = clampListLimit(req.query.limit, 20, 200);
  const rows = listRecentHiveRecombinations(limit);
  res.json({ ok: true, count: rows.length, rows });
});

app.get('/api/hive/memories/:memoryId/lineage', (req, res) => {
  const memoryId = String(req.params.memoryId || '').trim();
  if (!memoryId) return badRequest(res, new Error('MEMORY_ID_REQUIRED'));
  const depth = Math.max(1, Math.min(6, Math.floor(Number(req.query.depth) || 3)));
  const lineage = hiveMemoryLineage(memoryId, depth);
  res.json({ ok: true, ...lineage });
});

app.get('/api/hive/buffs', (req, res) => {
  const scope = req.query.scope === 'domain' ? 'domain' : 'global';
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  const rows = listBuffs({ scope, domain, premiumOnly: false });

  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');

  addActivity({
    agentId: typeof req.query.agentId === 'string' ? req.query.agentId : null,
    action: 'HIVE_ACCESS',
    message: `Hive buffs accessed (legacy, scope=${scope}${domain ? `, domain=${domain}` : ''})`,
    meta: { scope, domain: domain || null, count: rows.length, deprecated: true, ...txMeta({ source: 'local', live: false }) }
  });

  res.json({
    ok: true,
    deprecated: true,
    migration: {
      browseEndpoint: '/api/hive/memories',
      cloneEndpoint: '/api/hive/memories/:memoryId/clone'
    },
    scope,
    count: rows.length,
    buffs: rows
  });
});

app.post('/api/hive/buffs/premium', async (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');

  const parsed = premiumBuffSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.flatten());

  const { auth, scope, domain } = parsed.data;
  const payload = { scope, domain: domain || null };
  const requestIsTestOnly = isTestRequestId(auth.requestId);

  return withProtectedAction('GET_PREMIUM_BUFF', payload, auth, req, res, async (input) => {
    markPaymentMetric('premiumCalls');
    enforceDailyBudgetOrThrow('clone');

    const burnSenderReadiness = await checkBurnSenderReadiness();
    if (!burnSenderReadiness.ok) {
      throw new Error(
        `BURN_SENDER_NOT_READY:from=${burnSenderReadiness.burnFrom}:gas=${burnSenderReadiness.gasBalance}:min=${burnSenderReadiness.minGas}`
      );
    }

    await ensureX402SenderSelected();

    return verifyX402Payment({ requestId: auth.requestId, amountUsdc: config.premiumBuffFeeUsdc }).then((payment) => {
      if (!payment.ok) throw new Error('PAYMENT_NOT_VERIFIED');
      markPaymentMetric('verified');

      return burnAntiSybilFee({
        requestId: auth.requestId,
        payerAgent: auth.agentId,
        amountUsdc: config.premiumBuffFeeUsdc
      }).then((burnResult) => {
        if (!burnResult.ok) throw new Error('BURN_FAILED');
        markPaymentMetric('burned');
        if (burnResult.topupTxHash) markPaymentMetric('topup');
        if (burnResult.topupLatencyMs != null) markPaymentLatency('topupLatencyMs', burnResult.topupLatencyMs);
        if (burnResult.burnLatencyMs != null) markPaymentLatency('burnLatencyMs', burnResult.burnLatencyMs);

        db.prepare(
          `INSERT INTO burn_records (request_id, payer_agent, amount_usdc, burn_address, burn_from, burn_tx_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          auth.requestId,
          auth.agentId,
          config.premiumBuffFeeUsdc,
          burnResult.burnAddress,
          burnResult.burnFrom || null,
          burnResult.burnTxHash,
          now()
        );

        const eventPayload = {
          requestId: auth.requestId,
          payer: auth.agentId,
          amountUsdc: config.premiumBuffFeeUsdc,
          burnAddress: burnResult.burnAddress,
          burnTxHash: burnResult.burnTxHash
        };

        return emitEventProof('AntiSybilFeeBurned', eventPayload).then((proof) => {
          recordProof('AntiSybilFeeBurned', eventPayload, proof, { requestId: auth.requestId });
          const budget = bumpDailyBudgetUsage({
            cloneCalls: 1,
            cloneUsdc: Number(config.premiumBuffFeeUsdc || 0),
            chainCalls: 3
          });
          addActivity({
            agentId: auth.agentId,
            action: 'HIVE_ACCESS_PREMIUM',
            message: `Premium hive access granted`,
            hash: proof.eventTxHash,
            hashType: 'tx',
            meta: {
              requestId: auth.requestId,
              paymentTxHash: payment.paymentTxHash,
              paymentProofHash: payment.paymentProofHash || null,
              paymentHashType: payment.paymentHashType || null,
              burnTxHash: burnResult.burnTxHash,
              burnTopupTxHash: burnResult.topupTxHash || null,
              burnTopupLatencyMs: burnResult.topupLatencyMs || null,
              burnLatencyMs: burnResult.burnLatencyMs || null,
              burnFrom: burnResult.burnFrom || null,
              paymentSource: payment.source || null,
              paymentTxLive: Boolean(payment.paymentTxLive),
              burnSource: burnResult.source || null,
              burnTxLive: Boolean(burnResult.burnTxLive),
              budget,
              testOnly: requestIsTestOnly,
              sampleClass: requestIsTestOnly ? 'test' : 'prod',
              ...txMeta({
                source: proof.source,
                live: proof.eventTxLive,
                mode: proof.eventMode,
                explorer: explorerOf(proof.eventTxHash, proof.eventTxLive),
                error: proof?.raw?.error || null
              })
            }
          });

          return {
            deprecated: true,
            migration: {
              browseEndpoint: '/api/hive/memories',
              cloneEndpoint: '/api/hive/memories/:memoryId/clone'
            },
            paymentTxHash: payment.paymentTxHash,
            paymentProofHash: payment.paymentProofHash || null,
            paymentHashType: payment.paymentHashType || null,
            paymentSource: payment.source || null,
            paymentTxLive: Boolean(payment.paymentTxLive),
            burnTxHash: burnResult.burnTxHash,
            burnTopupTxHash: burnResult.topupTxHash || null,
            burnTopupLatencyMs: burnResult.topupLatencyMs || null,
            burnLatencyMs: burnResult.burnLatencyMs || null,
            burnFrom: burnResult.burnFrom || null,
            burnSource: burnResult.source || null,
            burnTxLive: Boolean(burnResult.burnTxLive),
            burnAddress: burnResult.burnAddress,
            eventTxHash: proof.eventTxHash,
            eventSource: proof.source || null,
            eventTxLive: Boolean(proof.eventTxLive),
            eventMode: proof.eventMode || null,
            eventTarget: proof.eventTarget || null,
            budget,
            testOnly: requestIsTestOnly,
            sampleClass: requestIsTestOnly ? 'test' : 'prod',
            buffs: listBuffs({ scope: input.scope, domain: input.domain, premiumOnly: true })
          };
        });
      }).catch(async (err) => {
        markPaymentMetric('burnFailures');
        const parsedFailure = parseBurnAfterTopupFailure(String(err?.message || err));
        if (parsedFailure?.topupTxHash) {
          markPaymentMetric('burnAfterTopupFailures');
          addActivity({
            agentId: auth.agentId,
            action: 'OPS_PREMIUM_BURN_INCOMPLETE',
            message: `topup succeeded but burn failed for request=${auth.requestId}`,
            meta: {
              requestId: auth.requestId,
              topupTxHash: parsedFailure.topupTxHash,
              detail: parsedFailure.detail,
              burnFrom: resolveBurnSenderAddress() || null
            }
          });
          await emitOpsAlert({
            key: 'premium-burn-incomplete',
            action: 'OPS_PREMIUM_BURN_INCOMPLETE',
            severity: 'critical',
            message: `premium burn incomplete for request=${auth.requestId}`,
            meta: {
              requestId: auth.requestId,
              topupTxHash: parsedFailure.topupTxHash,
              detail: parsedFailure.detail,
              burnFrom: resolveBurnSenderAddress() || null
            }
          });
        }
        throw err;
      });
    });
  });
});

app.post('/api/jobs/hive-recombine', async (req, res) => {
  try {
    const force = req.body?.force != null ? Boolean(req.body.force) : true;
    const summary = await runAutoHiveRecombination({ force });
    res.json({ ok: true, summary });
  } catch (error) {
    return badRequest(res, error);
  }
});

app.post('/api/jobs/hive-incubation', (req, res) => {
  try {
    const limit = req.body?.limit ? Number(req.body.limit) : 80;
    const summary = runHiveIncubationSweep({ limit });
    res.json({ ok: true, summary });
  } catch (error) {
    return badRequest(res, error);
  }
});

app.post('/api/jobs/sweep', (req, res) => {
  const result = sweepMemoryLifecycles();
  res.json({ ok: true, ...result, at: now() });
});

app.post('/api/jobs/retry-onchain', async (req, res) => {
  const limit = req.body?.limit ? Number(req.body.limit) : 20;
  const quarantine = quarantineNonRetryablePending(limit * 5);
  const archive = archiveFailedRetryJobs({ limit: Math.max(100, limit * 10) });
  const summary = await processOnchainRetryJobs(limit);
  res.json({ ok: true, quarantine, archive, ...summary, queue: retryQueueStats() });
});

app.post('/api/jobs/retry-maintenance', (req, res) => {
  const limit = req.body?.limit ? Number(req.body.limit) : 500;
  const result = quarantineNonRetryablePending(limit);
  const archive = archiveFailedRetryJobs({ limit });
  res.json({ ok: true, ...result, archive, queue: retryQueueStats() });
});

app.post('/api/jobs/reconcile', (req, res) => {
  const summary = runReconciliation({
    coverageWindowSec: req.body?.coverageWindowSec ? Number(req.body.coverageWindowSec) : 86400,
    requireEventLive: req.body?.requireEventLive != null ? Boolean(req.body.requireEventLive) : config.ops.reconcileRequireEventLive,
    minFinalitySec: req.body?.minFinalitySec != null ? Number(req.body.minFinalitySec) : config.ops.reconcileMinFinalitySec,
    excludeTestOnly: req.body?.excludeTestOnly != null ? Boolean(req.body.excludeTestOnly) : config.ops.reconcileExcludeTestOnly,
    testRequestIdPrefixes: Array.isArray(req.body?.testRequestIdPrefixes)
      ? req.body.testRequestIdPrefixes
      : config.ops.reconcileTestRequestIdPrefixes
  });
  res.json({ ok: true, summary });
});

app.post('/api/jobs/sweep-battles', (_req, res) => {
  const result = sweepBattleWindows();
  if (result.expiredAccepted + result.expiredChallenged > 0) {
    markBattleMetric('expired', result.expiredAccepted + result.expiredChallenged);
  }
  res.json({ ok: true, ...result });
});

app.get('/api/memories/detail/:memoryId', (req, res) => {
  const row = db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(req.params.memoryId);
  if (!row) return badRequest(res, new Error('MEMORY_NOT_FOUND'), 404);

  const includeStrategy = ['1', 'true', 'yes', 'on'].includes(String(req.query.includeStrategy || '').trim().toLowerCase());
  const memory = memoryRowSummary(row, { includeStrategy });
  res.json({ ok: true, memory });
});

app.get('/api/memories/search', (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return badRequest(res, new Error('QUERY_REQUIRED'));

  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  const limit = Number(req.query.limit || 5);
  const rows = searchSimilarMemories({ query, domain, limit });
  res.json({ ok: true, query, domain: domain || null, count: rows.length, results: rows });
});

app.get('/metrics', (_req, res) => {
  res.json({
    ok: true,
    metrics: snapshotMetrics(),
    onchain: onchainRuntimeStatus(),
    retryQueue: retryQueueStats(),
    premiumCapacity: currentPremiumCapacitySnapshot(),
    premiumCoverage24h: premiumSampleCoverage(86400, {
      requireEventLive: config.ops.reconcileRequireEventLive,
      minFinalitySec: config.ops.reconcileMinFinalitySec,
      excludeTestOnly: config.ops.reconcileExcludeTestOnly,
      testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
    })
  });
});

app.get('/api/battles/:battleId', (req, res) => {
  const battle = db.prepare('SELECT * FROM battles WHERE battle_id = ?').get(req.params.battleId);
  if (!battle) return badRequest(res, new Error('BATTLE_NOT_FOUND'), 404);
  res.json({ ok: true, battle });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
});

function parseJsonFromText(out, context) {
  const text = String(out || '').trim();
  if (!text) throw new Error(`${context}_EMPTY_STDOUT`);
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new Error(`${context}_INVALID_JSON:${text}`);
  }
}

function isTransientCliErrorText(detail) {
  const text = String(detail || '').toLowerCase();
  return (
    text.includes('connection reset') ||
    text.includes('connection closed') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('econnreset') ||
    text.includes('recv failure') ||
    text.includes('tls handshake') ||
    text.includes('ssl_error_syscall') ||
    text.includes('fetch failed') ||
    text.includes('socket hang up') ||
    text.includes('network error') ||
    text.includes('eof')
  );
}

function walletCliExecOptions(timeoutMs) {
  return {
    cwd: projectRoot,
    timeout: Math.max(1000, Number(timeoutMs) || 120000),
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      OKX_API_KEY: config.onchain.skill.okxApiKey || process.env.OKX_API_KEY || '',
      OKX_SECRET_KEY: config.onchain.skill.okxSecretKey || process.env.OKX_SECRET_KEY || '',
      OKX_PASSPHRASE: config.onchain.skill.okxPassphrase || process.env.OKX_PASSPHRASE || ''
    }
  };
}

async function runWalletCliJson(command, context, { attempts = 3, timeoutMs } = {}) {
  let lastErr = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);

  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      const { stdout } = await exec(command, walletCliExecOptions(timeoutMs));
      const json = parseJsonFromText(stdout, context);
      if (json?.ok === false) {
        throw new Error(`${context}_FAILED:${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      const detail = String(err?.stderr || err?.stdout || err?.message || err);
      if (i >= maxAttempts || !isTransientCliErrorText(detail)) {
        throw new Error(`${context}_EXEC_FAILED:${detail}`);
      }
      await new Promise((r) => setTimeout(r, 300 * i));
    }
  }

  const detail = String(lastErr?.stderr || lastErr?.stdout || lastErr?.message || lastErr || 'UNKNOWN');
  throw new Error(`${context}_EXEC_FAILED:${detail}`);
}

function pickWalletBalanceDetailFromAll(allJson, currentAccountId = '') {
  const map = allJson?.data?.details;
  if (!map || typeof map !== 'object') return null;

  const wanted = String(currentAccountId || '').trim();
  if (wanted && map[wanted] && Array.isArray(map[wanted]?.tokenAssets)) {
    return { detail: map[wanted], accountId: wanted };
  }

  for (const [accountId, detail] of Object.entries(map)) {
    if (Array.isArray(detail?.tokenAssets)) {
      return { detail, accountId };
    }
  }

  return null;
}

function resolveBurnSenderAddress() {
  const explicit = String(config.onchain.skill.burnFrom || '').trim();
  if (explicit) return explicit;
  if (config.onchain.skill.burnFromX402PayTo) {
    const payTo = String(config.onchain.skill.x402PayTo || '').trim();
    if (payTo) return payTo;
  }
  return String(config.onchain.skill.walletFrom || '').trim();
}

function parseBurnAfterTopupFailure(errorText) {
  const txt = String(errorText || '');
  const match = txt.match(/^BURN_AFTER_TOPUP_FAILED:topupTxHash=([^:]+):(.*)$/);
  if (!match) return null;
  return {
    topupTxHash: match[1] || null,
    detail: String(match[2] || '').trim() || null
  };
}

async function ensureX402SenderSelected() {
  const accountId = String(config.onchain.skill.x402FromAccountId || '').trim();
  if (!accountId) return { ok: true, skipped: true };

  const baseExecOptions = {
    cwd: projectRoot,
    timeout: Math.max(1000, Number(config.ops.autoPremiumAcceptanceTimeoutMs) || 120000),
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      OKX_API_KEY: config.onchain.skill.okxApiKey || process.env.OKX_API_KEY || '',
      OKX_SECRET_KEY: config.onchain.skill.okxSecretKey || process.env.OKX_SECRET_KEY || '',
      OKX_PASSPHRASE: config.onchain.skill.okxPassphrase || process.env.OKX_PASSPHRASE || ''
    }
  };

  let lastErr = null;
  for (let i = 1; i <= 3; i += 1) {
    try {
      await exec(`${config.onchain.skill.cliBin} wallet switch ${accountId}`, baseExecOptions);
      return { ok: true, accountId };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }

  const detail = String(lastErr?.stderr || lastErr?.stdout || lastErr?.message || lastErr || 'UNKNOWN_ERROR');
  throw new Error(`X402_SENDER_SWITCH_FAILED:${detail}`);
}

async function checkBurnSenderReadiness() {
  const burnFrom = resolveBurnSenderAddress();
  if (!burnFrom) return { ok: true, skipped: true, reason: 'burn_sender_not_configured' };

  const chain = String(config.onchain.skill.walletChain || config.chainId);
  const cli = config.onchain.skill.cliBin;
  const walletTimeoutMs = Math.max(1000, Number(config.ops.autoPremiumAcceptanceTimeoutMs) || 120000);

  const runWalletCli = (command, context, attempts = 3) =>
    runWalletCliJson(command, context, { attempts, timeoutMs: walletTimeoutMs });

  const status = await runWalletCli(`${cli} wallet status`, 'WALLET_STATUS');
  const originalAccountId = status?.data?.currentAccountId || null;
  const want = String(burnFrom).toLowerCase();

  let targetAccountId = String(config.onchain.skill.burnFromAccountId || '').trim() || null;

  try {
    if (!targetAccountId) {
      const all = await runWalletCli(`${cli} wallet balance --all --chain ${chain}`, 'WALLET_BALANCE_ALL');
      const accountIds = Object.keys(all?.data?.details || {});
      for (const id of accountIds) {
        await runWalletCli(`${cli} wallet switch ${id}`, 'WALLET_SWITCH');
        const addrs = await runWalletCli(`${cli} wallet addresses --chain ${chain}`, 'WALLET_ADDRESSES');
        const xaddr = String(addrs?.data?.xlayer?.[0]?.address || '').toLowerCase();
        if (xaddr && xaddr === want) {
          targetAccountId = id;
          break;
        }
      }
    }

    if (!targetAccountId) {
      throw new Error(`BURN_SENDER_ACCOUNT_NOT_FOUND:${burnFrom}`);
    }

    await runWalletCli(`${cli} wallet switch ${targetAccountId}`, 'WALLET_SWITCH');
    const single = await runWalletCli(`${cli} wallet balance --chain ${chain} --force`, 'WALLET_BALANCE_SINGLE');
    const tokenAssets = single?.data?.details?.[0]?.tokenAssets || [];
    const gas = tokenAssets.find((a) => String(a.tokenAddress || '').trim() === '' || String(a.symbol || '').toUpperCase() === 'OKB');

    const gasBalance = Number(gas?.balance || 0);
    const minGas = Math.max(0, Number(config.onchain.skill.burnMinGasToken || 0));
    const ok = gasBalance >= minGas;

    return {
      ok,
      burnFrom,
      chain,
      gasBalance,
      minGas,
      gasSymbol: gas?.symbol || 'OKB',
      burnSenderAccountId: targetAccountId
    };
  } finally {
    if (originalAccountId && originalAccountId !== targetAccountId) {
      try {
        await exec(`${cli} wallet switch ${originalAccountId}`, walletCliExecOptions(walletTimeoutMs));
      } catch {
        // best effort restore only
      }
    }
  }
}

function premiumEventLiveRatio(windowSec = 86400, options = {}) {
  const w = Math.max(300, Number(windowSec) || 86400);
  const excludeTestOnly = options.excludeTestOnly != null ? Boolean(options.excludeTestOnly) : true;
  const testPrefixes = Array.isArray(options.testRequestIdPrefixes)
    ? options.testRequestIdPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const sinceTs = now() - w;

  const rows = db
    .prepare(
      `SELECT ts, meta_json AS metaJson
       FROM activity_logs
       WHERE action='HIVE_ACCESS_PREMIUM' AND ts >= ?
       ORDER BY id DESC
       LIMIT 1000`
    )
    .all(sinceTs);

  let total = 0;
  let live = 0;
  let excludedTestOnlyCount = 0;

  for (const row of rows) {
    let meta = null;
    try {
      meta = row.metaJson ? JSON.parse(row.metaJson) : null;
    } catch {
      meta = null;
    }

    const requestId = String(meta?.requestId || '').trim().toLowerCase();
    const sampleClass = String(meta?.sampleClass || '').trim().toLowerCase();
    const flaggedTest = Boolean(meta?.testOnly) || sampleClass === 'test' || testPrefixes.some((p) => requestId.startsWith(p));
    if (excludeTestOnly && flaggedTest) {
      excludedTestOnlyCount += 1;
      continue;
    }

    total += 1;
    if (Boolean(meta?.eventTxLive ?? meta?.hashLive)) live += 1;
  }

  return {
    windowSec: w,
    sampleCount: total,
    liveCount: live,
    excludedTestOnlyCount,
    ratio: total > 0 ? live / total : 1
  };
}

function latestPremiumSampleStatus(windowSec = 86400, options = {}) {
  const w = Math.max(300, Number(windowSec) || 86400);
  const requireEventLive = Boolean(options.requireEventLive);
  const minFinalitySec = Math.max(0, Number(options.minFinalitySec) || 0);
  const excludeTestOnly = options.excludeTestOnly != null ? Boolean(options.excludeTestOnly) : true;
  const testPrefixes = Array.isArray(options.testRequestIdPrefixes)
    ? options.testRequestIdPrefixes.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const sinceTs = now() - w;

  const rows = db
    .prepare(
      `SELECT ts, meta_json AS metaJson
       FROM activity_logs
       WHERE action='HIVE_ACCESS_PREMIUM' AND ts >= ?
       ORDER BY id DESC
       LIMIT 300`
    )
    .all(sinceTs);

  let latestAt = null;
  let latestLiveAt = null;
  let latestFinalizedAt = null;
  let sampleCount = 0;
  let liveSampleCount = 0;
  let finalizedSampleCount = 0;
  let excludedTestOnlyCount = 0;
  const tsNow = now();

  for (const row of rows) {
    let meta = null;
    try {
      meta = row.metaJson ? JSON.parse(row.metaJson) : null;
    } catch {
      meta = null;
    }

    const requestId = String(meta?.requestId || '').trim().toLowerCase();
    const sampleClass = String(meta?.sampleClass || '').trim().toLowerCase();
    const flaggedTest = Boolean(meta?.testOnly) || sampleClass === 'test' || testPrefixes.some((p) => requestId.startsWith(p));
    if (excludeTestOnly && flaggedTest) {
      excludedTestOnlyCount += 1;
      continue;
    }

    sampleCount += 1;
    const ts = Number(row.ts || 0);
    if (!latestAt || ts > latestAt) latestAt = ts;

    const eventLive = Boolean(meta?.eventTxLive ?? meta?.hashLive);
    const paymentEvidence = Boolean(meta?.paymentTxLive) || String(meta?.paymentHashType || '').toLowerCase() === 'proof';
    const live = paymentEvidence && Boolean(meta?.burnTxLive) && (!requireEventLive || eventLive);
    if (live) {
      liveSampleCount += 1;
      if (!latestLiveAt || ts > latestLiveAt) latestLiveAt = ts;

      if (Math.max(0, tsNow - ts) >= minFinalitySec) {
        finalizedSampleCount += 1;
        if (!latestFinalizedAt || ts > latestFinalizedAt) latestFinalizedAt = ts;
      }
    }
  }

  return {
    windowSec: w,
    requireEventLive,
    minFinalitySec,
    excludeTestOnly,
    testRequestIdPrefixes: testPrefixes,
    rawSampleCount: rows.length,
    excludedTestOnlyCount,
    sampleCount,
    liveSampleCount,
    finalizedSampleCount,
    latestSampleAt: latestAt,
    latestLiveSampleAt: latestLiveAt,
    latestFinalizedSampleAt: latestFinalizedAt,
    hasAnySample: sampleCount > 0,
    hasLiveSample: liveSampleCount > 0,
    hasFinalizedSample: finalizedSampleCount > 0
  };
}

async function premiumAcceptanceBalanceGuard() {
  if (!config.ops.autoPremiumAcceptanceBalanceGuardEnabled) {
    return { ok: true, skipped: true, reason: 'guard_disabled' };
  }

  const chain = String(config.ops.autoPremiumAcceptanceGuardChain || config.onchain.skill.walletChain || config.chainId);
  const cli = config.onchain.skill.cliBin;
  const timeoutMs = Math.max(1000, Number(config.ops.autoPremiumAcceptanceTimeoutMs) || 120000);
  const usdcToken = String(config.onchain.skill.usdcToken || config.onchain.skill.x402Asset || '').toLowerCase();

  let balanceJson = null;
  let detail = null;
  let accountId = null;
  const attempts = [];

  const tryLoadSingle = async (force = false) => {
    const cmd = `${cli} wallet balance --chain ${chain}${force ? ' --force' : ''}`;
    const json = await runWalletCliJson(cmd, force ? 'WALLET_BALANCE_FORCE' : 'WALLET_BALANCE_SINGLE', {
      attempts: 4,
      timeoutMs
    });
    const d = json?.data?.details?.[0];
    if (!d || !Array.isArray(d?.tokenAssets)) {
      throw new Error('WALLET_BALANCE_SCHEMA_MISSING_DETAILS');
    }
    return { json, detail: d, accountId: json?.data?.accountId || null };
  };

  const tryLoadAll = async () => {
    const all = await runWalletCliJson(`${cli} wallet balance --all --chain ${chain}`, 'WALLET_BALANCE_ALL', {
      attempts: 4,
      timeoutMs
    });

    const status = await runWalletCliJson(`${cli} wallet status`, 'WALLET_STATUS', {
      attempts: 2,
      timeoutMs
    }).catch(() => null);

    const picked = pickWalletBalanceDetailFromAll(all, status?.data?.currentAccountId || all?.data?.accountId || '');
    if (!picked?.detail || !Array.isArray(picked.detail?.tokenAssets)) {
      throw new Error('WALLET_BALANCE_ALL_SCHEMA_MISSING_DETAILS');
    }

    return { json: all, detail: picked.detail, accountId: picked.accountId || status?.data?.currentAccountId || null };
  };

  try {
    ({ json: balanceJson, detail, accountId } = await tryLoadSingle(true));
  } catch (err) {
    attempts.push(String(err?.message || err));
    try {
      ({ json: balanceJson, detail, accountId } = await tryLoadSingle(false));
    } catch (err2) {
      attempts.push(String(err2?.message || err2));
      try {
        ({ json: balanceJson, detail, accountId } = await tryLoadAll());
      } catch (err3) {
        attempts.push(String(err3?.message || err3));
        throw new Error(`WALLET_BALANCE_UNAVAILABLE:${attempts.join(' | ')}`);
      }
    }
  }

  const assets = Array.isArray(detail?.tokenAssets) ? detail.tokenAssets : [];
  const usdcAsset = assets.find((a) => String(a.tokenAddress || '').toLowerCase() === usdcToken || String(a.symbol || '').toUpperCase() === 'USDC');
  const gasAsset = assets.find((a) => String(a.tokenAddress || '').trim() === '' || String(a.symbol || '').toUpperCase() === 'OKB');

  const usdc = Number(usdcAsset?.balance || 0);
  const gas = Number(gasAsset?.balance || 0);

  const minUsdc = Math.max(Number(config.ops.autoPremiumAcceptanceMinUsdc || 0), Number(config.premiumBuffFeeUsdc || 0));
  const minGas = Math.max(0, Number(config.ops.autoPremiumAcceptanceMinGasToken || 0));

  const ok = usdc >= minUsdc && gas >= minGas;
  return {
    ok,
    chain,
    usdc,
    gas,
    minUsdc,
    minGas,
    accountId: accountId || balanceJson?.data?.accountId || null
  };
}

function premiumCapacitySnapshotFromGuard(guard) {
  const feeUsdc = Math.max(Number(config.premiumBuffFeeUsdc || 0), 0.0000001);
  if (guard?.skipped) {
    return {
      ...guard,
      feeUsdc,
      estimatedRunsByUsdc: null,
      estimatedRunsByGas: null,
      estimatedPremiumRuns: null
    };
  }

  const minGas = Math.max(0, Number(guard?.minGas || 0));
  const byUsdc = Math.max(0, Math.floor(Number(guard?.usdc || 0) / feeUsdc));
  const byGas = minGas > 0 ? Math.max(0, Math.floor(Number(guard?.gas || 0) / minGas)) : Number.POSITIVE_INFINITY;
  const estimatedPremiumRuns = Number.isFinite(byGas) ? Math.max(0, Math.min(byUsdc, byGas)) : byUsdc;

  return {
    ...guard,
    feeUsdc,
    estimatedRunsByUsdc: byUsdc,
    estimatedRunsByGas: Number.isFinite(byGas) ? byGas : null,
    estimatedPremiumRuns
  };
}

async function refreshPremiumCapacitySnapshot({ force = false } = {}) {
  const ts = now();
  const intervalSec = Math.max(60, Number(config.ops.premiumBalanceCheckIntervalSec || 900));

  if (!force && opsAlertState.lastBalanceSnapshot && ts - Number(opsAlertState.lastBalanceCheckAt || 0) < intervalSec) {
    return opsAlertState.lastBalanceSnapshot;
  }

  try {
    const guard = await premiumAcceptanceBalanceGuard();
    const snapshot = {
      checkedAt: ts,
      staleSec: 0,
      ...premiumCapacitySnapshotFromGuard(guard)
    };
    opsAlertState.lastBalanceSnapshot = snapshot;
    opsAlertState.lastBalanceCheckAt = ts;
    return snapshot;
  } catch (error) {
    const detail = String(error?.message || error);
    const previous = opsAlertState.lastBalanceSnapshot;

    if (previous && previous.ok) {
      const staleSnapshot = {
        ...previous,
        staleSec: Math.max(0, ts - Number(previous.checkedAt || ts)),
        degraded: true,
        lastError: detail,
        lastAttemptAt: ts
      };
      opsAlertState.lastBalanceSnapshot = staleSnapshot;
      opsAlertState.lastBalanceCheckAt = ts;
      return staleSnapshot;
    }

    const snapshot = {
      checkedAt: ts,
      staleSec: 0,
      ok: false,
      error: detail
    };
    opsAlertState.lastBalanceSnapshot = snapshot;
    opsAlertState.lastBalanceCheckAt = ts;
    return snapshot;
  }
}

function currentPremiumCapacitySnapshot() {
  const snap = opsAlertState.lastBalanceSnapshot;
  if (!snap) return null;
  return {
    ...snap,
    staleSec: Math.max(0, now() - Number(snap.checkedAt || 0))
  };
}

function hardThresholdStatus() {
  const enabled = Boolean(config.ops.hardThresholdsEnabled);
  const windowSec = Math.max(300, Number(config.ops.hardThresholdWindowSec || 86400));
  const eventLive = premiumEventLiveRatio(windowSec, {
    excludeTestOnly: config.ops.reconcileExcludeTestOnly,
    testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
  });
  const reconcile = latestReconciliation();
  const premiumCapacity = currentPremiumCapacitySnapshot();
  const metrics = snapshotMetrics();
  const reqTotal = Math.max(0, Number(metrics.requestsTotal || 0));
  const err404 = Math.max(0, Number(metrics.errorsByCode?.['404'] || 0));
  const rate404 = reqTotal > 0 ? err404 / reqTotal : 0;

  const thresholds = {
    eventTxLiveRatioMin: Math.max(0, Math.min(1, Number(config.ops.hardEventTxLiveRatioMin || 0.85))),
    reconcileMismatchMax: Math.max(0, Number(config.ops.hardReconcileMismatchMax || 0)),
    premiumRemainingCallsMin: Math.max(0, Number(config.ops.hardPremiumRemainingCallsMin || 1)),
    http404RateMax: Math.max(0, Number(config.ops.hard404RateMax || 0.05))
  };

  const premiumCapacityReliable =
    Boolean(premiumCapacity?.ok) &&
    Number.isFinite(Number(premiumCapacity?.estimatedPremiumRuns)) &&
    !String(premiumCapacity?.error || '').trim();

  const values = {
    eventTxLiveRatio: Number(eventLive.ratio || 0),
    reconcileMismatch: Number(reconcile?.mismatch || 0),
    premiumRemainingCalls: premiumCapacityReliable
      ? Number(premiumCapacity?.estimatedPremiumRuns)
      : Number.POSITIVE_INFINITY,
    http404Rate: Number(rate404 || 0)
  };

  const breaches = [];
  const warnings = [];
  if (values.eventTxLiveRatio < thresholds.eventTxLiveRatioMin) breaches.push('event_tx_live_ratio');
  if (values.reconcileMismatch > thresholds.reconcileMismatchMax) breaches.push('reconcile_mismatch');
  if (premiumCapacityReliable && values.premiumRemainingCalls < thresholds.premiumRemainingCallsMin) {
    breaches.push('premium_remaining_calls');
  } else if (!premiumCapacityReliable) {
    warnings.push('premium_capacity_unavailable');
  }
  if (values.http404Rate > thresholds.http404RateMax) breaches.push('http_404_rate');

  return {
    enabled,
    windowSec,
    thresholds,
    values,
    breaches,
    warnings,
    premiumCapacityReliable,
    blockedActions: breaches.some((x) => ['event_tx_live_ratio', 'reconcile_mismatch', 'premium_remaining_calls'].includes(x))
      ? ['CLONE_HIVE_MEMORY', 'GET_PREMIUM_BUFF']
      : [],
    ok: !enabled || breaches.length === 0,
    eventLive,
    reconcile,
    premiumCapacity
  };
}

function enforceHardThresholdOrThrow(action) {
  if (!config.ops.hardThresholdsEnabled) return;
  if (!['CLONE_HIVE_MEMORY', 'GET_PREMIUM_BUFF'].includes(String(action || ''))) return;

  const status = hardThresholdStatus();
  if (status.ok) return;

  if (status.blockedActions.includes(action)) {
    throw new Error(`HARD_THRESHOLD_BLOCKED:${status.breaches.join(',')}`);
  }
}

async function runPremiumAcceptanceAndReconcile() {
  const coverage = premiumSampleCoverage(86400, {
    requireEventLive: config.ops.reconcileRequireEventLive,
    minFinalitySec: config.ops.reconcileMinFinalitySec,
    excludeTestOnly: config.ops.reconcileExcludeTestOnly,
    testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
  });
  const sampleStatus = latestPremiumSampleStatus(86400, {
    requireEventLive: config.ops.reconcileRequireEventLive,
    minFinalitySec: config.ops.reconcileMinFinalitySec,
    excludeTestOnly: config.ops.reconcileExcludeTestOnly,
    testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
  });

  const needAnySample = !coverage.ok;
  const needLiveSample = config.ops.autoPremiumAcceptanceRequireLiveSample && !sampleStatus.hasFinalizedSample;
  if (!needAnySample && !needLiveSample) {
    return { skipped: true, reason: 'coverage_ok', coverage, sampleStatus };
  }

  const cmd = String(config.ops.autoPremiumAcceptanceCmd || '').trim();
  if (!cmd) {
    await emitOpsAlert({
      key: 'premium-sample-missing',
      action: 'OPS_PREMIUM_SAMPLE_MISSING',
      severity: 'warn',
      message: `No premium acceptance sample in last 24h; set AUTO_PREMIUM_ACCEPTANCE_CMD to auto-run one`,
      meta: { coverage, sampleStatus }
    });
    return { skipped: true, reason: 'cmd_missing', coverage, sampleStatus };
  }

  const guard = await refreshPremiumCapacitySnapshot({ force: true });
  if (guard?.error) {
    await emitOpsAlert({
      key: 'premium-acceptance-balance-check-error',
      action: 'OPS_PREMIUM_ACCEPTANCE_ERROR',
      severity: 'critical',
      message: `premium acceptance balance check failed: ${String(guard.error || 'UNKNOWN_ERROR')}`,
      meta: { command: cmd, guard }
    });
    return { skipped: false, ok: false, reason: 'balance_check_failed' };
  }

  if (!guard?.ok) {
    await emitOpsAlert({
      key: 'premium-acceptance-balance-low',
      action: 'OPS_PREMIUM_ACCEPTANCE_SKIPPED',
      severity: 'warn',
      message: `premium acceptance skipped due to low balance (USDC ${guard.usdc}/${guard.minUsdc}, gas ${guard.gas}/${guard.minGas})`,
      meta: guard
    });
    return { skipped: true, reason: 'balance_guard', guard };
  }

  try {
    const { stdout, stderr } = await exec(cmd, {
      cwd: projectRoot,
      timeout: Math.max(1000, Number(config.ops.autoPremiumAcceptanceTimeoutMs) || 120000),
      maxBuffer: 1024 * 1024
    });

    addActivity({
      agentId: 'ops',
      action: 'OPS_PREMIUM_ACCEPTANCE_RUN',
      message: 'daily premium acceptance command completed',
      meta: {
        command: cmd,
        stdout: String(stdout || '').slice(-2000),
        stderr: String(stderr || '').slice(-2000)
      }
    });
  } catch (err) {
    await emitOpsAlert({
      key: 'premium-acceptance-failed',
      action: 'OPS_PREMIUM_ACCEPTANCE_ERROR',
      severity: 'critical',
      message: String(err?.message || err),
      meta: { command: cmd }
    });
    return { skipped: false, ok: false, reason: 'command_failed' };
  }

  const postSampleStatus = latestPremiumSampleStatus(86400, {
    requireEventLive: config.ops.reconcileRequireEventLive,
    minFinalitySec: config.ops.reconcileMinFinalitySec,
    excludeTestOnly: config.ops.reconcileExcludeTestOnly,
    testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
  });
  if (config.ops.autoPremiumAcceptanceRequireLiveSample && !postSampleStatus.hasFinalizedSample) {
    await emitOpsAlert({
      key: 'premium-live-sample-missing',
      action: 'OPS_PREMIUM_SAMPLE_MISSING',
      severity: 'warn',
      message: `premium acceptance ran but no settlement-ready sample observed (requireEventLive=${config.ops.reconcileRequireEventLive}, minFinalitySec=${config.ops.reconcileMinFinalitySec})`,
      meta: postSampleStatus
    });
  }

  const summary = runReconciliation({
    coverageWindowSec: 86400,
    requireEventLive: config.ops.reconcileRequireEventLive,
    minFinalitySec: config.ops.reconcileMinFinalitySec,
    excludeTestOnly: config.ops.reconcileExcludeTestOnly,
    testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
  });
  if (summary.mismatch > Number(config.ops.alertReconcileMismatchThreshold || 0)) {
    await emitOpsAlert({
      key: 'reconcile-mismatch',
      action: 'OPS_RECONCILE_ALERT',
      severity: 'critical',
      message: `reconciliation mismatch=${summary.mismatch}`,
      meta: summary
    });
  }

  return { skipped: false, ok: true, summary, sampleStatus: postSampleStatus };
}

function startOpsWorkers() {
  if (config.ops.autoRetryEnabled && config.ops.autoRetryIntervalSec > 0) {
    setInterval(async () => {
      try {
        const quarantine = quarantineNonRetryablePending(config.ops.autoRetryBatch * 5);
        const archive = archiveFailedRetryJobs({ limit: config.ops.failedArchiveBatch });
        const summary = await processOnchainRetryJobs(config.ops.autoRetryBatch);
        if (quarantine.moved > 0 || archive.archived > 0 || summary.done > 0 || summary.failed > 0) {
          addActivity({
            agentId: 'ops',
            action: 'OPS_RETRY',
            message: `retry worker done=${summary.done} failed=${summary.failed} quarantined=${quarantine.moved} archived=${archive.archived}`,
            meta: { summary, quarantine, archive, queue: retryQueueStats() }
          });
        }
      } catch (error) {
        addActivity({
          agentId: 'ops',
          action: 'OPS_RETRY_ERROR',
          message: String(error?.message || error)
        });
      }
    }, config.ops.autoRetryIntervalSec * 1000);
  }

  if (config.ops.autoReconcileEnabled && config.ops.autoReconcileIntervalSec > 0) {
    setInterval(async () => {
      try {
        const summary = runReconciliation({
          coverageWindowSec: 86400,
          requireEventLive: config.ops.reconcileRequireEventLive,
          minFinalitySec: config.ops.reconcileMinFinalitySec,
          excludeTestOnly: config.ops.reconcileExcludeTestOnly,
          testRequestIdPrefixes: config.ops.reconcileTestRequestIdPrefixes
        });
        if (summary.mismatch > Number(config.ops.alertReconcileMismatchThreshold || 0)) {
          await emitOpsAlert({
            key: 'reconcile-mismatch',
            action: 'OPS_RECONCILE_ALERT',
            severity: 'critical',
            message: `reconciliation mismatch=${summary.mismatch}`,
            meta: summary
          });
        }
        if (!summary.coverage?.ok || !summary.coverage?.finalizedOk) {
          await emitOpsAlert({
            key: 'reconcile-coverage-missing',
            action: 'OPS_RECONCILE_SAMPLE_ALERT',
            severity: 'warn',
            message: 'reconciliation coverage missing settlement-ready premium samples in last 24h',
            meta: summary.coverage
          });
        }
      } catch (error) {
        addActivity({
          agentId: 'ops',
          action: 'OPS_RECONCILE_ERROR',
          message: String(error?.message || error)
        });
      }
    }, config.ops.autoReconcileIntervalSec * 1000);
  }

  if (config.ops.autoBattleSweepEnabled && config.ops.autoBattleSweepIntervalSec > 0) {
    setInterval(() => {
      try {
        const result = sweepBattleWindows();
        const expired = Number(result.expiredChallenged || 0) + Number(result.expiredAccepted || 0);
        if (expired > 0) {
          markBattleMetric('expired', expired);
          addActivity({
            agentId: 'ops',
            action: 'OPS_BATTLE_SWEEP',
            message: `battle sweep expired challenged=${result.expiredChallenged} accepted=${result.expiredAccepted}`,
            meta: result
          });
        }
      } catch (error) {
        addActivity({
          agentId: 'ops',
          action: 'OPS_BATTLE_SWEEP_ERROR',
          message: String(error?.message || error)
        });
      }
    }, Math.max(60, Number(config.ops.autoBattleSweepIntervalSec || 300)) * 1000);
  }

  if (config.ops.autoPremiumAcceptanceEnabled && config.ops.autoPremiumAcceptanceIntervalSec > 0) {
    setInterval(async () => {
      const ts = now();
      if (ts - Number(opsAlertState.lastPremiumAcceptanceRunAt || 0) < config.ops.autoPremiumAcceptanceIntervalSec) {
        return;
      }
      opsAlertState.lastPremiumAcceptanceRunAt = ts;
      try {
        await runPremiumAcceptanceAndReconcile();
      } catch (error) {
        addActivity({
          agentId: 'ops',
          action: 'OPS_PREMIUM_ACCEPTANCE_ERROR',
          message: String(error?.message || error)
        });
      }
    }, Math.min(config.ops.autoPremiumAcceptanceIntervalSec, 3600) * 1000);
  }

  if (config.ops.autoHiveIncubationEnabled && config.ops.autoHiveIncubationIntervalSec > 0) {
    setInterval(async () => {
      if (opsAlertState.hiveIncubationRunning) return;

      const ts = now();
      if (ts - Number(opsAlertState.lastHiveIncubationRunAt || 0) < Number(config.ops.autoHiveIncubationIntervalSec || 0)) {
        return;
      }

      opsAlertState.hiveIncubationRunning = true;
      opsAlertState.lastHiveIncubationRunAt = ts;
      try {
        const summary = runHiveIncubationSweep({ limit: 120 });
        if (summary.activated > 0 || summary.retired > 0) {
          addActivity({
            agentId: 'ops',
            action: 'OPS_HIVE_INCUBATION',
            message: `hive incubation activated=${summary.activated} retired=${summary.retired}`,
            meta: summary
          });
        }
      } catch (error) {
        addActivity({
          agentId: 'ops',
          action: 'OPS_HIVE_INCUBATION_ERROR',
          message: String(error?.message || error)
        });
      } finally {
        opsAlertState.hiveIncubationRunning = false;
      }
    }, Math.min(Number(config.ops.autoHiveIncubationIntervalSec || 1800), 1800) * 1000);
  }

  if (config.ops.autoHiveRecombineEnabled && config.ops.autoHiveRecombineIntervalSec > 0) {
    setInterval(async () => {
      if (opsAlertState.hiveRecombineRunning) return;

      const ts = now();
      if (ts - Number(opsAlertState.lastHiveRecombineRunAt || 0) < Number(config.ops.autoHiveRecombineIntervalSec || 0)) {
        return;
      }

      opsAlertState.hiveRecombineRunning = true;
      opsAlertState.lastHiveRecombineRunAt = ts;
      try {
        const summary = await runAutoHiveRecombination({ force: false });
        if (summary?.executed) {
          addActivity({
            agentId: 'ops',
            action: 'OPS_HIVE_RECOMBINE',
            message: `hive recombine executed child=${summary.childMemoryId}`,
            meta: summary
          });
        }
      } catch (error) {
        addActivity({
          agentId: 'ops',
          action: 'OPS_HIVE_RECOMBINE_ERROR',
          message: String(error?.message || error)
        });
      } finally {
        opsAlertState.hiveRecombineRunning = false;
      }
    }, Math.min(Number(config.ops.autoHiveRecombineIntervalSec || 21600), 3600) * 1000);
  }

  if (config.ops.alertEnabled && config.ops.alertIntervalSec > 0) {
    setInterval(async () => {
      const q = retryQueueStats();

      if (q.pending >= config.ops.alertRetryPendingThreshold) {
        await emitOpsAlert({
          key: 'retry-pending-threshold',
          action: 'OPS_ALERT',
          severity: 'warn',
          message: `retry queue pending=${q.pending} threshold=${config.ops.alertRetryPendingThreshold}`,
          meta: { queue: q }
        });
      }

      const cap = await refreshPremiumCapacitySnapshot({ force: false });
      if (cap?.error) {
        await emitOpsAlert({
          key: 'premium-capacity-check-error',
          action: 'OPS_PREMIUM_CAPACITY_ALERT',
          severity: 'critical',
          message: `premium capacity check failed: ${cap.error}`,
          meta: cap
        });
      } else if (cap && cap.ok && Number.isFinite(cap.estimatedPremiumRuns)) {
        const critical = Math.max(0, Number(config.ops.alertPremiumCapacityCriticalThreshold || 0));
        const warn = Math.max(critical, Number(config.ops.alertPremiumCapacityWarnThreshold || critical));

        if (cap.estimatedPremiumRuns <= critical) {
          await emitOpsAlert({
            key: 'premium-capacity-critical',
            action: 'OPS_PREMIUM_CAPACITY_ALERT',
            severity: 'critical',
            message: `premium capacity critical: estimated runs=${cap.estimatedPremiumRuns}`,
            meta: cap
          });
        } else if (cap.estimatedPremiumRuns <= warn) {
          await emitOpsAlert({
            key: 'premium-capacity-warn',
            action: 'OPS_PREMIUM_CAPACITY_ALERT',
            severity: 'warn',
            message: `premium capacity low: estimated runs=${cap.estimatedPremiumRuns}`,
            meta: cap
          });
        }
      }

      const circuit = onchainRuntimeStatus().circuit || {};
      const ts = now();
      for (const action of ['verify', 'burn', 'event']) {
        if (circuit[action]?.open) {
          if (!opsAlertState.circuitOpenSince[action]) {
            opsAlertState.circuitOpenSince[action] = ts;
          }
          const durationSec = ts - Number(opsAlertState.circuitOpenSince[action]);
          if (durationSec >= Number(config.ops.alertCircuitOpenThresholdSec || 300)) {
            await emitOpsAlert({
              key: `circuit-open-${action}`,
              action: 'OPS_CIRCUIT_ALERT',
              severity: 'critical',
              message: `circuit ${action} open for ${durationSec}s`,
              meta: { action, durationSec, circuit: circuit[action] }
            });
          }
        } else {
          delete opsAlertState.circuitOpenSince[action];
        }
      }

      const latest = latestReconciliation();
      if (latest && Number(latest.mismatch || 0) > Number(config.ops.alertReconcileMismatchThreshold || 0)) {
        await emitOpsAlert({
          key: 'reconcile-mismatch',
          action: 'OPS_RECONCILE_ALERT',
          severity: 'critical',
          message: `reconcile mismatch=${latest.mismatch}`,
          meta: latest
        });
      }

      const hard = hardThresholdStatus();
      if (!hard.ok) {
        await emitOpsAlert({
          key: 'hard-threshold-breach',
          action: 'OPS_HARD_THRESHOLD_ALERT',
          severity: hard.blockedActions.length ? 'critical' : 'warn',
          message: `hard thresholds breached: ${hard.breaches.join(',')}`,
          meta: hard
        });
      }

      const budget = dailyBudgetSnapshot();
      if (budget.enabled && !budget.ok) {
        await emitOpsAlert({
          key: 'daily-budget-breach',
          action: 'OPS_DAILY_BUDGET_ALERT',
          severity: 'warn',
          message: `daily budget reached: ${budget.breaches.join(',')}`,
          meta: budget
        });
      }
    }, config.ops.alertIntervalSec * 1000);
  }
}

app.listen(config.port, () => {
  console.log(`EvoHive Arena running on http://localhost:${config.port}`);

  const sigPolicy = signaturePolicyStatus();
  if (!sigPolicy.ok && sigPolicy.production && sigPolicy.strictInProd && config.security.strictSignatureFailClosed) {
    const msg = `FATAL signature policy violation: ${sigPolicy.issues.join(',')}`;
    addActivity({ agentId: 'ops', action: 'OPS_SIGNATURE_POLICY_FATAL', message: msg, meta: sigPolicy });
    console.error(msg);
    setTimeout(() => process.exit(1), 50);
    return;
  }

  const x402 = x402PreflightStatus();
  if (!x402.ok) {
    addActivity({
      agentId: 'ops',
      action: 'OPS_PREFLIGHT_WARN',
      message: x402.message,
      meta: { check: 'x402', ...x402 }
    });
  }

  refreshPremiumCapacitySnapshot({ force: true }).catch(() => {});
  startOpsWorkers();
});
