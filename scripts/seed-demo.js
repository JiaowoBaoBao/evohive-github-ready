import { db, now } from '../apps/arena/src/db.js';
import { upsertMemoryVector } from '../apps/arena/src/vectorIndex.js';

const ts = now();

const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);

for (const t of [
  'battle_metrics',
  'battles',
  'memory_transfers',
  'idempotency_requests',
  'burn_records',
  'activity_logs',
  'memory_vectors',
  'memories',
  'hive_buffs'
]) {
  if (tables.has(t)) db.prepare(`DELETE FROM ${t}`).run();
}

const memories = [
  {
    id: 'mem_spot_a1',
    domain: 'spot',
    symbols: 'BTC-USDT,ETH-USDT,SOL-USDT',
    timeframe: '1m',
    risk: 'mid',
    benchmark: 'bench-v1.2',
    feature: 'alpha-v1',
    hash: '0xspota1',
    cid: 'ipfs://spota1',
    agent: 'agent-a',
    fitness: 0.58
  },
  {
    id: 'mem_spot_b1',
    domain: 'spot',
    symbols: 'BTC-USDT,ETH-USDT,SOL-USDT',
    timeframe: '1m',
    risk: 'mid',
    benchmark: 'bench-v1.2',
    feature: 'alpha-v1',
    hash: '0xspotb1',
    cid: 'ipfs://spotb1',
    agent: 'agent-b',
    fitness: 0.54
  },
  {
    id: 'mem_perp_c1',
    domain: 'perp',
    symbols: 'BTC-USDT-SWAP,ETH-USDT-SWAP',
    timeframe: '5m',
    risk: 'high',
    benchmark: 'bench-v1.2',
    feature: 'alpha-v1',
    hash: '0xperpc1',
    cid: 'ipfs://perpc1',
    agent: 'agent-c',
    fitness: 0.61
  }
];

const buffs = [
  {
    id: 'buff_global_1',
    scope: 'global',
    patch: 'Prioritize risk caps before scaling position size.',
    minFitness: 0.5,
    ttl: ts + 86400,
    premiumOnly: 0
  },
  {
    id: 'buff_domain_spot_1',
    scope: 'domain',
    patch: '[spot] Favor momentum confirmation on 1m before entry.',
    minFitness: 0.6,
    ttl: ts + 86400,
    premiumOnly: 1
  }
];

for (const m of memories) {
  db.prepare(`
    INSERT INTO memories (
      memory_id, domain, symbol_set, timeframe, risk_profile, benchmark_version, feature_version,
      content_hash, cid, source_agent, fitness, state, ttl_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      fitness = excluded.fitness,
      updated_at = excluded.updated_at
  `).run(
    m.id,
    m.domain,
    m.symbols,
    m.timeframe,
    m.risk,
    m.benchmark,
    m.feature,
    m.hash,
    m.cid,
    m.agent,
    m.fitness,
    ts + 30 * 86400,
    ts,
    ts
  );

  await upsertMemoryVector({
    memoryId: m.id,
    domain: m.domain,
    sourceAgent: m.agent,
    benchmarkVersion: m.benchmark,
    timeframe: m.timeframe,
    riskProfile: m.risk,
    embeddingText: `${m.domain} ${m.symbols} ${m.benchmark} ${m.timeframe} ${m.risk}`
  });
}

for (const b of buffs) {
  db.prepare(`
    INSERT INTO hive_buffs (buff_id, scope, prompt_patch, min_fitness, ttl_until, premium_only, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(buff_id) DO UPDATE SET
      prompt_patch = excluded.prompt_patch,
      min_fitness = excluded.min_fitness,
      ttl_until = excluded.ttl_until
  `).run(b.id, b.scope, b.patch, b.minFitness, b.ttl, b.premiumOnly, ts);
}

console.log('Seed complete:', { memories: memories.length, buffs: buffs.length });
