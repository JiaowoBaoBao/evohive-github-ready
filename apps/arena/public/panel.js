const arenaId = 'arena-main';
const chainId = 196;
const logsEl = document.getElementById('logs');
const statusEl = document.getElementById('status');
const systemStatusEl = document.getElementById('systemStatus');
const proofResultEl = document.getElementById('proofResult');
const hiveHeatBoardEl = document.getElementById('hiveHeatBoard');
const hiveRatingBoardEl = document.getElementById('hiveRatingBoard');
const hiveLineageEl = document.getElementById('hiveLineage');
const panelAgentViewEl = document.getElementById('panelAgentView');
const simpleModeEl = document.getElementById('simpleMode');
const summaryHealthEl = document.getElementById('summaryHealth');
const summaryAuthEl = document.getElementById('summaryAuth');
const summaryCapacityEl = document.getElementById('summaryCapacity');
const summaryPendingEl = document.getElementById('summaryPending');
const summaryAlertsEl = document.getElementById('summaryAlerts');
const summaryHintEl = document.getElementById('summaryHint');
const memoryModalEl = document.getElementById('memoryModal');
const memoryModalTitleEl = document.getElementById('memoryModalTitle');
const memoryModalBodyEl = document.getElementById('memoryModalBody');
const memoryModalCloseEl = document.getElementById('memoryModalClose');
const actionToastEl = document.getElementById('actionToast');
const draftCache = { 'agent-a': null, 'agent-b': null };

let logCursor = 0;
let logsInitialized = false;
let logBuffer = [];
let refreshTimer = null;
let refreshInFlight = false;
let diagnosticsVisible = false;
let simpleMode = true;
let agentView = 'agent-a';
let toastTimer = null;
const actionFeedbackTimers = new WeakMap();

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

async function hashPayload(payload) {
  const msg = new TextEncoder().encode(stableStringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', msg);
  return `0x${[...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

async function makeAuth(agentId, action, payload) {
  const requestId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  try {
    const res = await fetch('/api/ui/auth/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, action, payload, requestId })
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok && json.auth) {
      return json.auth;
    }

    if (res.status !== 404) {
      throw new Error(json.error || `auth sign failed (${res.status})`);
    }
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (msg && !msg.includes('Failed to fetch')) throw err;
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    requestId,
    agentId,
    action,
    payloadHash: await hashPayload(payload),
    issuedAt: now,
    deadline: now + 120,
    arenaId,
    chainId,
    signature: '0xpanel-demo-signature'
  };
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(j.error || JSON.stringify(j));
  return j;
}

async function get(path) {
  const res = await fetch(path);
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(j.error || JSON.stringify(j));
  return j;
}

function byAgent(memories, agent) {
  return memories.filter((m) => m.sourceAgent === agent && String(m.state || 'active').toLowerCase() === 'active');
}

function fillSelect(id, rows, map) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = '';
  rows.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = map.value(r);
    opt.textContent = map.label(r);
    el.appendChild(opt);
  });
  if (current && [...el.options].some((o) => o.value === current)) el.value = current;
}

function txHref(hash, { live = true, explorer = null } = {}) {
  const clean = String(hash || '').trim();
  if (!clean.startsWith('0x')) return null;
  if (!live) return null;
  return explorer || `https://www.oklink.com/xlayer/tx/${clean.slice(2)}`;
}

function txLink(hash, meta) {
  return txHref(hash, { live: meta?.hashLive !== false, explorer: meta?.explorerLink || null });
}

function esc(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function normalizeErrorMessage(err) {
  let msg = err?.message || String(err || '未知错误');
  if (msg === 'Failed to fetch') return '网络请求失败（服务可能未启动或已断开）';

  const trimmed = String(msg).trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error) return String(parsed.error);
    } catch {
      // ignore parse error
    }
  }

  if (trimmed === '[object Object]') return '请求参数校验失败';
  return trimmed;
}

function actionScopeLabel(agent) {
  if (agent === 'agent-a') return 'Agent A';
  if (agent === 'agent-b') return 'Agent B';
  return '系统';
}

function showToast(kind, text, durationMs = 2600) {
  if (!actionToastEl) return;
  actionToastEl.classList.remove('hidden', 'success', 'error', 'info');
  actionToastEl.classList.add(kind || 'info');
  actionToastEl.textContent = text;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    actionToastEl.classList.add('hidden');
    actionToastEl.classList.remove('success', 'error', 'info');
    actionToastEl.textContent = '';
  }, Math.max(1200, Number(durationMs) || 2600));
}

function feedbackScopeForButton(btn) {
  return (
    btn?.closest('.proof-tools')
    || btn?.closest('.overview-card')
    || btn?.closest('.card')
    || btn?.closest('.system-card')
    || btn?.closest('.log-card')
  );
}

function ensureActionFeedbackEl(btn) {
  const scope = feedbackScopeForButton(btn);
  if (!scope) return null;

  let el = scope.querySelector(':scope > .action-feedback');
  if (!el) {
    el = document.createElement('div');
    el.className = 'action-feedback hidden';
    scope.appendChild(el);
  }
  return el;
}

