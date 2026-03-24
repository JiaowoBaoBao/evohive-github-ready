import crypto from 'node:crypto';
import { db, now } from './db.js';
import { config } from './config.js';

const circuit = {
  verify: { failures: 0, openUntil: 0, lastError: null },
  burn: { failures: 0, openUntil: 0, lastError: null },
  event: { failures: 0, openUntil: 0, lastError: null }
};

const faultCounters = {};

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function dedupeKey(action, payload) {
  return crypto.createHash('sha256').update(`${action}:${stableStringify(payload || {})}`).digest('hex');
}

export function classifyOnchainError(errorText) {
  const t = String(errorText || '').toLowerCase();
  if (!t) return 'other';

  if (
    t.includes('timed out') ||
    t.includes('timeout') ||
    t.includes('econnreset') ||
    t.includes('connection reset') ||
    t.includes('tls handshake') ||
    t.includes('ssl_error_syscall') ||
    t.includes('recv failure') ||
    t.includes('fetch failed') ||
    t.includes('socket hang up') ||
    t.includes('eof') ||
    t.includes('onchainos_http_5') ||
    t.includes('gateway timeout') ||
    t.includes('service unavailable')
  ) {
    return 'network';
  }

  if (
    t.includes('missing') ||
    t.includes('invalid') ||
    t.includes('bad_signature') ||
    t.includes('mismatch') ||
    t.includes('module_not_found') ||
    t.includes('unsupported_action') ||
    t.includes('unsupported_event') ||
    t.includes('x402_config_missing') ||
    t.includes('onchainos_base_url_missing')
  ) {
    return 'config';
  }

  if (
    t.includes('risk_confirmation_required') ||
    t.includes('insufficient') ||
    t.includes('revert') ||
    t.includes('nonce too low') ||
    t.includes('execution reverted') ||
    t.includes('permission denied')
  ) {
    return 'unrecoverable';
  }

  return 'other';
}

export function shouldEnqueueOnchainError(errorText) {
  const t = String(errorText || '').toLowerCase();
  if (!t) return false;

  const kind = classifyOnchainError(t);
  if (kind === 'config') return false;

  // Non-recoverable runtime/user-state issues should not flood queue.
  if (t.includes('risk_confirmation_required') || t.includes('bad_signature')) {
    return false;
  }

  return true;
}

export function circuitSnapshot() {
  const ts = now();
  return Object.fromEntries(
    Object.entries(circuit).map(([k, v]) => [
      k,
      {
        failures: v.failures,
        openUntil: v.openUntil,
        open: ts < v.openUntil,
        lastError: v.lastError
      }
    ])
  );
}

export function assertCircuit(action) {
  const state = circuit[action];
  if (!state) return;
  const ts = now();
  if (ts < state.openUntil) {
    throw new Error(`CIRCUIT_OPEN:${action}:retry_after=${state.openUntil - ts}s`);
  }
}

export function markOnchainSuccess(action) {
  const state = circuit[action];
  if (!state) return;
  state.failures = 0;
  state.openUntil = 0;
  state.lastError = null;
}

export function markOnchainFailure(action, errorText) {
  const state = circuit[action];
  if (!state) return;
  state.failures += 1;
  state.lastError = String(errorText || 'unknown');
  if (state.failures >= config.onchain.resilience.circuitFailThreshold) {
    state.openUntil = now() + config.onchain.resilience.circuitOpenSec;
  }
}

export function nextBackoffMs(attempt) {
  const base = Math.max(50, Number(config.onchain.resilience.baseBackoffMs) || 400);
  const max = Math.max(base, Number(config.onchain.resilience.maxBackoffMs) || 8000);
  const jitterRatio = Math.max(0, Math.min(1, Number(config.onchain.resilience.jitterRatio) || 0.2));
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * jitterRatio * Math.random();
  return Math.floor(Math.min(max, exp + jitter));
}

