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

const baseUrl = process.env.EVOHIVE_URL || `http://localhost:${process.env.PORT || 4310}`;
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
  const mode = signatureMode;
  if (mode === 'eip712') {
    throw new Error('AUTH_SIGNATURE_MODE=eip712 is not supported by demo script; use npm run sign-eip712 flow');
  }

  const wantsHmac = mode === 'hmac' || (mode === 'auto' && Boolean(resolveHmacSecret(auth)));
  if (wantsHmac) {
    const secret = resolveHmacSecret(auth);
    if (!secret) {
      throw new Error('AUTH_SIGNATURE_MODE requires HMAC secret but none configured');
    }
    auth.signature = `0x${crypto.createHmac('sha256', secret).update(canonicalAuthForSignature(auth)).digest('hex')}`;
    return auth;
  }

  auth.signature = '0xdemo-signature';
  return auth;
}

function auth(agentId, action, payload, requestId) {
  const now = Math.floor(Date.now() / 1000);
  const out = {
    requestId,
    agentId,
    action,
    payloadHash: payloadHash(payload),
    issuedAt: now,
    deadline: now + 120,
    arenaId,
    chainId,
    ...(authDefaultKeyId ? { keyId: authDefaultKeyId } : {})
  };
  return applySignature(out);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

(async () => {
  console.log('Running EvoHive demo flow...');
  const nonce = Date.now();

  // Step 1: transfer memory ownership (agent-a -> agent-b)
  const transfer1Payload = { memoryId: 'mem_spot_a1', toAgentId: 'agent-b', note: 'demo handoff A->B' };
  const transfer1 = await post('/api/memories/transfer', {
    auth: auth('agent-a', 'TRANSFER_MEMORY', transfer1Payload, `01JDEMOTRANSFER1${nonce}`),
    ...transfer1Payload
  });
  console.log('transfer1 =>', transfer1.memoryId, `${transfer1.fromAgent} -> ${transfer1.toAgent}`);

  // Step 2: transfer a counter-memory so the new opponent can accept battle (agent-b -> agent-a)
  const transfer2Payload = { memoryId: 'mem_spot_b1', toAgentId: 'agent-a', note: 'demo handoff B->A' };
  const transfer2 = await post('/api/memories/transfer', {
    auth: auth('agent-b', 'TRANSFER_MEMORY', transfer2Payload, `01JDEMOTRANSFER2${nonce}`),
    ...transfer2Payload
  });
  console.log('transfer2 =>', transfer2.memoryId, `${transfer2.fromAgent} -> ${transfer2.toAgent}`);

  // Step 3: new owner (agent-b) uses transferred memory to challenge
  const challengePayload = {
    challengerMemoryId: 'mem_spot_a1',
    opponentAgentId: 'agent-a',
    rounds: 10,
    benchmarkVersion: 'bench-v1.2',
    timeframe: '1m',
    symbolSet: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']
  };

  const challenge = await post('/api/battles/challenge', {
    auth: auth('agent-b', 'CHALLENGE_BATTLE', challengePayload, `01JDEMOCHALLENGE${nonce}`),
    ...challengePayload
  });
  console.log('challenge =>', challenge.battleId);

  // Step 4: opponent accepts with its own memory
  const acceptPayload = { battleId: challenge.battleId, opponentMemoryId: 'mem_spot_b1' };
  await post(`/api/battles/${challenge.battleId}/accept`, {
    auth: auth('agent-a', 'ACCEPT_BATTLE', acceptPayload, `01JDEMOACCEPT${nonce}`),
    opponentMemoryId: 'mem_spot_b1'
  });
  console.log('accept => ok');

  const acceptLockSec = Number(challenge?.config?.acceptLockSec || 10);
  await sleep((acceptLockSec + 1) * 1000);

  const runPayload = { battleId: challenge.battleId, mode: 'paper-realtime' };
  const run = await post(`/api/battles/${challenge.battleId}/run`, {
    auth: auth('arena-agent', 'RUN_BATTLE', runPayload, `01JDEMORUN${nonce}`),
    mode: 'paper-realtime'
  });
  console.log('run winner =>', run.winner, 'eventTx =>', run.eventTxHash);

  if (String(process.env.DEMO_SKIP_PREMIUM || '').toLowerCase() !== 'true') {
    const premiumPayload = { scope: 'domain', domain: 'spot' };
    const premiumAuth = auth('agent-c', 'GET_PREMIUM_BUFF', premiumPayload, `01JDEMOPREMIUM${nonce}`);

    const system = await get('/api/system/status').catch(() => null);
    const needRiskToken = Boolean(system?.security?.riskConfirmation?.enabled) &&
      Array.isArray(system?.security?.riskConfirmation?.actions) &&
      system.security.riskConfirmation.actions.includes('GET_PREMIUM_BUFF');

    if (needRiskToken) {
      const tokenResp = await post('/api/security/risk-token', {
        action: 'GET_PREMIUM_BUFF',
        requestId: premiumAuth.requestId,
        payloadHash: premiumAuth.payloadHash
      });
      premiumAuth.riskToken = tokenResp.token;
    }

    const premium = await post('/api/hive/buffs/premium', {
      auth: premiumAuth,
      scope: 'domain',
      domain: 'spot'
    });
    console.log('premium burn =>', premium.burnTxHash);
  } else {
    console.log('premium step skipped (DEMO_SKIP_PREMIUM=true)');
  }

  console.log('\nDemo complete.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