function showActionFeedback(btn, kind, text, durationMs = 5000) {
  const el = ensureActionFeedbackEl(btn);
  if (!el) return;

  el.classList.remove('hidden', 'success', 'error', 'info');
  el.classList.add(kind || 'info');
  el.textContent = text;

  const oldTimer = actionFeedbackTimers.get(el);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('success', 'error', 'info');
    el.textContent = '';
  }, Math.max(1800, Number(durationMs) || 5000));

  actionFeedbackTimers.set(el, timer);
}

function actionLabelFromButton(btn, fallback = '操作') {
  const fallbackText = String(fallback || '').trim();
  const raw = String(btn?.dataset?.label || fallbackText || btn?.textContent || '操作').trim();
  return raw || '操作';
}

function applyViewMode() {
  const agentA = document.getElementById('agentA');
  const agentB = document.getElementById('agentB');
  const diagnostics = document.querySelectorAll('.diagnostic-section');

  const showA = agentView === 'both' || agentView === 'agent-a';
  const showB = agentView === 'both' || agentView === 'agent-b';

  if (agentA) agentA.classList.toggle('hidden-by-view', !showA);
  if (agentB) agentB.classList.toggle('hidden-by-view', !showB);

  const hideDiagnostics = simpleMode && !diagnosticsVisible;
  diagnostics.forEach((el) => {
    el.style.display = hideDiagnostics ? 'none' : '';
  });

  document.body.classList.toggle('simple-mode', simpleMode);

  const btn = document.querySelector('button[data-action="toggleDiagnostics"]');
  if (btn) {
    btn.textContent = hideDiagnostics ? '显示诊断区' : '隐藏诊断区';
  }

  if (summaryHintEl) {
    summaryHintEl.textContent = hideDiagnostics
      ? '简洁模式：隐藏低频调试区，匹配回合数固定为 10。切换专业模式可调整高级参数。'
      : '当前已展开诊断区：包含证明工具、系统明细与全量日志。';
  }
}

function toCsv(value) {
  if (Array.isArray(value)) return value.join(',');
  if (value == null) return '';
  return String(value);
}

function renderOverview(state, status) {
  const pending = Array.isArray(state?.pendingBattles) ? state.pendingBattles.length : 0;
  const queuePending = Number(status?.retryQueue?.pending || 0);
  const queueFailed = Number(status?.retryQueue?.failed || 0);
  const hard = status?.checks?.hardThresholds || {};
  const signaturePolicy = status?.checks?.signaturePolicy || {};
  const cap = status?.checks?.premiumCapacity || {};
  const reconcileIssues = Array.isArray(status?.reconciliation?.issues) ? status.reconciliation.issues : [];
  const hasBlocking = Array.isArray(hard?.blockedActions) && hard.blockedActions.length > 0;

  let healthText = '正常';
  if (hasBlocking) healthText = `阻塞 (${toCsv(hard.breaches) || 'threshold'})`;
  else if (queueFailed > 0 || reconcileIssues.length > 0) healthText = '有告警';

  const authText = `${signaturePolicy?.effectiveMode || signaturePolicy?.mode || 'n/a'}${
    signaturePolicy?.ok === false ? ' (异常)' : ''
  }`;

  const capText = cap?.ok
    ? `${Number(cap?.estimatedPremiumRuns ?? 0)} 次`
    : cap?.degraded
      ? `降级缓存 ${Number(cap?.estimatedPremiumRuns ?? 0)} 次`
      : '不可用';

  const alertText = hasBlocking
    ? '硬阈值拦截中'
    : reconcileIssues.length
      ? reconcileIssues[0]?.reason || '有告警'
      : queueFailed > 0
        ? `失败队列 ${queueFailed}`
        : '无';

  if (summaryHealthEl) summaryHealthEl.textContent = healthText;
  if (summaryAuthEl) summaryAuthEl.textContent = authText;
  if (summaryCapacityEl) summaryCapacityEl.textContent = capText;
  if (summaryPendingEl) summaryPendingEl.textContent = `battle ${pending} · retry ${queuePending}`;
  if (summaryAlertsEl) summaryAlertsEl.textContent = alertText;
}

