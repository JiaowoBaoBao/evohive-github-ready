import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const envPath = process.env.EVOHIVE_ENV_PATH || '.env';
dotenv.config({ path: envPath });

function readSecret(primary, filePath) {
  const p = String(primary || '').trim();
  if (p) return p;
  const fp = String(filePath || '').trim();
  if (!fp) return '';
  try {
    const fullPath = path.isAbsolute(fp) ? fp : path.resolve(path.dirname(path.resolve(envPath)), fp);
    return String(fs.readFileSync(fullPath, 'utf8')).trim();
  } catch {
    return '';
  }
}

const baseUrl = process.env.EVOHIVE_URL || `http://127.0.0.1:${process.env.PORT || 4310}`;
const arenaId = process.env.ARENA_ID || 'arena-main';
const chainId = Number(process.env.CHAIN_ID || 196);
const signatureMode = String(process.env.AUTH_SIGNATURE_MODE || 'auto').trim().toLowerCase();
const signatureSecret = readSecret(process.env.EVOHIVE_AUTH_SECRET || '', process.env.EVOHIVE_AUTH_SECRET_FILE || '');
const authDefaultKeyId = String(process.env.EVOHIVE_AUTH_DEFAULT_KEY_ID || '').trim();
const hmacKeyring = String(process.env.EVOHIVE_AUTH_KEYRING || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
  .reduce((acc, pair) => {
    const idx = pair.indexOf(':');
    if (idx <= 0) return acc;
    const keyId = pair.slice(0, idx).trim();
    const secret = pair.slice(idx + 1).trim();
    if (keyId && secret) acc[keyId] = secret;
    return acc;
  }, {});

const attempts = Math.max(1, Math.min(20, Number(process.env.EVENT_CHECK_ATTEMPTS || 2)));
const requireLive = String(process.env.EVENT_CHECK_REQUIRE_LIVE || 'true').toLowerCase() !== 'false';
const outDir = path.resolve(process.cwd(), 'output');
fs.mkdirSync(outDir, { recursive: true });

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function payloadHash(payload) {
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

function resolveHmacSecret(auth) {
  const keyId = String(auth.keyId || '').trim();
  if (keyId && hmacKeyring[keyId]) return hmacKeyring[keyId];
  return signatureSecret || '';
}

function applySignature(auth) {
  if (signatureMode === 'eip712') {
    throw new Error('AUTH_SIGNATURE_MODE=eip712 is not supported by event-check script; use npm run sign-eip712 flow');
  }

  const wantsHmac = signatureMode === 'hmac' || (signatureMode === 'auto' && Boolean(resolveHmacSecret(auth)));
  if (wantsHmac) {
    const secret = resolveHmacSecret(auth);
    if (!secret) throw new Error('AUTH_SIGNATURE_MODE requires HMAC secret but none configured');
    auth.signature = `0x${crypto.createHmac('sha256', secret).update(canonicalAuthForSignature(auth)).digest('hex')}`;
    return auth;
  }

  auth.signature = '0xevent-check';
  return auth;
}

function makeAuth(agentId, action, payload, requestId) {
  const ts = Math.floor(Date.now() / 1000);
  const out = {
    requestId,
    agentId,
    action,
    payloadHash: payloadHash(payload),
    issuedAt: ts,
    deadline: ts + 120,
    arenaId,
    chainId,
    ...(authDefaultKeyId ? { keyId: authDefaultKeyId } : {})
  };
  return applySignature(out);
}

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`${pathname} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function get(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`${pathname} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function runOne(index) {
  const nonce = `${Date.now()}-${index}`;
  const memory = {
    memoryId: `mem-event-check-${nonce}`,
    domain: 'spot',
    symbolSet: ['BTCUSDT', 'ETHUSDT'],
    timeframe: '15m',
    riskProfile: 'mid',
    benchmarkVersion: 'event-check-v1',
    featureVersion: 'event-check-v1',
    contentHash: `0x${crypto.randomBytes(16).toString('hex')}`,
    ttlDays: 30
  };

  const payload = { memory };
  const auth = makeAuth('agent-a', 'COMMIT_MEMORY', payload, `01JEVENTCHECK${nonce.replace(/[^0-9]/g, '')}`);
  const commit = await post('/api/memories/commit', { auth, memory });

  return {
    index,
    memoryId: commit.memoryId,
    eventTxHash: commit.eventTxHash,
    eventSource: commit.eventSource || null,
    eventTxLive: Boolean(commit.eventTxLive),
    eventMode: commit.eventMode || null,
    eventTarget: commit.eventTarget || null,
    ok: Boolean(commit.ok ?? true)
  };
}

(async () => {
  const startedAt = new Date().toISOString();
  const systemBefore = await get('/api/system/status');

  const runs = [];
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const one = await runOne(i);
      runs.push(one);
      console.log(`event-check #${i}: source=${one.eventSource} live=${one.eventTxLive} mode=${one.eventMode}`);
    } catch (err) {
      runs.push({
        index: i,
        ok: false,
        error: String(err?.message || err)
      });
      console.log(`event-check #${i}: failed ${String(err?.message || err)}`);
    }
  }

  const logs = await get('/api/ui/logs?limit=100');
  const latestCommits = (logs.logs || [])
    .filter((l) => l.action === 'MEMORY_COMMIT' && String(l.meta?.memoryId || '').startsWith('mem-event-check-'))
    .slice(-attempts)
    .map((l) => ({
      ts: l.ts,
      memoryId: l.meta?.memoryId || null,
      source: l.meta?.source || null,
      hashLive: Boolean(l.meta?.hashLive),
      eventMode: l.meta?.eventMode || null,
      sourceError: l.meta?.sourceError || null,
      hash: l.hash || null
    }));

  const successLive = runs.filter((r) => r.ok && r.eventTxLive).length;
  const successAny = runs.filter((r) => r.ok).length;

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl,
    attempts,
    requireLive,
    summary: {
      successAny,
      successLive,
      failed: runs.length - successAny,
      pass: requireLive ? successLive === attempts : successAny === attempts
    },
    runtime: {
      onchainMode: systemBefore?.runtime?.onchainMode || null,
      event: systemBefore?.onchain?.event || null,
      circuit: systemBefore?.onchain?.circuit?.event || null
    },
    runs,
    latestCommits
  };

  const stamp = new Date().toISOString().replaceAll(':', '-');
  const outFile = path.join(outDir, `event-check-${stamp}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Event check report: ${outFile}`);

  if (!report.summary.pass) process.exit(1);
})();
