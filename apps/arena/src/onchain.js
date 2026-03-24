import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { exec as execCallback, execFile as execFileCallback } from 'node:child_process';
import { config } from './config.js';
import {
  assertCircuit,
  markOnchainFailure,
  markOnchainSuccess,
  nextBackoffMs,
  enqueueOnchainRetry,
  maybeInjectFault,
  circuitSnapshot,
  leaseOnchainRetryJobs,
  completeOnchainRetryJob,
  failOnchainRetryJob,
  shouldEnqueueOnchainError
} from './resilience.js';

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

function fakeTxHash(prefix) {
  return `0x${crypto.createHash('sha256').update(`${prefix}:${Date.now()}:${Math.random()}`).digest('hex')}`;
}

function resolveMode() {
  const mode = config.onchain.mode;
  if (mode === 'stub' || mode === 'live' || mode === 'hybrid') return mode;
  return config.onchain.baseUrl ? 'live' : 'stub';
}

function hasEventTxToConfigured() {
  return Boolean(String(config.onchain.eventTxTo || '').trim());
}

function shouldDisableEventHttpFallback() {
  return Boolean(config.onchain.disableEventHttpFallbackWhenTxTo) && hasEventTxToConfigured();
}

function resolveBurnFromAddress() {
  const explicit = String(config.onchain.skill.burnFrom || '').trim();
  if (explicit) return explicit;
  if (config.onchain.skill.burnFromX402PayTo) {
    const payTo = String(config.onchain.skill.x402PayTo || '').trim();
    if (payTo) return payTo;
  }
  return String(config.onchain.skill.walletFrom || '').trim();
}

export function x402PreflightStatus() {
  const mode = resolveMode();
  const usesSkillCli = mode === 'hybrid' && config.onchain.skill.enabled && config.onchain.skill.useCli;

  if (!usesSkillCli) {
    return {
      ok: true,
      level: 'ok',
      code: null,
      message: 'x402 CLI preflight not required in current mode',
      missing: [],
      blocking: false,
      hasHttpFallback: Boolean(config.onchain.baseUrl || config.onchain.x402VerifyFallbackUrl),
      hasCustomVerifyCmd: Boolean(String(config.onchain.skill.verifyCmd || '').trim())
    };
  }

  const missing = [];
  if (!String(config.onchain.skill.x402Network || '').trim()) missing.push('ONCHAINOS_SKILL_X402_NETWORK');
  if (!String(config.onchain.skill.x402PayTo || '').trim()) missing.push('ONCHAINOS_SKILL_X402_PAY_TO');
  if (!String(config.onchain.skill.x402Asset || '').trim()) missing.push('ONCHAINOS_SKILL_X402_ASSET');

  const hasHttpFallback = Boolean(
    String(config.onchain.baseUrl || '').trim() || String(config.onchain.x402VerifyFallbackUrl || '').trim()
  );
  const hasCustomVerifyCmd = Boolean(String(config.onchain.skill.verifyCmd || '').trim());
  const ok = missing.length === 0;
  const blocking = !ok && !hasHttpFallback && !hasCustomVerifyCmd;

  return {
    ok,
    level: ok ? 'ok' : 'warn',
    code: ok ? null : 'X402_CONFIG_MISSING',
    message: ok
      ? 'x402 CLI preflight passed'
      : `Missing ${missing.join(', ')}${blocking ? ' (no HTTP/custom fallback available)' : ' (HTTP/custom fallback available)'}`,
    missing,
    blocking,
    hasHttpFallback,
    hasCustomVerifyCmd
  };
}