function renderLogs(logs) {
  logsEl.innerHTML = '';
  logs.forEach((l) => {
    const div = document.createElement('div');
    div.className = 'log-line';
    const time = new Date(l.ts * 1000).toLocaleTimeString();
    const source = l.meta?.source || 'unknown';
    const sourceTag = `[${source}${l.meta?.hashLive === false ? '/demo' : ''}]`;
    const base = `[${time}] ${sourceTag} ${l.action} ${l.agentId ? `(${l.agentId}) ` : ''}${l.message}`;

    const txParts = [];

    const eventHref = txLink(l.hash, l.meta);
    if (eventHref && l.hash) {
      txParts.push(
        `event <a target="_blank" rel="noreferrer" href="${esc(eventHref)}">${esc(l.hash.slice(0, 10))}...${esc(l.hash.slice(-8))}</a>`
      );
    } else if (l.hash) {
      txParts.push(
        `event <span class="demo-hash" title="本地演示哈希，未上链">${esc(l.hash.slice(0, 10))}...${esc(l.hash.slice(-8))}</span>`
      );
    }

    if (l.action === 'BATTLE_SETTLE' && l.meta) {
      const simA = Number(l.meta.simScoreA ?? 0).toFixed(3);
      const simB = Number(l.meta.simScoreB ?? 0).toFixed(3);
      const finalA = Number(l.meta.scoreA ?? 0).toFixed(3);
      const finalB = Number(l.meta.scoreB ?? 0).toFixed(3);
      txParts.push(`score A ${finalA} (sim ${simA}) · B ${finalB} (sim ${simB})`);
    }

    if (l.action === 'HIVE_ACCESS_PREMIUM' && l.meta) {
      const paymentHash = String(l.meta.paymentTxHash || '').trim();
      const paymentProofHash = String(l.meta.paymentProofHash || '').trim();
      const paymentHashType = String(l.meta.paymentHashType || '').trim().toLowerCase();
      const paymentLooksLikeProof =
        paymentHashType === 'proof' ||
        (!paymentHashType && String(l.meta.paymentSource || '').trim() === 'skill-cli-x402') ||
        (paymentHash && paymentProofHash && paymentHash.toLowerCase() === paymentProofHash.toLowerCase());

      const burnHash = String(l.meta.burnTxHash || '').trim();

      const paymentHref = txHref(paymentHash, { live: Boolean(l.meta.paymentTxLive) && !paymentLooksLikeProof });
      const burnHref = txHref(burnHash, { live: Boolean(l.meta.burnTxLive) });

      if (paymentHref) {
        txParts.push(
          `payment <a target="_blank" rel="noreferrer" href="${esc(paymentHref)}">${esc(paymentHash.slice(0, 10))}...${esc(paymentHash.slice(-8))}</a>`
        );
      } else if (paymentHash) {
        txParts.push(
          `payment <span class="demo-hash" title="x402 支付证明哈希（非链上交易）">${esc(paymentHash.slice(0, 10))}...${esc(paymentHash.slice(-8))}</span>`
        );
      }

      if (burnHref) {
        txParts.push(
          `burn <a target="_blank" rel="noreferrer" href="${esc(burnHref)}">${esc(burnHash.slice(0, 10))}...${esc(burnHash.slice(-8))}</a>`
        );
      } else if (burnHash) {
        txParts.push(
          `burn <span class="demo-hash" title="未上链或仅本地证明">${esc(burnHash.slice(0, 10))}...${esc(burnHash.slice(-8))}</span>`
        );
      }
    }

    if (txParts.length > 0) {
      div.innerHTML = `${esc(base)} · ${txParts.join(' · ')}`;
    } else {
      div.textContent = base;
    }

    logsEl.appendChild(div);
  });
  logsEl.scrollTop = logsEl.scrollHeight;
}

function renderSystemStatus(status) {
  if (!status) {
    systemStatusEl.textContent = 'status unavailable';
    return;
  }
  const queue = status.retryQueue || {};
  const metrics = status.metrics || {};
  const circuit = status.onchain?.circuit || {};
  const hard = status.checks?.hardThresholds || {};
  const budget = status.checks?.budget || {};
  const cap = status.checks?.premiumCapacity || {};
  const cells = [
    ['Onchain Mode', status.runtime?.onchainMode || 'n/a'],
    ['Market', status.runtime?.marketMode || 'n/a'],
    ['Requests', String(metrics.requestsTotal ?? 0)],
    ['Latency p95', `${metrics.latencyMs?.p95 ?? 0} ms`],
    ['Queue Pending', String(queue.pending ?? 0)],
    ['Queue Failed', String(queue.failed ?? 0)],
    ['Circuit verify', circuit.verify?.open ? `OPEN ${circuit.verify.openUntil}` : 'closed'],
    ['Circuit event', circuit.event?.open ? `OPEN ${circuit.event.openUntil}` : 'closed'],
    ['Hard Threshold', hard.ok === false ? `BLOCK ${toCsv(hard.breaches)}` : 'ok'],
    ['Budget', budget.ok === false ? `LIMIT ${toCsv(budget.breaches)}` : 'ok'],
    ['Premium Capacity', Number.isFinite(cap?.estimatedPremiumRuns) ? String(cap.estimatedPremiumRuns) : 'n/a']
  ];

  systemStatusEl.innerHTML = cells
    .map(([k, v]) => `<div class="system-pill"><b>${esc(k)}</b>${esc(v)}</div>`)
    .join('');
}

function renderLeaderboards(lb) {
  const heat = Array.isArray(lb?.heat) ? lb.heat : [];
  const rating = Array.isArray(lb?.rating) ? lb.rating : [];

  hiveHeatBoardEl.textContent = heat.length
    ? heat
        .map(
          (x) =>
            `#${x.rank} ${x.memoryId}\n  heat=${x.heat} | w=${Number(x.weightedScore || 0).toFixed(2)} | avg=${Number(x.avgScore || 0).toFixed(2)} | votes=${x.ratingCount}`
        )
        .join('\n\n')
    : '暂无热度数据';

  hiveRatingBoardEl.textContent = rating.length
    ? rating
        .map(
          (x) =>
            `#${x.rank} ${x.memoryId}\n  w=${Number(x.weightedScore || 0).toFixed(2)} | avg=${Number(x.avgScore || 0).toFixed(2)} | votes=${x.ratingCount} | heat=${x.heat}`
        )
        .join('\n\n')
    : '暂无评分数据';
}

