import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);
const root = process.cwd();

async function run(cmd, args, env = {}, timeout = 180000) {
  const mergedEnv = { ...process.env, ...env };
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: root,
    env: mergedEnv,
    timeout,
    maxBuffer: 1024 * 1024
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

async function waitForHealth(baseUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('SERVER_HEALTH_TIMEOUT');
}

function startServer(port, env) {
  const child = spawn('npm', ['run', '-s', 'start'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', (d) => {
    logs += d.toString('utf8');
  });
  child.stderr.on('data', (d) => {
    logs += d.toString('utf8');
  });

  return {
    child,
    getLogs: () => logs
  };
}

function stopServer(server) {
  if (!server?.child || server.child.killed) return;
  server.child.kill('SIGTERM');
}

function makeMockCli(file) {
  fs.writeFileSync(
    file,
    `#!/bin/sh\n` +
      `echo '{"ok":true,"txHash":"0x1111111111111111111111111111111111111111111111111111111111111111","data":{"txHash":"0x1111111111111111111111111111111111111111111111111111111111111111"}}'\n`
  );
  fs.chmodSync(file, 0o755);
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function payloadHash(payload) {
  return `0x${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

async function requestJson(baseUrl, p, method = 'GET', body = null) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`${method} ${p} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function callPremium(baseUrl, requestIdPrefix = 'REGPREM') {
  const payload = { scope: 'domain', domain: 'spot' };
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    requestId: `${requestIdPrefix}-${Date.now()}`,
    agentId: 'agent-c',
    action: 'GET_PREMIUM_BUFF',
    payloadHash: payloadHash(payload),
    issuedAt: now,
    deadline: now + 120,
    arenaId: 'arena-main',
    chainId: 196,
    signature: '0xregression-signature'
  };

  return requestJson(baseUrl, '/api/hive/buffs/premium', 'POST', { auth, ...payload });
}

async function caseRun(name, port, env = {}, verifyFn = null) {
  const result = { name, ok: true, steps: [] };
  const push = (step, ok, extra = {}) => result.steps.push({ step, ok, ...extra });

  const safeName = name.replace(/[^a-z0-9_-]+/gi, '_');
  const dbPath = path.join(root, 'output', `regression-${safeName}.db`);
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // ignore
  }

  const caseEnv = { ...env, DB_PATH: dbPath };
  const server = startServer(port, caseEnv);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(baseUrl);
    push('health', true);

    if (verifyFn) {
      await verifyFn(baseUrl, push);
    } else {
      await run('npm', ['run', '-s', 'seed-demo'], { ...caseEnv, EVOHIVE_URL: baseUrl }, 120000);
      push('seed-demo', true);

      await run('npm', ['run', '-s', 'demo'], { ...caseEnv, EVOHIVE_URL: baseUrl }, 240000);
      push('demo', true);

      await run('npm', ['run', '-s', 'acceptance'], { ...caseEnv, EVOHIVE_URL: baseUrl }, 120000);
      push('acceptance', true);
    }
  } catch (err) {
    result.ok = false;
    push('run', false, {
      message: String(err?.message || err),
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || ''),
      serverLogs: server.getLogs().slice(-6000)
    });
  } finally {
    stopServer(server);
  }

  return result;
}

function requireCondition(ok, message) {
  if (!ok) throw new Error(message);
}

