#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return '';
}

const envPath = argValue('--env') || process.env.ENV_FILE || '';
if (envPath) loadEnvFile(envPath);

function toBool(v, fallback = false) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function hashPayload(payload) {
  return `0x${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
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

const cfg = {
  baseUrl: String(process.env.EVOHIVE_BASE_URL || 'http://127.0.0.1:4311').replace(/\/+$/, ''),
  agentId: String(process.env.EVOHIVE_AGENT_ID || '').trim(),
  authSecret: String(process.env.EVOHIVE_AUTH_SECRET || '').trim(),
  authKeyId: String(process.env.EVOHIVE_AUTH_KEY_ID || '').trim(),
  namespace: String(process.env.EVOHIVE_NAMESPACE || '').trim(),
  arenaId: String(process.env.EVOHIVE_ARENA_ID || 'arena-main').trim(),
  chainId: toNum(process.env.EVOHIVE_CHAIN_ID, 196),
  authTtlSec: Math.max(30, Math.min(toNum(process.env.EVOHIVE_AUTH_TTL_SEC, 120), 600)),
  pollIntervalSec: Math.max(2, Math.min(toNum(process.env.POLL_INTERVAL_SEC, 6), 300)),
  acceptOpenOnly: toBool(process.env.ACCEPT_OPEN_ONLY, true),
  maxAcceptPerPoll: Math.max(1, Math.min(toNum(process.env.MAX_ACCEPT_PER_POLL, 2), 20)),
  preferDomainMatch: toBool(process.env.PREFER_DOMAIN_MATCH, true),
  dryRun: toBool(process.env.DRY_RUN, false),
  apiToken: String(process.env.EVOHIVE_API_TOKEN || '').trim(),
  hive: {
    autoEnabled: toBool(process.env.HIVE_AUTO_ENABLED, false),
    intervalSec: Math.max(30, Math.min(toNum(process.env.HIVE_INTERVAL_SEC, 3600), 86400)),
    domain: String(process.env.HIVE_DOMAIN || '').trim(),
    query: String(process.env.HIVE_QUERY || '').trim(),
    limit: Math.max(1, Math.min(toNum(process.env.HIVE_LIMIT, 100), 500)),
    cloneMaxPerRun: Math.max(1, Math.min(toNum(process.env.HIVE_CLONE_MAX_PER_RUN, 1), 20)),
    minWeightedScore: toNum(process.env.HIVE_MIN_WEIGHTED_SCORE, 0),
    minAvgScore: toNum(process.env.HIVE_MIN_AVG_SCORE, 0),
    minRatingCount: Math.max(0, toNum(process.env.HIVE_MIN_RATING_COUNT, 0)),
    minHeat: Math.max(0, toNum(process.env.HIVE_MIN_HEAT, 0)),
    backupAgentId: String(process.env.HIVE_BACKUP_AGENT_ID || 'hive/backup').trim() || 'hive/backup',
    skipIfAlreadyCloned: toBool(process.env.HIVE_SKIP_IF_ALREADY_CLONED, true),
    cloneNote: String(process.env.HIVE_CLONE_NOTE || 'auto-clone-by-remote-agent').trim(),
    rateEnabled: toBool(process.env.HIVE_RATE_ENABLED, true),
    rateScore: Math.max(1, Math.min(toNum(process.env.HIVE_RATE_SCORE, 4.2), 5)),
    rateNote: String(process.env.HIVE_RATE_NOTE || 'auto-rate-by-remote-agent').trim()
  }
};

if (!cfg.agentId) {
  console.error('[fatal] EVOHIVE_AGENT_ID is required');
  process.exit(1);
}
if (!cfg.authSecret) {
  console.error('[fatal] EVOHIVE_AUTH_SECRET is required');
  process.exit(1);
}

function headers() {
  return {
    'content-type': 'application/json',
    ...(cfg.apiToken ? { 'x-evohive-token': cfg.apiToken } : {})
  };
}

function errorText(err) {
  const bodyError = err?.body?.error;
  if (bodyError) return String(bodyError);
  return String(err?.message || err || 'unknown error');
}

function withOptionalNote(note) {
  const v = String(note || '').trim();
  return v ? { note: v } : {};
}

function signAuthEnvelopeHmac(auth) {
  return `0x${crypto.createHmac('sha256', cfg.authSecret).update(canonicalAuthForSignature(auth)).digest('hex')}`;
}

function makeAuth(action, payload) {
  const ts = nowSec();
  const auth = {
    requestId: `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: cfg.agentId,
    action,
    payloadHash: hashPayload(payload),
    issuedAt: ts,
    deadline: ts + cfg.authTtlSec,
    arenaId: cfg.arenaId,
    chainId: cfg.chainId,
    ...(cfg.authKeyId ? { keyId: cfg.authKeyId } : {}),
    ...(cfg.namespace ? { namespace: cfg.namespace } : {})
  };

  return {
    ...auth,
    signature: signAuthEnvelopeHmac(auth)
  };
}

