import crypto from 'node:crypto';
import { getAddress, isHexString, verifyTypedData } from 'ethers';
import { db, now } from './db.js';
import { config } from './config.js';

const EIP712_TYPES = {
  AuthEnvelope: [
    { name: 'requestId', type: 'string' },
    { name: 'agentId', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'arenaId', type: 'string' },
    { name: 'chainId', type: 'uint256' }
  ]
};

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
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

function normalizeHex(value) {
  const v = String(value || '').toLowerCase();
  return v.startsWith('0x') ? v.slice(2) : v;
}

function normalizeAddress(value) {
  try {
    return getAddress(String(value || '')).toLowerCase();
  } catch {
    return '';
  }
}

function isBytes32Hex(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''));
}

function timingSafeHexEq(a, b) {
  const aa = normalizeHex(a);
  const bb = normalizeHex(b);
  if (!aa || !bb || aa.length !== bb.length || aa.length % 2 !== 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(aa, 'hex'), Buffer.from(bb, 'hex'));
  } catch {
    return false;
  }
}

function resolveHmacSecret(auth) {
  const keyId = String(auth.keyId || '').trim();
  if (keyId && config.hmacKeyring[keyId]) return config.hmacKeyring[keyId];
  if (config.signatureSecret) return config.signatureSecret;
  return '';
}

function verifyHmacSignature(auth, signature) {
  const secret = resolveHmacSecret(auth);
  if (!secret) return false;
  const expected = `0x${crypto.createHmac('sha256', secret).update(canonicalAuthForSignature(auth)).digest('hex')}`;
  return timingSafeHexEq(signature, expected);
}

function allowedEip712Signers() {
  const set = new Set();
  const expected = normalizeAddress(config.eip712.expectedSigner);
  if (expected) set.add(expected);
  for (const s of config.eip712.allowedSigners || []) {
    const n = normalizeAddress(s);
    if (n) set.add(n);
  }
  return set;
}

function verifyEip712Signature(auth, signature) {
  const allowed = allowedEip712Signers();
  if (!allowed.size) return false;
  if (!isHexString(signature)) return false;
  if (!isBytes32Hex(auth.payloadHash)) return false;

  try {
    const recovered = verifyTypedData(
      {
        name: config.eip712.name,
        version: config.eip712.version,
        chainId: Number(auth.chainId),
        verifyingContract: config.eip712.verifyingContract
      },
      EIP712_TYPES,
      {
        requestId: String(auth.requestId),
        agentId: String(auth.agentId),
        action: String(auth.action),
        payloadHash: String(auth.payloadHash),
        issuedAt: BigInt(auth.issuedAt),
        deadline: BigInt(auth.deadline),
        arenaId: String(auth.arenaId),
        chainId: BigInt(auth.chainId)
      },
      signature
    );

    return allowed.has(normalizeAddress(recovered));
  } catch {
    return false;
  }
}

function resolvedSignatureMode() {
  const mode = String(config.authSignatureMode || 'auto').toLowerCase();
  if (mode === 'legacy' || mode === 'hmac' || mode === 'eip712') return mode;
  return 'auto';
}

function isProductionRuntime() {
  const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
  return env === 'production' || env === 'prod';
}

export function signaturePolicyStatus() {
  const mode = resolvedSignatureMode();
  const strictInProd = Boolean(config.security.strictSignatureInProd);
  const prod = isProductionRuntime();
  const allowedModes = new Set((config.security.strictSignatureAllowedModes || []).map((x) => String(x || '').trim().toLowerCase()));
  const hasEip712 = allowedEip712Signers().size > 0;
  const hasHmac = Boolean(config.signatureSecret) || Object.keys(config.hmacKeyring || {}).length > 0;

  const effectiveMode = mode === 'auto' ? (hasEip712 ? 'eip712' : hasHmac ? 'hmac' : 'legacy') : mode;

  const issues = [];
  const warnings = [];
  if (prod && strictInProd) {
    if (!allowedModes.has(mode)) {
      issues.push(`SIGNATURE_MODE_NOT_ALLOWED_IN_PROD:${mode}`);
    }
    if (mode === 'eip712' && !hasEip712) {
      issues.push('EIP712_SIGNER_NOT_CONFIGURED');
    }
    if (mode === 'hmac' && !hasHmac) {
      issues.push('HMAC_SECRET_NOT_CONFIGURED');
    }
  } else {
    if (effectiveMode === 'legacy') {
      warnings.push('WEAK_SIGNATURE_MODE_LEGACY_EFFECTIVE');
    }
  }

  return {
    mode,
    effectiveMode,
    production: prod,
    strictInProd,
    allowedModes: [...allowedModes],
    hasEip712,
    hasHmac,
    ok: issues.length === 0,
    issues,
    warnings
  };
}