(async () => {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const outDir = path.join(root, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const mockCli = path.join(outDir, 'mock-onchainos.sh');
  makeMockCli(mockCli);

  const x402BaseEnv = {
    ONCHAIN_MODE: 'hybrid',
    AUTH_SIGNATURE_MODE: 'legacy',
    RISK_CONFIRMATION_REQUIRED: 'false',
    ONCHAINOS_SKILL_ENABLED: 'true',
    ONCHAINOS_SKILL_USE_CLI: 'true',
    ONCHAINOS_SKILL_CLI_BIN: mockCli,
    ONCHAINOS_SKILL_X402_NETWORK: 'eip155:196',
    ONCHAINOS_SKILL_X402_PAY_TO: '0x80d2a8db980b19df46415c56b1833c07d14506cc',
    ONCHAINOS_SKILL_X402_ASSET: '0x74b7f16337b8972027f6196a17a631ac6de26d22',
    ONCHAINOS_SKILL_USDC_TOKEN: '0x74b7f16337b8972027f6196a17a631ac6de26d22',
    ONCHAINOS_EVENT_TX_TO: '0x80d2a8db980b19df46415c56b1833c07d14506cc',
    ONCHAINOS_EVENT_DISABLE_HTTP_FALLBACK_WHEN_TX_TO: 'true'
  };

  const cases = [];

  cases.push(
    await caseRun('stub-baseline', 4340, {
      ONCHAIN_MODE: 'stub',
      AUTH_SIGNATURE_MODE: 'legacy'
    })
  );

  cases.push(
    await caseRun('premium-success-path', 4341, x402BaseEnv, async (baseUrl, push) => {
      const premium = await callPremium(baseUrl, 'REGPREM-SUCCESS');
      requireCondition(Boolean(premium.paymentTxHash), 'paymentTxHash missing');
      requireCondition(Boolean(premium.burnTxHash), 'burnTxHash missing');
      requireCondition(Boolean(premium.paymentTxLive), 'paymentTxLive should be true in mock live-sim case');
      requireCondition(Boolean(premium.burnTxLive), 'burnTxLive should be true in mock live-sim case');
      push('premium-success', true, {
        paymentTxHash: premium.paymentTxHash,
        burnTxHash: premium.burnTxHash,
        paymentHashType: premium.paymentHashType || null
      });
    })
  );

  cases.push(
    await caseRun(
      'event-degraded-path',
      4342,
      {
        ...x402BaseEnv,
        ONCHAINOS_SKILL_EVENT_CMD: 'node -e "process.exit(2)"'
      },
      async (baseUrl, push) => {
        const premium = await callPremium(baseUrl, 'REGPREM-DEGRADED');
        requireCondition(premium.eventSource === 'degraded-local-proof', `eventSource expected degraded-local-proof, got ${premium.eventSource}`);
        requireCondition(Boolean(premium.paymentTxLive), 'paymentTxLive expected true');
        requireCondition(Boolean(premium.burnTxLive), 'burnTxLive expected true');
        push('event-degraded', true, {
          eventSource: premium.eventSource,
          eventTxLive: premium.eventTxLive
        });
      }
    )
  );

  cases.push(
    await caseRun('reconcile-coverage-guard', 4343, x402BaseEnv, async (baseUrl, push) => {
      const pre = await requestJson(baseUrl, '/api/jobs/reconcile', 'POST', {
        coverageWindowSec: 86400,
        requireEventLive: false,
        minFinalitySec: 0,
        excludeTestOnly: false
      });
      requireCondition(Boolean(pre.summary), 'reconcile pre summary missing');
      requireCondition(pre.summary.coverage?.ok === false, 'pre coverage should be false before premium sample');
      push('reconcile-pre-missing-sample', true, { coverage: pre.summary.coverage });

      await callPremium(baseUrl, 'REGPREM-RECONCILE');
      const post = await requestJson(baseUrl, '/api/jobs/reconcile', 'POST', {
        coverageWindowSec: 86400,
        requireEventLive: false,
        minFinalitySec: 0,
        excludeTestOnly: false
      });
      requireCondition(Boolean(post.summary.coverage?.ok), 'post coverage should be true after premium sample');
      requireCondition(Boolean(post.summary.coverage?.liveOk), 'post liveOk should be true after premium sample');
      requireCondition(Number(post.summary.mismatch || 0) === 0, 'post mismatch should be 0');
      push('reconcile-post-covered', true, { coverage: post.summary.coverage, mismatch: post.summary.mismatch });
    })
  );

  const report = {
    generatedAt: new Date().toISOString(),
    cases,
    pass: cases.filter((c) => c.ok).length,
    fail: cases.filter((c) => !c.ok).length
  };

  const file = path.join(outDir, `regression-matrix-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Regression matrix report: ${file}`);
  if (report.fail > 0) process.exit(1);
})();