async function refresh({ forceFullLogs = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const [state, sys, aDraftsData, bDraftsData, leaderboards] = await Promise.all([
      get('/api/ui/state'),
      get('/api/system/status'),
      get('/api/memories/drafts?agentId=agent-a&limit=30'),
      get('/api/memories/drafts?agentId=agent-b&limit=30'),
      get('/api/hive/memories/leaderboards?limit=20&minRatingCount=1')
    ]);

    const logsPath = forceFullLogs || !logsInitialized ? '/api/ui/logs?limit=220' : `/api/ui/logs?afterId=${logCursor}&limit=220`;
    const logsData = await get(logsPath);
    if (forceFullLogs || !logsInitialized || !logsData.incremental) {
      logBuffer = Array.isArray(logsData.logs) ? logsData.logs : [];
    } else {
      const append = Array.isArray(logsData.logs) ? logsData.logs : [];
      if (append.length) {
        logBuffer = [...logBuffer, ...append].slice(-500);
      }
    }
    logsInitialized = true;
    logCursor = Number(logsData.nextCursor || logCursor || 0);

    const runtime = state.runtime || {};
    statusEl.textContent = `online · memories ${state.memories.length} · pending ${state.pendingBattles.length} · onchain ${runtime.onchainMode || 'n/a'} · sign ${runtime.signatureMode || 'n/a'} · score ${runtime.scoringMode || 'n/a'} · poll ${document.hidden ? '30s' : '5s'}`;
    renderOverview(state, sys);

    const aMem = byAgent(state.memories, 'agent-a');
    const bMem = byAgent(state.memories, 'agent-b');

    fillSelect('a-memoryList', aMem, {
      value: (x) => x.memoryId,
      label: (x) => `${x.memoryId} | ${x.domain}/${x.memoryType || '-'} | fit ${x.fitness.toFixed(3)}`
    });
    fillSelect('b-memoryList', bMem, {
      value: (x) => x.memoryId,
      label: (x) => `${x.memoryId} | ${x.domain}/${x.memoryType || '-'} | fit ${x.fitness.toFixed(3)}`
    });

    fillSelect('a-challengeMemory', aMem, { value: (x) => x.memoryId, label: (x) => x.memoryId });
    fillSelect('b-challengeMemory', bMem, { value: (x) => x.memoryId, label: (x) => x.memoryId });

    fillSelect('a-acceptMemory', aMem, { value: (x) => x.memoryId, label: (x) => x.memoryId });
    fillSelect('b-acceptMemory', bMem, { value: (x) => x.memoryId, label: (x) => x.memoryId });

    const visibleBattlesFor = (agentId) =>
      (state.pendingBattles || []).filter((b) => {
        if (b.status === 'accepted') {
          return b.challengerAgent === agentId || b.opponentAgent === agentId;
        }

        if (b.status !== 'challenged') return false;
        if (b.challengerAgent === agentId) return false;
        return b.isOpen || b.opponentAgent === agentId;
      });

    const battleLabel = (x) => {
      const domainTag = ` | domain:${x.domain || 'unknown'}`;
      const modeTag = ` | mode:${x.matchMode || 'ranked'}`;
      if (x.status === 'accepted') {
        return `${x.battleId} [accepted] ${x.challengerAgent} vs ${x.opponentAgent || 'unknown'}${domainTag}${modeTag}`;
      }
      if (x.isOpen) return `${x.battleId} [open] <- ${x.challengerAgent}${domainTag}${modeTag}`;
      return `${x.battleId} [direct] <- ${x.challengerAgent}${domainTag}${modeTag}`;
    };

    fillSelect('a-pendingBattle', visibleBattlesFor('agent-a'), {
      value: (x) => x.battleId,
      label: battleLabel
    });
    fillSelect('b-pendingBattle', visibleBattlesFor('agent-b'), {
      value: (x) => x.battleId,
      label: battleLabel
    });

    fillSelect('a-draftList', aDraftsData.drafts || [], {
      value: (x) => x.draftId,
      label: (x) => `${x.draftId} | ${x.memoryType} | imp ${x.importance}`
    });
    fillSelect('b-draftList', bDraftsData.drafts || [], {
      value: (x) => x.draftId,
      label: (x) => `${x.draftId} | ${x.memoryType} | imp ${x.importance}`
    });

    renderSystemStatus(sys);
    renderLeaderboards(leaderboards);
    renderLogs(logBuffer);
  } catch (err) {
    statusEl.textContent = `error: ${err.message}`;
    if (summaryHealthEl) summaryHealthEl.textContent = '拉取失败';
    if (summaryAlertsEl) summaryAlertsEl.textContent = String(err.message || err);
  } finally {
    refreshInFlight = false;
  }
}