export function enqueueOnchainRetry(action, payload, errorText, delaySec = 15) {
  const ts = now();
  const nextRetryAt = ts + Math.max(1, Number(delaySec) || 15);
  const key = dedupeKey(action, payload);

  try {
    const inserted = db
      .prepare(
        `INSERT INTO onchain_retry_jobs
          (action, payload_json, dedupe_key, status, attempts, last_error, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      )
      .run(action, JSON.stringify(payload || {}), key, String(errorText || ''), nextRetryAt, ts, ts).lastInsertRowid;

    return { enqueued: true, id: inserted, dedupeKey: key };
  } catch (err) {
    if (!String(err?.message || '').includes('UNIQUE')) throw err;

    const row = db
      .prepare(
        `SELECT id, next_retry_at AS nextRetryAt
         FROM onchain_retry_jobs
         WHERE dedupe_key = ? AND status IN ('pending','running')
         ORDER BY id DESC LIMIT 1`
      )
      .get(key);

    if (row) {
      db.prepare(
        `UPDATE onchain_retry_jobs
         SET status='pending', last_error=?, next_retry_at=?, updated_at=?
         WHERE id=?`
      ).run(String(errorText || ''), Math.min(row.nextRetryAt || nextRetryAt, nextRetryAt), ts, row.id);
      return { enqueued: false, id: row.id, dedupeKey: key };
    }

    return { enqueued: false, id: null, dedupeKey: key };
  }
}

export function leaseOnchainRetryJobs(limit = 20) {
  const ts = now();
  const n = Math.max(1, Math.min(200, Number(limit) || 20));

  // Recover stale running jobs.
  db.prepare(
    `UPDATE onchain_retry_jobs
     SET status='pending', updated_at=?
     WHERE status='running' AND updated_at < ?`
  ).run(ts, ts - 600);

  const jobs = db
    .prepare(
      `SELECT id, action, payload_json AS payloadJson, attempts
       FROM onchain_retry_jobs
       WHERE status = 'pending' AND next_retry_at <= ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(ts, n);

  for (const j of jobs) {
    db.prepare(`UPDATE onchain_retry_jobs SET status='running', updated_at=? WHERE id=?`).run(ts, j.id);
  }

  return jobs.map((j) => ({
    id: j.id,
    action: j.action,
    attempts: j.attempts,
    payload: (() => {
      try {
        return JSON.parse(j.payloadJson || '{}');
      } catch {
        return {};
      }
    })()
  }));
}

export function completeOnchainRetryJob(id) {
  db.prepare(`UPDATE onchain_retry_jobs SET status='done', updated_at=? WHERE id=?`).run(now(), id);
}

export function failOnchainRetryJob(id, attempts, errorText) {
  const nextDelay = Math.min(300, 10 * 2 ** Math.min(6, attempts));
  const ts = now();
  const terminal = attempts >= 8;
  db.prepare(
    `UPDATE onchain_retry_jobs
     SET status=?, attempts=?, last_error=?, next_retry_at=?, updated_at=?
     WHERE id=?`
  ).run(terminal ? 'failed' : 'pending', attempts, String(errorText || ''), ts + nextDelay, ts, id);
}

export function quarantineNonRetryablePending(limit = 500) {
  const rows = db
    .prepare(
      `SELECT id, last_error AS lastError
       FROM onchain_retry_jobs
       WHERE status='pending'
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(Math.max(1, Math.min(5000, Number(limit) || 500)));

  let moved = 0;
  const movedByType = { config: 0, network: 0, unrecoverable: 0, other: 0 };
  const ts = now();
  for (const r of rows) {
    if (!shouldEnqueueOnchainError(r.lastError || '')) {
      db.prepare(`UPDATE onchain_retry_jobs SET status='failed', updated_at=? WHERE id=?`).run(ts, r.id);
      moved += 1;
      const kind = classifyOnchainError(r.lastError || '');
      movedByType[kind] = (movedByType[kind] || 0) + 1;
    }
  }
  return { scanned: rows.length, moved, movedByType };
}

export function archiveFailedRetryJobs(options = {}) {
  if (!config.ops.failedArchiveEnabled) {
    return { scanned: 0, archived: 0, archivedByType: {}, retentionDays: Number(config.ops.failedRetentionDays || 0), cutoffTs: null };
  }

  const retentionDays = Math.max(0, Number(options.retentionDays ?? config.ops.failedRetentionDays) || 0);
  if (!retentionDays) {
    return { scanned: 0, archived: 0, archivedByType: {}, retentionDays, cutoffTs: null };
  }

  const batch = Math.max(1, Math.min(5000, Number(options.limit ?? config.ops.failedArchiveBatch) || 500));
  const cutoffTs = now() - retentionDays * 86400;
  const rows = db
    .prepare(
      `SELECT id, action, payload_json AS payloadJson, attempts, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt
       FROM onchain_retry_jobs
       WHERE status='failed' AND updated_at <= ?
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(cutoffTs, batch);

  if (!rows.length) {
    return { scanned: 0, archived: 0, archivedByType: {}, retentionDays, cutoffTs };
  }

  const archivedAt = now();
  const insertArchive = db.prepare(
    `INSERT INTO onchain_retry_failed_archive
      (original_job_id, action, payload_json, attempts, last_error, error_type, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const deleteSource = db.prepare(`DELETE FROM onchain_retry_jobs WHERE id=?`);

  const archivedByType = { config: 0, network: 0, unrecoverable: 0, other: 0 };

  const run = db.transaction((items) => {
    for (const r of items) {
      const kind = classifyOnchainError(r.lastError || '');
      insertArchive.run(
        r.id,
        r.action,
        r.payloadJson || '{}',
        Number(r.attempts || 0),
        r.lastError || null,
        kind,
        Number(r.createdAt || archivedAt),
        Number(r.updatedAt || archivedAt),
        archivedAt
      );
      deleteSource.run(r.id);
      archivedByType[kind] = (archivedByType[kind] || 0) + 1;
    }
  });

  run(rows);

  return {
    scanned: rows.length,
    archived: rows.length,
    archivedByType,
    retentionDays,
    cutoffTs
  };
}

export function retryQueueStats() {
  const pending = db.prepare(`SELECT COUNT(*) c FROM onchain_retry_jobs WHERE status='pending'`).get().c;
  const running = db.prepare(`SELECT COUNT(*) c FROM onchain_retry_jobs WHERE status='running'`).get().c;
  const failed = db.prepare(`SELECT COUNT(*) c FROM onchain_retry_jobs WHERE status='failed'`).get().c;
  const done = db.prepare(`SELECT COUNT(*) c FROM onchain_retry_jobs WHERE status='done'`).get().c;
  const oldestPendingTs = db.prepare(`SELECT MIN(created_at) ts FROM onchain_retry_jobs WHERE status='pending'`).get().ts;
  const oldestFailedTs = db.prepare(`SELECT MIN(updated_at) ts FROM onchain_retry_jobs WHERE status='failed'`).get().ts;

  const failedRows = db
    .prepare(`SELECT last_error AS lastError FROM onchain_retry_jobs WHERE status='failed' ORDER BY id DESC LIMIT 5000`)
    .all();

  const failedByType = { config: 0, network: 0, unrecoverable: 0, other: 0 };
  for (const r of failedRows) {
    const kind = classifyOnchainError(r.lastError || '');
    failedByType[kind] = (failedByType[kind] || 0) + 1;
  }

  return {
    pending,
    running,
    failed,
    done,
    failedByType,
    oldestPendingAgeSec: oldestPendingTs ? Math.max(0, now() - oldestPendingTs) : 0,
    oldestFailedAgeSec: oldestFailedTs ? Math.max(0, now() - oldestFailedTs) : 0
  };
}

export function maybeInjectFault(action) {
  const inject = config.onchain.faultInject || {};
  const budget = Number(inject[action] || 0);
  if (!budget) return;
  const key = String(action);
  faultCounters[key] = (faultCounters[key] || 0) + 1;
  if (faultCounters[key] <= budget) {
    throw new Error(`FAULT_INJECTED:${action}:attempt=${faultCounters[key]}`);
  }
}
