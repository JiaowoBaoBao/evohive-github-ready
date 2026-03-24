import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const draftRoot = path.resolve(projectRoot, 'data/memory-lake');

const FAIL_HINTS = ['error', 'failed', 'failure', 'exception', 'revert', '失败', '报错', '异常'];
const SUCCESS_HINTS = ['success', 'done', 'completed', 'ok', 'passed', '成功', '完成', '通过'];

function clean(v) {
  return String(v || '').trim();
}

function safeAgentId(agentId) {
  const v = clean(agentId).toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(v)) throw new Error('INVALID_AGENT_ID');
  return v;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number(n) || 0));
}

function sha256Hex(text) {
  return `0x${crypto.createHash('sha256').update(String(text || '')).digest('hex')}`;
}

function splitUsefulLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 6)
    .filter((line) => !FAIL_HINTS.some((k) => line.toLowerCase().includes(k)));
}

function pickKeyConditions(text) {
  const out = [];
  const lower = text.toLowerCase();
  if (lower.includes('risk') || /风险|止损|仓位/.test(text)) out.push('风控阈值已明确');
  if (lower.includes('gas') || /手续费|gas/.test(text)) out.push('Gas/成本阈值可控');
  if (lower.includes('x layer') || lower.includes('xlayer')) out.push('链路已在 X Layer 实测可用');
  if (/premium|x402/i.test(text)) out.push('premium 支付配置已通过预检');
  return out.length ? out.slice(0, 5) : ['关键配置已完整', '执行窗口内网络可用'];
}

function pickTags({ domain, text, extra = [] }) {
  const tags = new Set();
  tags.add(String(domain || 'strategy').toLowerCase());
  tags.add('procedural');

  const lower = String(text || '').toLowerCase();
  if (lower.includes('dca')) tags.add('dca');
  if (lower.includes('gas')) tags.add('gas_optimization');
  if (lower.includes('x layer') || lower.includes('xlayer')) tags.add('xlayer');
  if (lower.includes('premium') || lower.includes('x402')) tags.add('premium');
  if (lower.includes('reconcile')) tags.add('reconciliation');
  if (lower.includes('retry')) tags.add('retry');

  for (const t of extra || []) {
    const x = clean(t).toLowerCase().replace(/\s+/g, '_');
    if (x) tags.add(x);
  }

  return [...tags].slice(0, 10);
}

function normalizeStep(line, idx) {
  const txt = line.replace(/^[-*\d.\s]+/, '').trim();
  return `步骤${idx + 1}：${txt}`;
}

function buildProceduralDraft(input) {
  const trajectory = clean(input.trajectoryText);
  const lines = splitUsefulLines(trajectory);
  const titleHint = clean(input.titleHint || input.manualFocus || '');

  const title =
    titleHint ||
    `EvoHive ${input.domain || 'strategy'} 执行流程（成功案例）`;

  const topLines = lines.slice(0, 12);
  const summaryLines = topLines.slice(0, 3);
  const summary =
    summaryLines.length > 0
      ? summaryLines.join('；')
      : '按预设风控与执行顺序完成流程，关键链路验证通过，可复用到同类场景。';

  const steps = (topLines.length ? topLines : ['准备配置并完成预检', '按顺序执行核心动作', '验收并记录证明'])
    .slice(0, 8)
    .map((line, idx) => normalizeStep(line, idx));

  const keyConditions = pickKeyConditions(trajectory);

  const successSignals = SUCCESS_HINTS.filter((k) => trajectory.toLowerCase().includes(k));
  const importance = clamp(70 + steps.length * 3 + successSignals.length * 2, 65, 98);

  const tags = pickTags({
    domain: input.domain,
    text: trajectory,
    extra: input.tags
  });

  const successMetrics = {
    pnl: input.successPnl || 'n/a',
    win_rate: input.successWinRate || 'n/a',
    gas_saved: input.successGasSaved || 'n/a',
    other: input.successOther || '链路验证通过'
  };

  const reusableTemplate =
    input.reusableTemplate ||
    '未来遇到相同条件时：先做配置预检 -> 执行主流程 -> 立即做对账与链路验收，未达标则走重试与告警。';

  const whyItWorked =
    input.whyItWorked ||
    '按固定顺序执行并在关键节点做验证，显著降低了配置漂移和链路不确定性。';

  const procedural = {
    memory_type: 'procedural',
    title,
    summary,
    step_by_step: steps,
    key_conditions: keyConditions,
    success_metrics: successMetrics,
    reusable_template: reusableTemplate,
    tags,
    importance,
    why_it_worked: whyItWorked
  };

  return procedural;
}

function toOpenSeaAttributes(proc, context) {
  const attrs = [
    { trait_type: 'Memory Type', value: 'procedural' },
    { trait_type: 'Title', value: proc.title },
    { trait_type: 'Domain', value: context.domain },
    { trait_type: 'Timeframe', value: context.timeframe },
    { trait_type: 'Risk Profile', value: context.riskProfile },
    { trait_type: 'Importance', value: String(proc.importance) }
  ];

  for (const tag of proc.tags || []) {
    attrs.push({ trait_type: 'Tag', value: String(tag) });
  }

  return attrs.slice(0, 48);
}