export function onchainRuntimeStatus() {
  return {
    mode: resolveMode(),
    circuit: circuitSnapshot(),
    resilience: config.onchain.resilience,
    event: {
      txToConfigured: hasEventTxToConfigured(),
      httpFallbackDisabled: shouldDisableEventHttpFallback(),
      customCmdConfigured: Boolean(String(config.onchain.skill.eventCmd || '').trim()),
      skillEnabled: Boolean(config.onchain.skill.enabled)
    },
    verify: {
      httpPrimaryConfigured: Boolean(String(config.onchain.baseUrl || '').trim()),
      fallbackConfigured: Boolean(String(config.onchain.x402VerifyFallbackUrl || '').trim()),
      x402From: String(config.onchain.skill.x402From || '').trim() || null,
      x402FromAccountId: String(config.onchain.skill.x402FromAccountId || '').trim() || null
    },
    burn: {
      sender: resolveBurnFromAddress() || null,
      senderAccountId: String(config.onchain.skill.burnFromAccountId || '').trim() || null,
      fromX402PayTo: Boolean(config.onchain.skill.burnFromX402PayTo),
      minGasToken: Number(config.onchain.skill.burnMinGasToken || 0)
    },
    preflight: {
      x402: x402PreflightStatus()
    }
  };
}

function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    const chunks = p.split('.');
    let ok = true;
    for (const c of chunks) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, c)) {
        cur = cur[c];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null && String(cur).length > 0) return cur;
  }
  return undefined;
}

function parseJsonFromStdout(stdout, context) {
  const out = String(stdout || '').trim();
  if (!out) throw new Error(`${context}_EMPTY_STDOUT`);

  try {
    return JSON.parse(out);
  } catch {
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const maybe = out.slice(first, last + 1);
      try {
        return JSON.parse(maybe);
      } catch {
        // continue
      }
    }
    throw new Error(`${context}_INVALID_JSON:${out}`);
  }
}

function toBaseUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`INVALID_DECIMAL_AMOUNT:${s}`);
  const [ints, fracs = ''] = s.split('.');
  const frac = (fracs + '0'.repeat(decimals)).slice(0, decimals);
  return `${BigInt(ints) * 10n ** BigInt(decimals) + BigInt(frac || '0')}`;
}

