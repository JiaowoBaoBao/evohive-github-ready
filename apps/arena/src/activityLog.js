import { db, now } from './db.js';

export function addActivity({ agentId = null, action, message, hash = null, hashType = null, meta = null }) {
  db.prepare(
    `INSERT INTO activity_logs (ts, agent_id, action, message, hash, hash_type, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(now(), agentId, action, message, hash, hashType, meta ? JSON.stringify(meta) : null);
}

export function listActivities(options = 200) {
  const opts = typeof options === 'number' ? { limit: options } : options || {};
  const n = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  const afterId = Math.max(0, Number(opts.afterId) || 0);

  let rows = [];
  if (afterId > 0) {
    rows = db
      .prepare(
        `SELECT id, ts, agent_id AS agentId, action, message, hash, hash_type AS hashType, meta_json AS metaJson
         FROM activity_logs
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(afterId, n);
  } else {
    rows = db
      .prepare(
        `SELECT id, ts, agent_id AS agentId, action, message, hash, hash_type AS hashType, meta_json AS metaJson
         FROM activity_logs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(n)
      .reverse();
  }

  return rows.map((r) => ({
    ...r,
    meta: r.metaJson ? safeParse(r.metaJson) : null
  }));
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