export function hashPayload(payload) {
  return `0x${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

export function verifySignature(auth) {
  const signature = String(auth.signature || '').trim();
  if (!signature) return false;

  const mode = resolvedSignatureMode();
  const policy = signaturePolicyStatus();

  if (policy.production && policy.strictInProd && !policy.ok && config.security.strictSignatureFailClosed) {
    return false;
  }

  if (mode === 'legacy') {
    if (policy.production && policy.strictInProd && config.security.strictSignatureFailClosed) return false;
    return true;
  }
  if (mode === 'hmac') {
    return verifyHmacSignature(auth, signature);
  }
  if (mode === 'eip712') {
    return verifyEip712Signature(auth, signature);
  }

  // auto mode: prefer strict auth if configured.
  const hasEip712 = allowedEip712Signers().size > 0;
  const hasHmac = Boolean(config.signatureSecret) || Object.keys(config.hmacKeyring || {}).length > 0;

  if (hasEip712 && verifyEip712Signature(auth, signature)) return true;
  if (hasHmac && verifyHmacSignature(auth, signature)) return true;

  // In production strict mode, auto fallback is disallowed.
  if (policy.production && policy.strictInProd && config.security.strictSignatureFailClosed) {
    return false;
  }

  // If no strict mode configured, keep local demo compatibility.
  if (!hasEip712 && !hasHmac) {
    return true;
  }

  return false;
}

export function validateAuthEnvelope(auth, expectedAction, expectedPayloadHash) {
  const ts = now();

  if (auth.action !== expectedAction) {
    throw new Error(`ACTION_MISMATCH: expected ${expectedAction}`);
  }
  if (auth.payloadHash !== expectedPayloadHash) {
    throw new Error('PAYLOAD_HASH_MISMATCH');
  }
  if (auth.arenaId !== config.arenaId) {
    throw new Error('ARENA_MISMATCH');
  }
  if (auth.chainId !== config.chainId) {
    throw new Error('CHAIN_MISMATCH');
  }
  if (auth.deadline <= auth.issuedAt) {
    throw new Error('DEADLINE_NOT_AFTER_ISSUED_AT');
  }

  const ttl = auth.deadline - auth.issuedAt;
  if (ttl > config.requestTtlSec) {
    throw new Error('REQUEST_TTL_EXCEEDED');
  }

  if (auth.issuedAt > ts + config.authIssuedAtSkewSec) {
    throw new Error('REQUEST_FROM_FUTURE');
  }
  if (ts > auth.deadline) {
    throw new Error('REQUEST_EXPIRED');
  }

  if (!verifySignature(auth)) {
    throw new Error('BAD_SIGNATURE');
  }
}

export function beginIdempotent(auth) {
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO idempotency_requests (
      request_id, agent_id, action, payload_hash, deadline, status, key_id, namespace, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)
  `);

  try {
    stmt.run(
      auth.requestId,
      auth.agentId,
      auth.action,
      auth.payloadHash,
      auth.deadline,
      auth.keyId || null,
      auth.namespace || null,
      ts,
      ts
    );
    return { replay: false };
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) throw err;
    const row = db.prepare('SELECT status, response_json FROM idempotency_requests WHERE request_id = ?').get(auth.requestId);
    if (!row) throw err;
    return {
      replay: true,
      status: row.status,
      response: row.response_json ? JSON.parse(row.response_json) : null
    };
  }
}

export function endIdempotent(requestId, response, status = 'done') {
  db.prepare(`
    UPDATE idempotency_requests
    SET status = ?, response_json = ?, updated_at = ?
    WHERE request_id = ?
  `).run(status, JSON.stringify(response), now(), requestId);
}