async function postOnchainUrl(url, payload, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || config.onchain.timeoutMs || 10000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const apiKey = options.apiKey != null ? options.apiKey : config.onchain.apiKey;
  const reqHeaders = { 'content-type': 'application/json' };
  if (apiKey) reqHeaders.authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();
    let json = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }

    if (!res.ok) {
      throw new Error(`ONCHAINOS_HTTP_${res.status}:${JSON.stringify(json)}`);
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function postOnchain(path, payload) {
  const baseUrl = String(config.onchain.baseUrl || '').trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('ONCHAINOS_BASE_URL_MISSING');
  return postOnchainUrl(`${baseUrl}${path}`, payload);
}

async function postVerifyWithFallback(payload) {
  const primaryBaseUrl = String(config.onchain.baseUrl || '').trim().replace(/\/$/, '');
  const fallbackUrl = String(config.onchain.x402VerifyFallbackUrl || '').trim();
  const errors = [];

  if (primaryBaseUrl) {
    try {
      return await postOnchainUrl(`${primaryBaseUrl}${config.onchain.x402VerifyPath}`, payload, {
        apiKey: config.onchain.apiKey
      });
    } catch (err) {
      errors.push(`primary:${String(err?.message || err)}`);
    }
  } else {
    errors.push('primary:ONCHAINOS_BASE_URL_MISSING');
  }

  if (fallbackUrl) {
    try {
      return await postOnchainUrl(fallbackUrl, payload, {
        apiKey: config.onchain.x402VerifyFallbackApiKey || config.onchain.apiKey
      });
    } catch (err) {
      errors.push(`fallback:${String(err?.message || err)}`);
    }
  } else {
    errors.push('fallback:ONCHAINOS_X402_VERIFY_FALLBACK_URL_MISSING');
  }

  throw new Error(`ONCHAINOS_VERIFY_HTTP_FAILED:${errors.join(' | ')}`);
}

function skillCmdFor(action) {
  if (!config.onchain.skill.enabled) return '';
  if (action === 'verify') return config.onchain.skill.verifyCmd;
  if (action === 'burn') return config.onchain.skill.burnCmd;
  if (action === 'event') return config.onchain.skill.eventCmd;
  return '';
}

async function callSkillCustom(action, payload) {
  const command = skillCmdFor(action);
  if (!command) throw new Error(`ONCHAINOS_SKILL_${action.toUpperCase()}_CMD_MISSING`);

  const { stdout } = await exec(command, {
    timeout: config.onchain.skill.timeoutMs,
    cwd: projectRoot,
    env: {
      ...process.env,
      EVOHIVE_ACTION: action,
      EVOHIVE_PAYLOAD_JSON: JSON.stringify(payload)
    }
  });

  return parseJsonFromStdout(stdout, `ONCHAINOS_SKILL_${action.toUpperCase()}`);
}

function shouldRetrySkillCmdError(msg) {
  const t = String(msg || '').toLowerCase();
  return (
    shouldRetryCliError(t) ||
    t.includes('event_hook_failed') ||
    t.includes('web3.okx.com') ||
    t.includes('onchainos_skill_event_invalid_json') ||
    t.includes('socket hang up') ||
    t.includes('network error')
  );
}

async function callSkillCustomWithRetry(action, payload, maxAttempts = config.onchain.resilience.maxAttempts) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      maybeInjectFault(action);
      return await callSkillCustom(action, payload);
    } catch (err) {
      lastErr = err;
      const detail = extractCliErrorText(err);
      if (attempt >= maxAttempts || !shouldRetrySkillCmdError(detail)) {
        throw err;
      }
      const backoffMs = nextBackoffMs(attempt);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function runOnchainCli(args, payload, action) {
  const cliArgs = [];
  if (config.onchain.baseUrl) cliArgs.push('--base-url', config.onchain.baseUrl);
  cliArgs.push(...args);

  try {
    const { stdout } = await execFile(config.onchain.skill.cliBin, cliArgs, {
      timeout: config.onchain.skill.timeoutMs,
      env: {
        ...process.env,
        EVOHIVE_ACTION: action,
        EVOHIVE_PAYLOAD_JSON: JSON.stringify(payload),
        OKX_API_KEY: config.onchain.skill.okxApiKey || process.env.OKX_API_KEY || '',
        OKX_SECRET_KEY: config.onchain.skill.okxSecretKey || process.env.OKX_SECRET_KEY || '',
        OKX_PASSPHRASE: config.onchain.skill.okxPassphrase || process.env.OKX_PASSPHRASE || ''
      },
      maxBuffer: 1024 * 1024
    });

    return parseJsonFromStdout(stdout, `ONCHAINOS_CLI_${action.toUpperCase()}`);
  } catch (err) {
    const stderr = String(err?.stderr || '').trim();
    const stdout = String(err?.stdout || '').trim();
    const signal = String(err?.signal || '');
    const code = err?.code != null ? String(err.code) : '';
    const detail = stderr || stdout || String(err?.message || err);
    throw new Error(`ONCHAINOS_CLI_EXEC_FAILED:${detail}${signal ? `|signal=${signal}` : ''}${code ? `|code=${code}` : ''}`);
  }
}

function extractCliErrorText(err) {
  return [err?.message, err?.stdout, err?.stderr].filter(Boolean).join(' | ');
}

function shouldRetryCliError(msg) {
  const t = String(msg || '').toLowerCase();
  return (
    t.includes('another order processing') ||
    t.includes('connection reset') ||
    t.includes('tls handshake') ||
    t.includes('ssl_error_syscall') ||
    t.includes('recv failure') ||
    t.includes('timed out') ||
    t.includes('timeout') ||
    t.includes('econnreset') ||
    t.includes('eof') ||
    t.includes('command failed') ||
    t.includes('signal=sigterm') ||
    t.includes('fetch failed')
  );
}

async function runOnchainCliWithRetry(args, payload, action, maxAttempts = config.onchain.resilience.maxAttempts) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      maybeInjectFault(action);
      return await runOnchainCli(args, payload, action);
    } catch (err) {
      lastErr = err;
      const detail = extractCliErrorText(err);
      if (attempt >= maxAttempts || !shouldRetryCliError(detail)) {
        throw new Error(detail || String(err?.message || err));
      }
      const backoffMs = nextBackoffMs(attempt);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function callSkillViaCli(action, payload) {
  if (!config.onchain.skill.useCli) throw new Error('ONCHAINOS_SKILL_CLI_DISABLED');

  if (action === 'verify') {
    const network = config.onchain.skill.x402Network;
    const payTo = config.onchain.skill.x402PayTo;
    const asset = config.onchain.skill.x402Asset;
    if (!network || !payTo || !asset) {
      throw new Error('ONCHAINOS_SKILL_X402_CONFIG_MISSING');
    }

    const amountMinimal = toBaseUnits(payload.amountUsdc, config.onchain.skill.x402AmountDecimals);
    const args = ['payment', 'x402-pay', '--network', network, '--amount', amountMinimal, '--pay-to', payTo, '--asset', asset];
    if (config.onchain.skill.x402From) args.push('--from', config.onchain.skill.x402From);

    try {
      const result = await runOnchainCliWithRetry(args, payload, action, 6);
      const authorization = pick(result, ['authorization', 'data.authorization']);
      const signature = pick(result, ['signature', 'data.signature']);
      const paymentProof = authorization && signature ? { authorization, signature } : undefined;
      const paymentProofHash = paymentProof
        ? `0x${crypto.createHash('sha256').update(JSON.stringify(paymentProof)).digest('hex')}`
        : undefined;

      const paymentTxHash =
        pick(result, ['paymentTxHash', 'txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']) ||
        paymentProofHash ||
        fakeTxHash('skill-verify');

      return {
        ok: Boolean(result.ok ?? true),
        paymentTxHash,
        paymentProof,
        paymentProofHash,
        source: 'skill-cli-x402',
        raw: result
      };
    } catch (x402Err) {
      if (!config.onchain.skill.verifyFallbackWallet) {
        throw x402Err;
      }

      // Optional fallback: direct wallet micro-transfer as payment proof.
      const walletArgs = [
        'wallet',
        'send',
        '--amount',
        String(payload.amountUsdc),
        '--receipt',
        payTo,
        '--chain',
        String(config.onchain.skill.walletChain)
      ];
      if (config.onchain.skill.walletFrom) walletArgs.push('--from', config.onchain.skill.walletFrom);
      if (config.onchain.skill.usdcToken) walletArgs.push('--contract-token', config.onchain.skill.usdcToken);
      if (config.onchain.skill.walletForce) walletArgs.push('--force');

      const walletResult = await runOnchainCliWithRetry(walletArgs, payload, action, 6);
      const paymentTxHash =
        pick(walletResult, ['paymentTxHash', 'txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']) ||
        fakeTxHash('skill-verify-wallet-fallback');

      return {
        ok: Boolean(walletResult.ok ?? true),
        paymentTxHash,
        source: 'skill-cli-wallet-fallback',
        raw: {
          x402Error: String(x402Err?.message || x402Err),
          walletResult
        }
      };
    }
  }

  if (action === 'burn') {
    const burnFrom = resolveBurnFromAddress();
    const payerFrom = String(config.onchain.skill.x402From || config.onchain.skill.walletFrom || '').trim();

    let topupResult = null;
    let topupTxHash = null;
    let topupLatencyMs = null;
    let burnLatencyMs = null;

    // Two-step burn mode: first transfer token to burn sender account, then burn from that account.
    if (config.onchain.skill.burnFromX402PayTo && burnFrom && payerFrom && burnFrom.toLowerCase() !== payerFrom.toLowerCase()) {
      const topupArgs = [
        'wallet',
        'send',
        '--amount',
        String(payload.amount),
        '--receipt',
        burnFrom,
        '--chain',
        String(config.onchain.skill.walletChain)
      ];

      if (payerFrom) topupArgs.push('--from', payerFrom);
      if (config.onchain.skill.usdcToken) topupArgs.push('--contract-token', config.onchain.skill.usdcToken);
      if (config.onchain.skill.walletForce) topupArgs.push('--force');

      const topupStartedAt = Date.now();
      topupResult = await runOnchainCliWithRetry(topupArgs, payload, `${action}-topup`, 6);
      topupLatencyMs = Date.now() - topupStartedAt;
      topupTxHash =
        pick(topupResult, ['txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']) ||
        fakeTxHash('skill-burn-topup');
    }

    const args = [
      'wallet',
      'send',
      '--amount',
      String(payload.amount),
      '--receipt',
      payload.to || config.burnAddress,
      '--chain',
      String(config.onchain.skill.walletChain)
    ];

    if (burnFrom) args.push('--from', burnFrom);
    if (config.onchain.skill.usdcToken) args.push('--contract-token', config.onchain.skill.usdcToken);
    if (config.onchain.skill.walletForce) args.push('--force');

    let result;
    try {
      const burnStartedAt = Date.now();
      result = await runOnchainCliWithRetry(args, payload, action, 6);
      burnLatencyMs = Date.now() - burnStartedAt;
    } catch (err) {
      const detail = String(err?.message || err);
      if (topupTxHash) {
        throw new Error(`BURN_AFTER_TOPUP_FAILED:topupTxHash=${topupTxHash}:${detail}`);
      }
      throw err;
    }

    const burnTxHash =
      pick(result, ['burnTxHash', 'txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']) ||
      fakeTxHash('skill-burn');

    return {
      ok: Boolean(result.ok ?? true),
      burnTxHash,
      topupTxHash,
      topupLatencyMs,
      burnLatencyMs,
      burnAddress: payload.to || config.burnAddress,
      burnFrom: burnFrom || null,
      explorerLink: `https://www.oklink.com/xlayer/tx/${String(burnTxHash).replace(/^0x/, '')}`,
      source: 'skill-cli',
      raw: {
        topup: topupResult,
        burn: result
      }
    };
  }

  throw new Error('ONCHAINOS_CLI_EVENT_UNSUPPORTED');
}

async function callSkill(action, payload) {
  const errors = [];

  if (config.onchain.skill.useCli) {
    try {
      return await callSkillViaCli(action, payload);
    } catch (err) {
      errors.push(`cli:${String(err.message || err)}`);
    }
  }

  const command = skillCmdFor(action);
  if (command) {
    try {
      const result = await callSkillCustomWithRetry(action, payload, action === 'event' ? 6 : 3);
      return { ...result, source: 'skill-cmd' };
    } catch (err) {
      errors.push(`cmd:${String(err.message || err)}`);
    }
  }

  throw new Error(`ONCHAINOS_SKILL_CALL_FAILED:${errors.join(' | ') || 'NO_SKILL_HANDLER'}`);
}

async function resolveWithHybrid(action, payload, liveHandler, options = {}) {
  const mode = resolveMode();

  if (mode === 'stub') return { result: null, source: 'stub' };

  assertCircuit(action);

  if (mode === 'hybrid') {
    const forceHttpPrimary = options.forceHttpPrimary === true;

    if (forceHttpPrimary) {
      try {
        const result = await liveHandler();
        markOnchainSuccess(action);
        return { result, source: 'http-primary' };
      } catch (httpErr) {
        const msg = `HYBRID_HTTP_PRIMARY_FAILED | reason=${String(options.skillBypassReason || 'n/a')} | http=${String(httpErr?.message || httpErr)}`;
        markOnchainFailure(action, msg);
        if (options.enqueueOnFail !== false && shouldEnqueueOnchainError(msg)) {
          enqueueOnchainRetry(action, payload, msg, 20);
        }
        throw new Error(msg);
      }
    }

    try {
      const result = await callSkill(action, payload);
      markOnchainSuccess(action);
      return { result, source: result.source || 'skill' };
    } catch (skillErr) {
      if (action === 'event' && shouldDisableEventHttpFallback()) {
        const msg = `EVENT_HTTP_FALLBACK_DISABLED | skill=${String(skillErr?.message || skillErr)}`;
        markOnchainFailure(action, msg);
        if (options.enqueueOnFail !== false && shouldEnqueueOnchainError(msg)) {
          enqueueOnchainRetry(action, payload, msg, 20);
        }
        throw new Error(msg);
      }

      try {
        const result = await liveHandler();
        markOnchainSuccess(action);
        return { result, source: 'http-fallback' };
      } catch (httpErr) {
        const msg = `HYBRID_BOTH_FAILED | skill=${String(skillErr?.message || skillErr)} | http=${String(httpErr?.message || httpErr)}`;
        markOnchainFailure(action, msg);
        if (options.enqueueOnFail !== false && shouldEnqueueOnchainError(msg)) {
          enqueueOnchainRetry(action, payload, msg, 20);
        }
        throw new Error(msg);
      }
    }
  }

  try {
    const result = await liveHandler();
    markOnchainSuccess(action);
    return { result, source: 'http' };
  } catch (err) {
    const msg = String(err?.message || err);
    markOnchainFailure(action, msg);
    if (options.enqueueOnFail !== false && shouldEnqueueOnchainError(msg)) {
      enqueueOnchainRetry(action, payload, msg, 20);
    }
    throw err;
  }
}

export async function verifyX402Payment({ requestId, amountUsdc }, options = {}) {
  if (resolveMode() === 'stub') {
    return {
      ok: true,
      requestId,
      amountUsdc,
      paymentTxHash: fakeTxHash('payment'),
      paymentTxLive: false,
      paymentHashType: 'local',
      mode: 'stub',
      source: 'stub'
    };
  }

  const payload = {
    requestId,
    amountUsdc,
    token: 'USDC',
    chainId: config.chainId,
    arenaId: config.arenaId
  };

  const preflight = x402PreflightStatus();
  if (!preflight.ok && preflight.blocking) {
    const msg = `X402_CONFIG_MISSING:${preflight.missing.join(',')}`;
    markOnchainFailure('verify', msg);
    throw new Error(msg);
  }

  const preferHttpWhenX402Missing =
    !preflight.ok &&
    config.onchain.verifyPreferHttpWhenX402Missing &&
    preflight.hasHttpFallback;

  const { result, source } = await resolveWithHybrid('verify', payload, () => postVerifyWithFallback(payload), {
    ...options,
    forceHttpPrimary: Boolean(preferHttpWhenX402Missing),
    skillBypassReason: preferHttpWhenX402Missing ? `X402_CONFIG_MISSING:${preflight.missing.join(',')}` : undefined
  });

  const paymentProof = pick(result, ['paymentProof', 'data.paymentProof']);
  const paymentProofHash =
    pick(result, ['paymentProofHash', 'data.paymentProofHash']) ||
    (paymentProof ? `0x${crypto.createHash('sha256').update(JSON.stringify(paymentProof)).digest('hex')}` : undefined);

  const paymentTxHashFromResult = pick(result, [
    'paymentTxHash',
    'txHash',
    'hash',
    'data.txHash',
    'data.hash',
    'data.transactionHash'
  ]);

  const paymentTxHash = paymentTxHashFromResult || paymentProofHash || fakeTxHash('payment-fallback');
  const paymentLooksLikeProof =
    Boolean(paymentProofHash && paymentTxHash) &&
    String(paymentProofHash).toLowerCase() === String(paymentTxHash).toLowerCase();

  const paymentHashType = paymentLooksLikeProof
    ? 'proof'
    : paymentTxHashFromResult
      ? 'tx'
      : paymentProofHash
        ? 'proof'
        : 'synthetic';

  const paymentTxLive = paymentHashType === 'tx' && source !== 'stub';

  return {
    ok: Boolean(result.ok ?? true),
    requestId,
    amountUsdc,
    paymentTxHash,
    paymentTxLive,
    paymentHashType,
    paymentProofHash,
    paymentProof,
    mode: resolveMode(),
    source,
    x402Preflight: preflight,
    raw: result
  };
}

export async function burnAntiSybilFee({ requestId, payerAgent, amountUsdc }, options = {}) {
  if (resolveMode() === 'stub') {
    return {
      ok: true,
      requestId,
      payerAgent,
      amountUsdc,
      burnAddress: config.burnAddress,
      burnTxHash: fakeTxHash('burn'),
      burnTxLive: false,
      explorerLink: `https://www.oklink.com/xlayer/tx/${fakeTxHash('explorer').slice(2, 66)}`,
      mode: 'stub',
      source: 'stub'
    };
  }

  const payload = {
    requestId,
    fromAgent: payerAgent,
    to: config.burnAddress,
    token: 'USDC',
    amount: amountUsdc,
    chainId: config.chainId,
    purpose: 'anti-sybil-burn'
  };

  const { result, source } = await resolveWithHybrid(
    'burn',
    payload,
    () => postOnchain(config.onchain.walletTransferPath, payload),
    options
  );

  const burnTxHashFromResult = pick(result, ['burnTxHash', 'txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']);
  const burnTxHash = burnTxHashFromResult || fakeTxHash('burn-fallback');
  const burnTxLive = Boolean(burnTxHashFromResult) && source !== 'stub';

  return {
    ok: Boolean(result.ok ?? true),
    requestId,
    payerAgent,
    amountUsdc,
    burnAddress: pick(result, ['burnAddress', 'to', 'data.to']) || config.burnAddress,
    burnFrom: pick(result, ['burnFrom', 'from', 'data.from']) || resolveBurnFromAddress() || null,
    topupTxHash: pick(result, ['topupTxHash', 'data.topupTxHash']) || null,
    topupLatencyMs: Number(pick(result, ['topupLatencyMs', 'data.topupLatencyMs']) || 0) || null,
    burnLatencyMs: Number(pick(result, ['burnLatencyMs', 'data.burnLatencyMs']) || 0) || null,
    burnTxHash,
    burnTxLive,
    explorerLink: pick(result, ['explorerLink', 'data.explorerLink']) || `https://www.oklink.com/xlayer/tx/${String(burnTxHash).replace(/^0x/, '')}`,
    mode: resolveMode(),
    source,
    raw: result
  };
}

export async function processOnchainRetryJobs(limit = 20) {
  const jobs = leaseOnchainRetryJobs(limit);
  const summary = { picked: jobs.length, done: 0, failed: 0 };

  for (const job of jobs) {
    try {
      if (job.action === 'verify') {
        await verifyX402Payment(job.payload || {}, { enqueueOnFail: false });
      } else if (job.action === 'burn') {
        await burnAntiSybilFee(
          {
            requestId: job.payload?.requestId,
            payerAgent: job.payload?.fromAgent || job.payload?.payerAgent || 'agent-unknown',
            amountUsdc: Number(job.payload?.amount || job.payload?.amountUsdc || config.premiumBuffFeeUsdc)
          },
          { enqueueOnFail: false }
        );
      } else if (job.action === 'event') {
        const p = job.payload || {};
        await emitEventProof(p.eventName || 'Unknown', p.payload || p, { enqueueOnFail: false });
      }
      completeOnchainRetryJob(job.id);
      summary.done += 1;
    } catch (err) {
      failOnchainRetryJob(job.id, Number(job.attempts || 0) + 1, String(err?.message || err));
      summary.failed += 1;
    }
  }

  return summary;
}

export async function emitEventProof(eventName, payload, options = {}) {
  if (resolveMode() === 'stub') {
    return {
      ok: true,
      eventName,
      payload,
      eventTxHash: fakeTxHash(`event:${eventName}`),
      eventTxLive: false,
      eventMode: 'local',
      eventTarget: null,
      mode: 'stub',
      source: 'stub'
    };
  }

  const body = {
    eventName,
    payload,
    chainId: config.chainId,
    arenaId: config.arenaId
  };

  try {
    const { result, source } = await resolveWithHybrid(
      'event',
      body,
      () => postOnchain(config.onchain.eventProofPath, body),
      options
    );

    const eventTxHashFromResult = pick(result, ['eventTxHash', 'txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']);
    const eventTxHash = eventTxHashFromResult || fakeTxHash(`event:${eventName}:fallback`);
    const eventTxLive = Boolean(eventTxHashFromResult) && source !== 'stub';

    return {
      ok: Boolean(result.ok ?? true),
      eventName,
      payload,
      eventTxHash,
      eventTxLive,
      eventMode: result.eventMode || (eventTxLive ? 'live' : 'local'),
      eventTarget: result.eventTarget || null,
      mode: resolveMode(),
      source,
      raw: result
    };
  } catch (error) {
    const errMsg = String(error.message || error);
    if (options.enqueueOnFail !== false && shouldEnqueueOnchainError(errMsg)) {
      enqueueOnchainRetry('event', body, errMsg, 30);
    }
    // Event proof path is not always available in hybrid/public setups.
    // Degrade gracefully to local proof so battle/premium pipelines can continue.
    return {
      ok: true,
      eventName,
      payload,
      eventTxHash: fakeTxHash(`event:${eventName}:degraded`),
      eventTxLive: false,
      eventMode: 'degraded-local',
      eventTarget: null,
      mode: resolveMode(),
      source: 'degraded-local-proof',
      raw: { error: errMsg }
    };
  }
}
