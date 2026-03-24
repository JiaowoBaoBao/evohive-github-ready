import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const absolutePath = path.isAbsolute(config.dbPath)
  ? config.dbPath
  : path.resolve(projectRoot, config.dbPath);
fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

export const db = new DatabaseSync(absolutePath);
db.exec('PRAGMA journal_mode = WAL;');

function ensureColumn(tableName, columnName, columnDef) {
  const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
  const rows = stmt.all();
  const has = rows.some((r) => r.name === columnName);
  if (!has) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS idempotency_requests (
  request_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  status TEXT NOT NULL,
  key_id TEXT,
  namespace TEXT,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  symbol_set TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  risk_profile TEXT NOT NULL,
  benchmark_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  cid TEXT,
  memory_type TEXT NOT NULL DEFAULT 'semantic',
  memory_sub_type TEXT,
  tags_json TEXT,
  classifier_confidence REAL NOT NULL DEFAULT 0,
  encrypted_uri TEXT,
  encrypted_uri_hash TEXT,
  strategy_body TEXT,
  strategy_note TEXT,
  source_agent TEXT NOT NULL,
  fitness REAL NOT NULL DEFAULT 0.5,
  state TEXT NOT NULL DEFAULT 'active',
  ttl_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS battles (
  battle_id TEXT PRIMARY KEY,
  challenger_agent TEXT NOT NULL,
  opponent_agent TEXT NOT NULL,
  memory_a TEXT NOT NULL,
  memory_b TEXT,
  domain TEXT NOT NULL,
  benchmark_version TEXT NOT NULL,
  seed TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'ranked',
  status TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  accepted_at INTEGER,
  settled_at INTEGER,
  result_json TEXT,
  trace_hash TEXT,
  result_hash TEXT
);

CREATE TABLE IF NOT EXISTS memory_transfers (
  request_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  note TEXT,
  transferred_at INTEGER NOT NULL,
  event_tx_hash TEXT
);

CREATE TABLE IF NOT EXISTS battle_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  pnl_a REAL NOT NULL,
  pnl_b REAL NOT NULL,
  risk_a REAL NOT NULL,
  risk_b REAL NOT NULL,
  latency_a INTEGER NOT NULL,
  latency_b INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS burn_records (
  request_id TEXT PRIMARY KEY,
  payer_agent TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  burn_address TEXT NOT NULL,
  burn_from TEXT,
  burn_tx_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hive_buffs (
  buff_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  prompt_patch TEXT NOT NULL,
  min_fitness REAL NOT NULL,
  ttl_until INTEGER NOT NULL,
  premium_only INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  hash TEXT,
  hash_type TEXT,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  text_blob TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS onchain_retry_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS onchain_retry_failed_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_job_id INTEGER,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  error_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proof_events (
  tx_hash TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_source TEXT,
  event_mode TEXT,
  request_id TEXT,
  battle_id TEXT,
  memory_id TEXT,
  payload_hash TEXT,
  payload_json TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_confirmations (
  token TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  request_id TEXT,
  payload_hash TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hive_memory_clones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  source_memory_id TEXT NOT NULL,
  cloned_memory_id TEXT NOT NULL,
  hive_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  payment_tx_hash TEXT,
  burn_tx_hash TEXT,
  event_tx_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hive_memory_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_memory_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  score REAL NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_memory_id, agent_id)
);

CREATE TABLE IF NOT EXISTS hive_memory_recombinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_memory_id TEXT NOT NULL UNIQUE,
  parent_a_memory_id TEXT NOT NULL,
  parent_b_memory_id TEXT NOT NULL,
  pair_key TEXT NOT NULL,
  cluster_key TEXT,
  similarity REAL NOT NULL,
  avg_parent_score REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_daily_budget_usage (
  day_key TEXT PRIMARY KEY,
  clone_calls INTEGER NOT NULL DEFAULT 0,
  clone_usdc REAL NOT NULL DEFAULT 0,
  chain_calls INTEGER NOT NULL DEFAULT 0,
  recombine_runs INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`);

// Lightweight migrations for evolving local dev schemas.
ensureColumn('idempotency_requests', 'key_id', 'TEXT');
ensureColumn('idempotency_requests', 'namespace', 'TEXT');
ensureColumn('onchain_retry_jobs', 'dedupe_key', 'TEXT');
ensureColumn('memories', 'memory_type', "TEXT NOT NULL DEFAULT 'semantic'");
ensureColumn('memories', 'memory_sub_type', 'TEXT');
ensureColumn('memories', 'tags_json', 'TEXT');
ensureColumn('memories', 'classifier_confidence', 'REAL NOT NULL DEFAULT 0');
ensureColumn('memories', 'encrypted_uri', 'TEXT');
ensureColumn('memories', 'encrypted_uri_hash', 'TEXT');
ensureColumn('memories', 'strategy_body', 'TEXT');
ensureColumn('memories', 'strategy_note', 'TEXT');
ensureColumn('battles', 'match_mode', "TEXT NOT NULL DEFAULT 'ranked'");
ensureColumn('memory_transfers', 'note', 'TEXT');
ensureColumn('memory_transfers', 'transferred_at', 'INTEGER');
ensureColumn('memory_transfers', 'event_tx_hash', 'TEXT');
ensureColumn('burn_records', 'burn_from', 'TEXT');
ensureColumn('proof_events', 'event_mode', 'TEXT');
ensureColumn('proof_events', 'meta_json', 'TEXT');
ensureColumn('proof_events', 'request_id', 'TEXT');
ensureColumn('hive_memory_recombinations', 'cluster_key', 'TEXT');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_onchain_retry_pending_next ON onchain_retry_jobs(status, next_retry_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_onchain_retry_dedupe_active
  ON onchain_retry_jobs(dedupe_key)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_onchain_retry_failed_archive_archived_at
  ON onchain_retry_failed_archive(archived_at);
CREATE INDEX IF NOT EXISTS idx_onchain_retry_failed_archive_error_type
  ON onchain_retry_failed_archive(error_type);
CREATE INDEX IF NOT EXISTS idx_hive_memory_clones_source_target
  ON hive_memory_clones(source_memory_id, target_agent_id);
CREATE INDEX IF NOT EXISTS idx_hive_memory_clones_source_created
  ON hive_memory_clones(source_memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hive_memory_ratings_source
  ON hive_memory_ratings(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_hive_memory_recombinations_pair_created
  ON hive_memory_recombinations(pair_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hive_memory_recombinations_cluster_created
  ON hive_memory_recombinations(cluster_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hive_memory_recombinations_created
  ON hive_memory_recombinations(created_at DESC);
`);

export const now = () => Math.floor(Date.now() / 1000);

export function tx(fn) {
  const wrapped = db.transaction(fn);
  return (...args) => wrapped(...args);
}