function agentPrefix(agent) {
  return agent === 'agent-a' ? 'a' : 'b';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function memoryIdTimestampMinute() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function normalizeDomainForMemoryId(domain) {
  const out = String(domain || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'strategy';
}

function normalizeAgentForMemoryId(agent) {
  return String(agent || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildSuggestedMemoryId(agent, domain) {
  return `mem_${normalizeDomainForMemoryId(domain)}_${memoryIdTimestampMinute()}_${normalizeAgentForMemoryId(agent)}`;
}

function getMemoryIdInput(agent) {
  const p = agentPrefix(agent);
  return document.getElementById(`${p}-memoryId`);
}

function syncMemoryIdSuggestion(agent, { force = false } = {}) {
  const p = agentPrefix(agent);
  const input = getMemoryIdInput(agent);
  if (!input) return;
  const userEdited = input.dataset.userEdited === 'true';
  if (!force && userEdited && input.value.trim()) return;
  const domain = document.getElementById(`${p}-domain`)?.value || 'strategy';
  input.value = buildSuggestedMemoryId(agent, domain);
  input.dataset.userEdited = 'false';
}

function renderPreviewPayload(payload) {
  if (payload == null || payload === '') return '';
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload, null, 2);
}

function setMemoryPreview(agent, payload) {
  const p = agentPrefix(agent);
  const el = document.getElementById(`${p}-memoryPreview`);
  if (!el) return;
  el.textContent = renderPreviewPayload(payload);
}

function setMemoryDetail(agent, payload) {
  const p = agentPrefix(agent);
  const el = document.getElementById(`${p}-memoryDetail`) || document.getElementById(`${p}-memoryPreview`);
  if (!el) return;
  el.textContent = renderPreviewPayload(payload);
}

function closeMemoryModal() {
  if (!memoryModalEl) return;
  memoryModalEl.classList.add('hidden');
  memoryModalEl.setAttribute('aria-hidden', 'true');
}

function openMemoryModal(title, payload) {
  if (!memoryModalEl || !memoryModalBodyEl) return false;
  if (memoryModalTitleEl) memoryModalTitleEl.textContent = String(title || '记忆详情');
  memoryModalBodyEl.textContent = JSON.stringify(payload || {}, null, 2);
  memoryModalEl.classList.remove('hidden');
  memoryModalEl.setAttribute('aria-hidden', 'false');
  return true;
}

function applyDraftToForm(agent, draft) {
  const p = agentPrefix(agent);
  const memory = draft?.memory;
  if (!memory) return;

  const memoryIdInput = getMemoryIdInput(agent);
  const keepCurrentMemoryId = Boolean(memoryIdInput?.value?.trim()) && memoryIdInput?.dataset?.userEdited === 'true';
  if (!keepCurrentMemoryId && memoryIdInput) {
    memoryIdInput.value = memory.memoryId || memoryIdInput.value || '';
    memoryIdInput.dataset.userEdited = 'false';
  }

  if (memory.domain) document.getElementById(`${p}-domain`).value = memory.domain;
  if (memory.timeframe) document.getElementById(`${p}-timeframe`).value = memory.timeframe;
  if (memory.riskProfile) document.getElementById(`${p}-risk`).value = memory.riskProfile;

  if (!keepCurrentMemoryId) {
    syncMemoryIdSuggestion(agent, { force: true });
  }

  setMemoryPreview(agent, draft);
}

async function doGenerateDraft(agent) {
  const p = agentPrefix(agent);
  syncMemoryIdSuggestion(agent);
  const trajectoryText = document.getElementById(`${p}-trajectory`).value.trim();
  if (!trajectoryText) throw new Error('请先粘贴成功轨迹内容');

  const payload = {
    agentId: agent,
    trajectoryText,
    manualFocus: document.getElementById(`${p}-focus`).value.trim() || undefined,
    domain: document.getElementById(`${p}-domain`).value,
    timeframe: document.getElementById(`${p}-timeframe`).value || '1h',
    riskProfile: document.getElementById(`${p}-risk`).value,
    symbolSet: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    benchmarkVersion: 'traj-v1',
    featureVersion: 'memory-gen-v1',
    ttlDays: 30
  };

  const out = await post('/api/memories/generate', payload);
  draftCache[agent] = out.draft;
  applyDraftToForm(agent, out.draft);
  return out;
}

async function doLoadDraft(agent) {
  const p = agentPrefix(agent);
  const draftId = document.getElementById(`${p}-draftList`).value;
  if (!draftId) throw new Error('请先选择草稿');
  const out = await get(`/api/memories/drafts/${encodeURIComponent(agent)}/${encodeURIComponent(draftId)}`);
  draftCache[agent] = out.draft;
  applyDraftToForm(agent, out.draft);
}

async function doCommit(agent) {
  const p = agentPrefix(agent);
  const domain = document.getElementById(`${p}-domain`).value;
  const memoryId = document.getElementById(`${p}-memoryId`).value.trim() || buildSuggestedMemoryId(agent, domain);
  const timeframe = document.getElementById(`${p}-timeframe`).value || '1m';
  const riskProfile = document.getElementById(`${p}-risk`).value;

  const drafted = draftCache[agent]?.memory || null;

  const memory = drafted
    ? {
        ...drafted,
        memoryId,
        domain,
        timeframe,
        riskProfile
      }
    : {
        memoryId,
        domain,
        symbolSet: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        timeframe,
        riskProfile,
        benchmarkVersion: 'bench-v1.2',
        featureVersion: 'panel-v1',
        contentHash: `0x${crypto.randomUUID().replaceAll('-', '')}`,
        cid: `ipfs://${memoryId}`,
        ttlDays: 30
      };

  const payload = { memory };
  await post('/api/memories/commit', { auth: await makeAuth(agent, 'COMMIT_MEMORY', payload), ...payload });
}

async function doTransfer(fromAgent, toAgent) {
  const p = agentPrefix(fromAgent);
  const memoryId = document.getElementById(`${p}-memoryList`).value;
  if (!memoryId) throw new Error('先选择记忆片段');
  const payload = { memoryId, toAgentId: toAgent, note: 'panel-transfer' };
  await post('/api/memories/transfer', { auth: await makeAuth(fromAgent, 'TRANSFER_MEMORY', payload), ...payload });
}

async function doOpenMemory(agent) {
  const p = agentPrefix(agent);
  const memoryId = document.getElementById(`${p}-challengeMemory`).value;
  if (!memoryId) throw new Error('请先选择“我的记忆”中的一条');

  const out = await get(`/api/memories/detail/${encodeURIComponent(memoryId)}?includeStrategy=true`);
  const detail = out?.memory || null;
  if (!detail) throw new Error('MEMORY_DETAIL_EMPTY');

  const view = {
    openedAt: Math.floor(Date.now() / 1000),
    memoryId: detail.memoryId,
    sourceAgent: detail.sourceAgent,
    domain: detail.domain,
    timeframe: detail.timeframe,
    riskProfile: detail.riskProfile,
    benchmarkVersion: detail.benchmarkVersion,
    featureVersion: detail.featureVersion,
    state: detail.state,
    fitness: detail.fitness,
    symbolSet: detail.symbolSet,
    strategyBody: detail.strategyBody,
    strategyNote: detail.strategyNote,
    strategyBodyBytes: detail.strategyBodyBytes,
    strategyNoteBytes: detail.strategyNoteBytes,
    ttlUntil: detail.ttlUntil,
    updatedAt: detail.updatedAt
  };

  setMemoryDetail(agent, view);
  setMemoryPreview(agent, { openedAt: view.openedAt, memory: detail });

  if (simpleMode) {
    const opened = openMemoryModal(`记忆详情 · ${memoryId}`, detail);
    if (!opened) {
      alert(`${memoryId}\n\n${JSON.stringify(detail, null, 2)}`);
    }
  }
}

async function doDeleteMemory(agent) {
  const p = agentPrefix(agent);
  const memoryId = document.getElementById(`${p}-challengeMemory`).value;
  if (!memoryId) throw new Error('请先选择“我的记忆”中的一条');

  if (!confirm(`确认删除记忆片段 ${memoryId} ？\n将执行软删除（标记为 retired）。`)) {
    return;
  }

  const payload = { memoryId };
  await post('/api/memories/delete', {
    auth: await makeAuth(agent, 'DELETE_MEMORY', payload),
    ...payload
  });

  draftCache[agent] = null;
  const deletedAt = Math.floor(Date.now() / 1000);
  const deleted = { deletedMemoryId: memoryId, deletedAt, status: 'retired' };

  if (simpleMode) {
    const deletedAtText = new Date(deletedAt * 1000).toLocaleString();
    const friendly = `✅ 已软删除：${memoryId}\n状态：retired\n时间：${deletedAtText}`;
    setMemoryDetail(agent, friendly);
    setMemoryPreview(agent, friendly);
  } else {
    setMemoryDetail(agent, deleted);
    setMemoryPreview(agent, deleted);
  }
}

async function doChallenge(agent) {
  const p = agentPrefix(agent);
  const challengerMemoryId = document.getElementById(`${p}-challengeMemory`).value;
  if (!challengerMemoryId) throw new Error('请选择发起记忆');
  const roundsInput = Number(document.getElementById(`${p}-rounds`).value || 10);
  const rounds = simpleMode ? 10 : Math.max(1, Math.min(50, Math.floor(roundsInput || 10)));
  const matchModeInput = String(document.getElementById(`${p}-matchMode`)?.value || '').trim().toLowerCase();
  const matchMode = matchModeInput === 'ranked' ? 'ranked' : 'sparring';
  const payload = {
    challengerMemoryId,
    matchMode,
    rounds,
    benchmarkVersion: 'bench-v1.2',
    timeframe: '1m',
    symbolSet: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT']
  };
  await post('/api/battles/challenge', { auth: await makeAuth(agent, 'CHALLENGE_BATTLE', payload), ...payload });
}

async function doAccept(agent) {
  const p = agentPrefix(agent);
  const battleId = document.getElementById(`${p}-pendingBattle`).value;
  const opponentMemoryId = document.getElementById(`${p}-acceptMemory`).value;
  if (!battleId || !opponentMemoryId) throw new Error('请选择 battle 和应战记忆');
  const payload = { battleId, opponentMemoryId };
  await post(`/api/battles/${battleId}/accept`, { auth: await makeAuth(agent, 'ACCEPT_BATTLE', payload), opponentMemoryId });
}

async function doRun(agent) {
  const p = agentPrefix(agent);
  const battleId = document.getElementById(`${p}-pendingBattle`).value;
  if (!battleId) throw new Error('请选择 battle');
  const payload = { battleId, mode: 'paper-realtime' };
  await post(`/api/battles/${battleId}/run`, { auth: await makeAuth(agent, 'RUN_BATTLE', payload), mode: 'paper-realtime' });
}

async function maybeAttachRiskToken(auth, action) {
  try {
    const sys = await get('/api/system/status');
    const risk = sys?.security?.riskConfirmation;
    if (risk?.enabled && Array.isArray(risk.actions) && risk.actions.includes(action)) {
      const token = await post('/api/security/risk-token', {
        action,
        requestId: auth.requestId,
        payloadHash: auth.payloadHash
      });
      auth.riskToken = token.token;
    }
  } catch {
    // fallback: try without risk token
  }
}

async function doHiveBrowse(agent) {
  const p = agentPrefix(agent);
  const domain = document.getElementById(`${p}-hiveDomain`).value.trim();
  const q = document.getElementById(`${p}-hiveQuery`).value.trim();

  const url = new URL('/api/hive/memories', window.location.origin);
  url.searchParams.set('agentId', agent);
  url.searchParams.set('limit', '200');
  if (domain) url.searchParams.set('domain', domain);
  if (q) url.searchParams.set('q', q);

  const out = await get(`${url.pathname}${url.search}`);
  fillSelect(`${p}-hiveMemoryList`, out.memories || [], {
    value: (x) => x.memoryId,
    label: (x) => `${x.memoryId} | ${x.domain}/${x.memoryType || '-'} | heat ${Number(x.heat || 0)} | w ${Number(x.weightedScore || 0).toFixed(2)} | avg ${Number(x.avgScore || 0).toFixed(2)} (${Number(x.ratingCount || 0)})`
  });
  return out;
}

async function doHiveClone(agent) {
  const p = agentPrefix(agent);
  const memoryId = document.getElementById(`${p}-hiveMemoryList`).value;
  if (!memoryId) throw new Error('请先从蜂巢记忆库选择一条记忆');

  const payload = { memoryId, note: 'panel-hive-clone' };
  const auth = await makeAuth(agent, 'CLONE_HIVE_MEMORY', payload);
  await maybeAttachRiskToken(auth, 'CLONE_HIVE_MEMORY');

  await post(`/api/hive/memories/${encodeURIComponent(memoryId)}/clone`, { auth, note: payload.note });
}

async function doHiveRate(agent) {
  const p = agentPrefix(agent);
  const memoryId = document.getElementById(`${p}-hiveMemoryList`).value;
  if (!memoryId) throw new Error('请先从蜂巢记忆库选择一条记忆');

  const score = Number(document.getElementById(`${p}-hiveScore`).value || 0);
  if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error('评分必须在 1 到 5 之间');

  const note = document.getElementById(`${p}-hiveScoreNote`).value.trim();
  const payload = {
    memoryId,
    score,
    ...(note ? { note } : {})
  };
  const auth = await makeAuth(agent, 'RATE_HIVE_MEMORY', payload);
  await maybeAttachRiskToken(auth, 'RATE_HIVE_MEMORY');

  await post(`/api/hive/memories/${encodeURIComponent(memoryId)}/rate`, {
    auth,
    score,
    ...(note ? { note } : {})
  });
}

async function doRefreshLeaderboards() {
  const lb = await get('/api/hive/memories/leaderboards?limit=20&minRatingCount=1');
  renderLeaderboards(lb);
}

async function doHiveBrowseAll() {
  await Promise.all([doHiveBrowse('agent-a'), doHiveBrowse('agent-b')]);
}

async function doShowLineage() {
  const input = document.getElementById('lineageMemoryId');
  let memoryId = input.value.trim();
  if (!memoryId) {
    memoryId = document.getElementById('a-hiveMemoryList').value || document.getElementById('b-hiveMemoryList').value || '';
  }
  if (!memoryId) throw new Error('请先输入 memoryId 或选择一条蜂巢记忆');

  input.value = memoryId;
  const out = await get(`/api/hive/memories/${encodeURIComponent(memoryId)}/lineage?depth=4`);
  const nodes = Array.isArray(out.nodes) ? out.nodes : [];
  const edges = Array.isArray(out.edges) ? out.edges : [];

  const text = [
    `root=${out.rootMemoryId} depth=${out.depth} nodes=${out.nodeCount} edges=${out.edgeCount}`,
    '',
    'Nodes:',
    ...nodes.slice(0, 80).map((n) => `- ${n.memoryId} [${n.state}] ${n.domain}/${n.timeframe} fit=${Number(n.fitness || 0).toFixed(3)}`),
    '',
    'Edges:',
    ...edges.slice(0, 120).map(
      (e) =>
        `- ${e.type}: ${e.parentAMemoryId} + ${e.parentBMemoryId} -> ${e.childMemoryId} | sim=${Number(e.similarity || 0).toFixed(3)} | cluster=${e.clusterKey || 'n/a'}`
    )
  ].join('\n');

  hiveLineageEl.textContent = text;
}

async function doShowRecentRecombine() {
  const out = await get('/api/hive/recombinations/recent?limit=30');
  const rows = Array.isArray(out.rows) ? out.rows : [];
  hiveLineageEl.textContent = rows.length
    ? rows
        .map(
          (r, idx) =>
            `#${idx + 1} ${r.childMemoryId} [${r.childState || 'n/a'}]\n  parents: ${r.parentAMemoryId} + ${r.parentBMemoryId}\n  sim=${Number(r.similarity || 0).toFixed(3)} avgParent=${Number(r.avgParentScore || 0).toFixed(2)} cluster=${r.clusterKey || 'n/a'}`
        )
        .join('\n\n')
    : '暂无重组记录';
}

async function doDecodeProof() {
  const txHash = document.getElementById('proofTxHash').value.trim();
  if (!txHash) throw new Error('请输入 txHash');
  const r = await get(`/api/proofs/${encodeURIComponent(txHash)}/decode`);
  proofResultEl.textContent = JSON.stringify(r.proof, null, 2);
}

async function doExportProofs() {
  const r = await post('/api/proofs/export', {});
  proofResultEl.textContent = JSON.stringify(r, null, 2);
}

function initLayoutControls() {
  simpleMode = simpleModeEl ? Boolean(simpleModeEl.checked) : true;
  agentView = panelAgentViewEl?.value || 'agent-a';

  panelAgentViewEl?.addEventListener('change', () => {
    agentView = panelAgentViewEl.value;
    applyViewMode();
  });

  simpleModeEl?.addEventListener('change', () => {
    simpleMode = Boolean(simpleModeEl.checked);
    if (!simpleMode) diagnosticsVisible = true;
    applyViewMode();
  });

  ['agent-a', 'agent-b'].forEach((agent) => {
    const p = agentPrefix(agent);
    const memoryIdInput = document.getElementById(`${p}-memoryId`);
    const domainSelect = document.getElementById(`${p}-domain`);

    memoryIdInput?.addEventListener('input', () => {
      memoryIdInput.dataset.userEdited = 'true';
    });

    domainSelect?.addEventListener('change', () => {
      syncMemoryIdSuggestion(agent);
    });

    syncMemoryIdSuggestion(agent);
  });

  memoryModalCloseEl?.addEventListener('click', closeMemoryModal);
  memoryModalEl?.addEventListener('click', (event) => {
    if (event.target === memoryModalEl) closeMemoryModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMemoryModal();
  });

  applyViewMode();
}

document.querySelectorAll('button[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    const agent = btn.dataset.agent;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '处理中...';
    try {
      if (action === 'generateDraft') await doGenerateDraft(agent);
      else if (action === 'loadDraft') await doLoadDraft(agent);
      else if (action === 'commit') await doCommit(agent);
      else if (action === 'transferToB') await doTransfer('agent-a', 'agent-b');
      else if (action === 'transferToA') await doTransfer('agent-b', 'agent-a');
      else if (action === 'openMemory') await doOpenMemory(agent);
      else if (action === 'deleteMemory') await doDeleteMemory(agent);
      else if (action === 'challenge') await doChallenge(agent);
      else if (action === 'accept') await doAccept(agent);
      else if (action === 'run') await doRun(agent);
      else if (action === 'hiveBrowse') await doHiveBrowse(agent);
      else if (action === 'hiveClone') await doHiveClone(agent);
      else if (action === 'hiveRate') await doHiveRate(agent);
      else if (action === 'refreshLeaderboards') await doRefreshLeaderboards();
      else if (action === 'hiveBrowseAll') await doHiveBrowseAll();
      else if (action === 'showLineage') await doShowLineage();
      else if (action === 'showRecentRecombine') await doShowRecentRecombine();
      else if (action === 'decodeProof') await doDecodeProof();
      else if (action === 'exportProofs') await doExportProofs();
      else if (action === 'quickRefresh') {
        await post('/api/jobs/sweep-battles', {});
        logsInitialized = false;
      }
      else if (action === 'toggleDiagnostics') {
        diagnosticsVisible = !diagnosticsVisible;
        applyViewMode();
      }

      await refresh();

      const scope = actionScopeLabel(agent);
      const label = actionLabelFromButton(btn, old);
      const okMessage = action === 'toggleDiagnostics'
        ? `${scope}：${diagnosticsVisible ? '已显示诊断区' : '已隐藏诊断区'}`
        : `${scope}：${label}成功`;
      showActionFeedback(btn, 'success', `✅ ${okMessage}`, 3600);
      showToast('success', `✅ ${okMessage}`, 2200);
    } catch (err) {
      const scope = actionScopeLabel(agent);
      const label = actionLabelFromButton(btn, old);
      const detail = normalizeErrorMessage(err);
      const failMessage = `${scope}：${label}失败${detail ? `\n原因：${detail}` : ''}`;
      showActionFeedback(btn, 'error', `❌ ${failMessage}`, 9000);
      showToast('error', `❌ ${scope}：${label}失败`, 3200);
      statusEl.textContent = `error: ${detail || 'unknown error'}`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      if (action === 'toggleDiagnostics') applyViewMode();
    }
  });
});

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const interval = document.hidden ? 30000 : 5000;
  refreshTimer = setTimeout(async () => {
    await refresh();
    scheduleRefresh();
  }, interval);
}

document.addEventListener('visibilitychange', async () => {
  await refresh({ forceFullLogs: !document.hidden });
  scheduleRefresh();
});

initLayoutControls();
refresh({ forceFullLogs: true }).then(scheduleRefresh);