async function httpJson(path, options = {}) {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok || body?.ok === false) {
    const err = new Error(body?.error || `HTTP_${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

async function issueRiskToken(action, auth) {
  const tokenRes = await httpJson('/api/security/risk-token', {
    method: 'POST',
    body: JSON.stringify({
      action,
      requestId: auth.requestId,
      payloadHash: auth.payloadHash
    })
  });

  return String(tokenRes?.token || '').trim();
}

async function postSigned(path, action, payload, bodyFactory) {
  const auth = makeAuth(action, payload);
  const firstBody = bodyFactory(auth);

  if (cfg.dryRun) {
    return { ok: true, dryRun: true, action, path, payload };
  }

  try {
    return await httpJson(path, {
      method: 'POST',
      body: JSON.stringify(firstBody)
    });
  } catch (err) {
    const msg = errorText(err);
    if (!msg.startsWith('RISK_CONFIRMATION_REQUIRED')) throw err;

    const riskToken = await issueRiskToken(action, auth);
    if (!riskToken) throw err;

    const secondBody = bodyFactory({
      ...auth,
      riskToken
    });

    return await httpJson(path, {
      method: 'POST',
      body: JSON.stringify(secondBody)
    });
  }
}

function listOwnActiveMemories(memories) {
  return (Array.isArray(memories) ? memories : [])
    .filter((m) => String(m?.sourceAgent || '') === cfg.agentId && String(m?.state || 'active') === 'active')
    .sort((a, b) => {
      const af = Number(a?.fitness || 0);
      const bf = Number(b?.fitness || 0);
      if (bf !== af) return bf - af;
      const at = Number(a?.updatedAt || a?.createdAt || 0);
      const bt = Number(b?.updatedAt || b?.createdAt || 0);
      return bt - at;
    });
}

function pickMemoryForBattle(memories, battle) {
  const own = listOwnActiveMemories(memories);
  if (!own.length) return null;

  const domain = String(battle?.domain || '').trim();
  if (cfg.preferDomainMatch && domain) {
    const matched = own.find((m) => String(m?.domain || '').trim() === domain);
    if (matched) return matched;
  }

  return own[0];
}

function isAcceptableBattle(b) {
  if (!b || String(b.status) !== 'challenged') return false;

  const isOpen = Boolean(b.isOpen);
  const assignedToMe = String(b.opponentAgent || '') === cfg.agentId;

  if (cfg.acceptOpenOnly) return isOpen;
  return isOpen || assignedToMe;
}

function hasClonedSourceByMe(memoryRow, sourceMemoryId) {
  if (!memoryRow || String(memoryRow.sourceAgent || '') !== cfg.agentId) return false;
  const attrs = Array.isArray(memoryRow.attributes) ? memoryRow.attributes : [];
  return attrs.some((x) => String(x?.trait_type || '') === 'hiveSourceMemoryId' && String(x?.value || '') === sourceMemoryId);
}

function ownClonedSourceSet(memories) {
  const out = new Set();
  for (const m of Array.isArray(memories) ? memories : []) {
    if (String(m?.sourceAgent || '') !== cfg.agentId) continue;
    const attrs = Array.isArray(m?.attributes) ? m.attributes : [];
    for (const a of attrs) {
      if (String(a?.trait_type || '') === 'hiveSourceMemoryId' && String(a?.value || '').trim()) {
        out.add(String(a.value).trim());
      }
    }
  }
  return out;
}

async function acceptBattle(battleId, opponentMemoryId) {
  const payload = { battleId, opponentMemoryId };
  return postSigned(
    `/api/battles/${encodeURIComponent(battleId)}/accept`,
    'ACCEPT_BATTLE',
    payload,
    (auth) => ({ auth, opponentMemoryId })
  );
}

async function cloneHiveMemory(sourceMemoryId, note) {
  const payload = {
    memoryId: sourceMemoryId,
    ...withOptionalNote(note)
  };

  return postSigned(
    `/api/hive/memories/${encodeURIComponent(sourceMemoryId)}/clone`,
    'CLONE_HIVE_MEMORY',
    payload,
    (auth) => ({ auth, ...withOptionalNote(note) })
  );
}

async function rateHiveMemory(sourceMemoryId, score, note) {
  const payload = {
    memoryId: sourceMemoryId,
    score: Number(score),
    ...withOptionalNote(note)
  };

  return postSigned(
    `/api/hive/memories/${encodeURIComponent(sourceMemoryId)}/rate`,
    'RATE_HIVE_MEMORY',
    payload,
    (auth) => ({ auth, score: Number(score), ...withOptionalNote(note) })
  );
}

async function browseHiveMemories() {
  const u = new URL('/api/hive/memories', cfg.baseUrl);
  u.searchParams.set('agentId', cfg.agentId);
  u.searchParams.set('limit', String(cfg.hive.limit));
  if (cfg.hive.domain) u.searchParams.set('domain', cfg.hive.domain);
  if (cfg.hive.query) u.searchParams.set('q', cfg.hive.query);

  return httpJson(`${u.pathname}${u.search}`);
}

function rankHiveCandidates(memories, clonedSources) {
  const rows = (Array.isArray(memories) ? memories : [])
    .filter((m) => String(m?.state || 'active') === 'active')
    .filter((m) => String(m?.sourceAgent || '') === cfg.hive.backupAgentId)
    .filter((m) => Number(m?.weightedScore || 0) >= cfg.hive.minWeightedScore)
    .filter((m) => Number(m?.avgScore || 0) >= cfg.hive.minAvgScore)
    .filter((m) => Number(m?.ratingCount || 0) >= cfg.hive.minRatingCount)
    .filter((m) => Number(m?.heat || 0) >= cfg.hive.minHeat)
    .filter((m) => {
      if (!cfg.hive.skipIfAlreadyCloned) return true;
      return !clonedSources.has(String(m?.memoryId || ''));
    });

  rows.sort((a, b) => {
    const aw = Number(a?.weightedScore || 0);
    const bw = Number(b?.weightedScore || 0);
    if (bw !== aw) return bw - aw;
    const aa = Number(a?.avgScore || 0);
    const ba = Number(b?.avgScore || 0);
    if (ba !== aa) return ba - aa;
    const ah = Number(a?.heat || 0);
    const bh = Number(b?.heat || 0);
    if (bh !== ah) return bh - ah;
    return String(a?.memoryId || '').localeCompare(String(b?.memoryId || ''));
  });

  return rows;
}

const battleCooldown = new Map();

function recentlyHandled(battleId) {
  const until = battleCooldown.get(battleId) || 0;
  return Date.now() < until;
}

function markCooldown(battleId, ms = 20_000) {
  battleCooldown.set(battleId, Date.now() + ms);
}

function pruneCooldown() {
  const ts = Date.now();
  for (const [k, v] of battleCooldown.entries()) {
    if (v <= ts) battleCooldown.delete(k);
  }
}

async function pollAndAccept() {
  const state = await httpJson('/api/ui/state');
  const pending = Array.isArray(state.pendingBattles) ? state.pendingBattles : [];

  const candidates = pending
    .filter(isAcceptableBattle)
    .filter((b) => !recentlyHandled(String(b.battleId || '')))
    .slice(0, cfg.maxAcceptPerPoll);

  if (!candidates.length) {
    console.log(`[${new Date().toISOString()}] idle: no acceptable pending battles`);
    return;
  }

  const memories = Array.isArray(state.memories) ? state.memories : [];

  for (const battle of candidates) {
    const battleId = String(battle.battleId || '').trim();
    if (!battleId) continue;

    const chosen = pickMemoryForBattle(memories, battle);
    if (!chosen?.memoryId) {
      console.warn(`[skip] ${battleId} no active memory for ${cfg.agentId}`);
      markCooldown(battleId, 15_000);
      continue;
    }

    try {
      const result = await acceptBattle(battleId, chosen.memoryId);
      const mode = String(battle.matchMode || 'ranked');
      const openText = battle.isOpen ? 'open' : 'assigned';
      if (result?.dryRun) {
        console.log(`[dry-run] accepted ${battleId} (${openText}/${mode}) with ${chosen.memoryId}`);
      } else {
        console.log(`[ok] accepted ${battleId} (${openText}/${mode}) with ${chosen.memoryId}`);
      }
      markCooldown(battleId, 25_000);
    } catch (err) {
      console.error(`[fail] ${battleId}: ${errorText(err)}`);
      markCooldown(battleId, 40_000);
    }
  }
}

async function runHiveStrategy() {
  if (!cfg.hive.autoEnabled) return;

  const state = await httpJson('/api/ui/state');
  const clonedSources = ownClonedSourceSet(state.memories);
  const browse = await browseHiveMemories();
  const ranked = rankHiveCandidates(browse.memories, clonedSources);

  if (!ranked.length) {
    console.log(`[${new Date().toISOString()}] hive: no candidate after filters`);
    return;
  }

  const picks = ranked.slice(0, cfg.hive.cloneMaxPerRun);
  console.log(`[${new Date().toISOString()}] hive: picked ${picks.length}/${ranked.length} candidate(s)`);

  for (const item of picks) {
    const sourceMemoryId = String(item.memoryId || '').trim();
    if (!sourceMemoryId) continue;

    if (cfg.hive.skipIfAlreadyCloned && clonedSources.has(sourceMemoryId)) {
      console.log(`[hive-skip] ${sourceMemoryId} already cloned by ${cfg.agentId}`);
      continue;
    }

    const cloneNote = `${cfg.hive.cloneNote} | score=${Number(item.weightedScore || 0).toFixed(3)}`;

    try {
      const cloneResult = await cloneHiveMemory(sourceMemoryId, cloneNote);
      if (cloneResult?.dryRun) {
        console.log(`[hive-dry] clone ${sourceMemoryId} (domain=${item.domain || 'n/a'})`);
      } else {
        console.log(
          `[hive-ok] clone ${sourceMemoryId} -> ${cloneResult?.clonedMemoryId || 'unknown'} | payment=${cloneResult?.paymentTxHash || 'n/a'}`
        );
      }
      clonedSources.add(sourceMemoryId);
    } catch (err) {
      console.error(`[hive-fail] clone ${sourceMemoryId}: ${errorText(err)}`);
      continue;
    }

    if (!cfg.hive.rateEnabled) continue;

    try {
      const rateResult = await rateHiveMemory(sourceMemoryId, cfg.hive.rateScore, cfg.hive.rateNote);
      if (rateResult?.dryRun) {
        console.log(`[hive-dry] rate ${sourceMemoryId} score=${cfg.hive.rateScore}`);
      } else {
        console.log(
          `[hive-ok] rate ${sourceMemoryId} score=${cfg.hive.rateScore} | avg=${Number(rateResult?.avgScore || 0).toFixed(3)} count=${Number(rateResult?.ratingCount || 0)}`
        );
      }
    } catch (err) {
      console.error(`[hive-fail] rate ${sourceMemoryId}: ${errorText(err)}`);
    }
  }
}

let lastHiveRunMs = 0;

async function maybeRunHiveStrategy() {
  if (!cfg.hive.autoEnabled) return;

  const nowMs = Date.now();
  if (lastHiveRunMs > 0 && nowMs - lastHiveRunMs < cfg.hive.intervalSec * 1000) return;
  lastHiveRunMs = nowMs;

  try {
    await runHiveStrategy();
  } catch (err) {
    console.error(`[hive-loop-fail] ${errorText(err)}`);
  }
}

async function tick() {
  pruneCooldown();
  await pollAndAccept();
  await maybeRunHiveStrategy();
}

console.log('[start] EvoHive remote agent');
console.log(`  baseUrl=${cfg.baseUrl}`);
console.log(`  agentId=${cfg.agentId}`);
console.log(`  acceptOpenOnly=${cfg.acceptOpenOnly}`);
console.log(`  pollIntervalSec=${cfg.pollIntervalSec}`);
console.log(`  dryRun=${cfg.dryRun}`);
console.log(`  hive.autoEnabled=${cfg.hive.autoEnabled}`);
if (cfg.hive.autoEnabled) {
  console.log(`  hive.intervalSec=${cfg.hive.intervalSec}`);
  console.log(`  hive.cloneMaxPerRun=${cfg.hive.cloneMaxPerRun}`);
  console.log(`  hive.rateEnabled=${cfg.hive.rateEnabled}`);
}

await tick().catch((err) => {
  console.error(`[startup-fail] ${errorText(err)}`);
});

const intervalMs = cfg.pollIntervalSec * 1000;
setInterval(async () => {
  try {
    await tick();
  } catch (err) {
    console.error(`[loop-fail] ${errorText(err)}`);
  }
}, intervalMs);