function toMemoryRecord(proc, context) {
  const memoryId = `mem_${context.agentId.replace(/[^a-z0-9]/g, '')}_${Date.now().toString(36)}`;
  const contentText = [
    proc.title,
    proc.summary,
    ...(proc.step_by_step || []),
    `why: ${proc.why_it_worked || ''}`
  ].join('\n');

  const contentHash = sha256Hex(JSON.stringify(proc));
  const encryptedUri = clean(context.encryptedUri || '');

  return {
    memoryId,
    domain: context.domain,
    symbolSet: context.symbolSet,
    timeframe: context.timeframe,
    riskProfile: context.riskProfile,
    benchmarkVersion: context.benchmarkVersion,
    featureVersion: context.featureVersion,
    contentHash,
    cid: context.cid || undefined,
    encryptedUri: encryptedUri || undefined,
    contentText,
    note: context.manualFocus || undefined,
    attributes: toOpenSeaAttributes(proc, context),
    ttlDays: context.ttlDays
  };
}

async function ensureDraftDirs(agentId) {
  const base = path.join(draftRoot, agentId, 'procedural');
  const dirs = ['inbox', 'curated', 'committed', 'failed'].map((x) => path.join(base, x));
  await Promise.all(dirs.map((d) => fs.mkdir(d, { recursive: true })));
  return { base, dirs: Object.fromEntries(['inbox', 'curated', 'committed', 'failed'].map((k, i) => [k, dirs[i]])) };
}

export async function generateProceduralMemoryDraft(input) {
  const agentId = safeAgentId(input.agentId);
  const domain = clean(input.domain || 'strategy');
  const timeframe = clean(input.timeframe || '1h');
  const riskProfile = clean(input.riskProfile || 'mid');

  const context = {
    agentId,
    domain,
    timeframe,
    riskProfile,
    symbolSet: Array.isArray(input.symbolSet) && input.symbolSet.length ? input.symbolSet.map(String) : ['BTCUSDT', 'ETHUSDT'],
    benchmarkVersion: clean(input.benchmarkVersion || 'traj-v1'),
    featureVersion: clean(input.featureVersion || 'memory-gen-v1'),
    ttlDays: clamp(input.ttlDays || 30, 1, 365),
    cid: clean(input.cid || ''),
    encryptedUri: clean(input.encryptedUri || ''),
    manualFocus: clean(input.manualFocus || ''),
    tags: Array.isArray(input.tags) ? input.tags : []
  };

  const procedural = buildProceduralDraft({
    ...input,
    domain,
    trajectoryText: input.trajectoryText
  });

  const memory = toMemoryRecord(procedural, context);
  const draftId = `draft_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

  const record = {
    draftId,
    stage: 'inbox',
    createdAt: new Date().toISOString(),
    agentId,
    schemaVersion: 1,
    procedural,
    memory
  };

  const { dirs } = await ensureDraftDirs(agentId);
  const file = path.join(dirs.inbox, `${draftId}.json`);
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  return {
    draftId,
    stage: 'inbox',
    filePath: file,
    relativePath: path.relative(projectRoot, file),
    draft: record
  };
}

export async function listProceduralDrafts({ agentId, stage = 'inbox', limit = 20 }) {
  const safeAgent = safeAgentId(agentId);
  const safeStage = ['inbox', 'curated', 'committed', 'failed'].includes(stage) ? stage : 'inbox';
  const { dirs } = await ensureDraftDirs(safeAgent);
  const dir = dirs[safeStage];

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const metas = [];
  for (const file of files) {
    try {
      const abs = path.join(dir, file);
      const raw = await fs.readFile(abs, 'utf8');
      const json = JSON.parse(raw);
      metas.push({
        draftId: json.draftId || file.replace(/\.json$/, ''),
        stage: json.stage || safeStage,
        agentId: json.agentId || safeAgent,
        createdAt: json.createdAt || null,
        title: json?.procedural?.title || null,
        memoryId: json?.memory?.memoryId || null,
        memoryType: json?.procedural?.memory_type || 'procedural',
        importance: Number(json?.procedural?.importance || 0),
        relativePath: path.relative(projectRoot, abs)
      });
    } catch {
      // ignore broken draft file
    }
  }

  return metas
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, clamp(limit, 1, 200));
}

export async function loadProceduralDraft({ agentId, draftId, stage = 'inbox' }) {
  const safeAgent = safeAgentId(agentId);
  const safeStage = ['inbox', 'curated', 'committed', 'failed'].includes(stage) ? stage : 'inbox';
  const id = clean(draftId);
  if (!id || !/^[a-zA-Z0-9_-]{4,120}$/.test(id)) throw new Error('INVALID_DRAFT_ID');

  const { dirs } = await ensureDraftDirs(safeAgent);
  const file = path.join(dirs[safeStage], `${id}.json`);
  const raw = await fs.readFile(file, 'utf8');
  const json = JSON.parse(raw);
  return {
    draftId: json.draftId || id,
    stage: json.stage || safeStage,
    filePath: file,
    relativePath: path.relative(projectRoot, file),
    draft: json
  };
}
