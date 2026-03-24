import crypto from 'node:crypto';
import { db, now } from './db.js';
import { config } from './config.js';

const SENSITIVE_ENV_KEYS = [
  'OKX_API_KEY',
  'OKX_SECRET_KEY',
  'OKX_PASSPHRASE',
  'ONCHAINOS_API_KEY',
  'EVOHIVE_AUTH_SECRET'
];

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function createRiskToken({ action, requestId = null, payloadHash = null }) {
  const token = randomToken();
  const ts = now();
  const expiresAt = ts + Math.max(30, Number(config.security.riskTokenTtlSec) || 180);

  db.prepare(
    `INSERT INTO risk_confirmations (token, action, request_id, payload_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, action, requestId, payloadHash, expiresAt, ts);

  return { token, expiresAt };
}

export function requireRiskConfirmation(action, auth, payloadHash) {
  if (!config.security.requireRiskConfirmation) return;
  if (!config.security.riskActions.includes(action)) return;

  const token = String(auth?.riskToken || '').trim();
  if (!token) {
    throw new Error('RISK_CONFIRMATION_REQUIRED:missing_token');
  }

  const row = db
    .prepare(
      `SELECT token, action, request_id AS requestId, payload_hash AS payloadHash, expires_at AS expiresAt, consumed_at AS consumedAt
       FROM risk_confirmations WHERE token = ?`
    )
    .get(token);

  if (!row) throw new Error('RISK_CONFIRMATION_REQUIRED:token_not_found');
  if (row.consumedAt) throw new Error('RISK_CONFIRMATION_REQUIRED:token_already_used');
  if (row.action !== action) throw new Error('RISK_CONFIRMATION_REQUIRED:action_mismatch');
  if (row.expiresAt < now()) throw new Error('RISK_CONFIRMATION_REQUIRED:token_expired');
  if (row.requestId && row.requestId !== auth.requestId) throw new Error('RISK_CONFIRMATION_REQUIRED:request_mismatch');
  if (row.payloadHash && row.payloadHash !== payloadHash) throw new Error('RISK_CONFIRMATION_REQUIRED:payload_mismatch');

  db.prepare(`UPDATE risk_confirmations SET consumed_at=? WHERE token=?`).run(now(), token);
}

export function securitySummary() {
  const inlinePresent = SENSITIVE_ENV_KEYS.filter((k) => String(process.env[k] || '').trim().length > 0);
  const fileBacked = {
    onchainApiKeyFile: String(process.env.ONCHAINOS_API_KEY_FILE || '').trim() || null,
    evohiveAuthSecretFile: String(process.env.EVOHIVE_AUTH_SECRET_FILE || '').trim() || null,
    okxApiKeyFile: String(process.env.OKX_API_KEY_FILE || '').trim() || null,
    okxSecretKeyFile: String(process.env.OKX_SECRET_KEY_FILE || '').trim() || null,
    okxPassphraseFile: String(process.env.OKX_PASSPHRASE_FILE || '').trim() || null
  };

  return {
    inlineSensitiveEnvKeys: inlinePresent,
    fileBacked,
    riskConfirmation: {
      enabled: Boolean(config.security.requireRiskConfirmation),
      actions: config.security.riskActions,
      tokenTtlSec: config.security.riskTokenTtlSec
    },
    ui: {
      panelAuthSignerEnabled: Boolean(config.ui.panelAuthSignerEnabled),
      panelAuthSignerLocalOnly: Boolean(config.ui.panelAuthSignerLocalOnly)
    }
  };
}
