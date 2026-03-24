import { db } from '../apps/arena/src/db.js';

const tableNames = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);

const purgeOrder = [
  'battle_metrics',
  'battles',
  'memory_transfers',
  'idempotency_requests',
  'burn_records',
  'activity_logs',
  'memory_vectors',
  'memories',
  'hive_buffs'
];

let deleted = 0;
for (const t of purgeOrder) {
  if (!tableNames.has(t)) continue;
  const changes = db.prepare(`DELETE FROM ${t}`).run().changes;
  deleted += changes;
}

if (tableNames.has('sqlite_sequence')) {
  db.prepare('DELETE FROM sqlite_sequence').run();
}

console.log('Reset complete:', {
  touchedTables: purgeOrder.filter((t) => tableNames.has(t)).length,
  deletedRows: deleted
});
