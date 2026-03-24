import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.EVOHIVE_ENV_PATH || '.env' });

const baseUrl = process.env.EVOHIVE_URL || `http://127.0.0.1:${process.env.PORT || 4310}`;
const outDir = path.resolve(process.cwd(), 'output');
fs.mkdirSync(outDir, { recursive: true });

async function getJson(p) {
  const res = await fetch(`${baseUrl}${p}`);
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`${p} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

(async () => {
  const health = await getJson('/health');
  const state = await getJson('/api/ui/state');
  const logs = await getJson('/api/ui/logs?limit=50');
  const metrics = await getJson('/metrics');
  const system = await getJson('/api/system/status');

  const now = new Date();
  const stamp = now.toISOString().replaceAll(':', '-');
  const report = {
    generatedAt: now.toISOString(),
    baseUrl,
    health,
    runtime: state.runtime,
    counts: {
      memories: state.memories?.length || 0,
      pendingBattles: state.pendingBattles?.length || 0,
      recentBattles: state.recentBattles?.length || 0
    },
    latestLogs: logs.logs || [],
    metrics: metrics.metrics || {},
    queue: system.retryQueue || {},
    circuit: system.onchain?.circuit || {}
  };

  const file = path.join(outDir, `acceptance-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Acceptance report written: ${file}`);

  const md = [
    '# EvoHive Acceptance Snapshot',
    '',
    `- Time: ${report.generatedAt}`,
    `- Base URL: ${report.baseUrl}`,
    `- Onchain mode: ${health.onchainMode}`,
    `- Signature mode: ${health.signatureMode}`,
    `- Vector backend: ${health.vectorBackend}`,
    `- Memories: ${report.counts.memories}`,
    `- Pending battles: ${report.counts.pendingBattles}`,
    `- Recent battles: ${report.counts.recentBattles}`,
    `- Retry queue pending/failed: ${report.queue.pending || 0}/${report.queue.failed || 0}`,
    `- Circuit verify/event open: ${report.circuit.verify?.open ? 'yes' : 'no'}/${report.circuit.event?.open ? 'yes' : 'no'}`,
    '',
    '## Latest Logs (top 10)',
    ...report.latestLogs.slice(-10).map((l) => `- [${new Date(l.ts * 1000).toISOString()}] ${l.action} ${l.message}`),
    ''
  ].join('\n');

  const mdFile = path.join(outDir, `acceptance-${stamp}.md`);
  fs.writeFileSync(mdFile, `${md}\n`);
  console.log(`Acceptance markdown written: ${mdFile}`);
})().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
