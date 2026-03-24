#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { Interface, getAddress, hexlify, isHexString, keccak256, toUtf8Bytes } from 'ethers';

const execFileAsync = promisify(execFile);

const ABI = [
  'function recordMemory(bytes32 memoryHash,address agent,string tags,bytes32 cidHash)',
  'function transferMemory(bytes32 memoryHash,address from,address to,address operator)',
  'function recordBattle(bytes32 battleId,address winner,uint256 scoreA,uint256 scoreB,bytes32 resultHash)',
  'function recordAntiSybilBurn(bytes32 requestId,address payer,address burnAddress,uint256 amount,bytes32 burnTxHash)'
];

const iface = new Interface(ABI);

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${label}_INVALID_JSON`);
  }
}

function pick(obj, paths) {
  for (const p of paths) {
    const chunks = p.split('.');
    let cur = obj;
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

function toBytes32(value) {
  const s = String(value ?? '').trim();
  if (isHexString(s, 32)) return s.toLowerCase();
  if (!s) return `0x${'00'.repeat(32)}`;
  return keccak256(toUtf8Bytes(s));
}

function toChecksumAddress(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  try {
    return getAddress(v);
  } catch {
    return '';
  }
}

function toScaledInt(value, decimals = 6) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return 0n;
  const [ints, fracs = ''] = s.split('.');
  const frac = (fracs + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(ints) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

function loadAgentMap() {
  const raw = process.env.ONCHAINOS_AGENT_ADDRESS_MAP_JSON || '{}';
  const parsed = parseJson(raw, 'ONCHAINOS_AGENT_ADDRESS_MAP_JSON');
  const out = {};
  for (const [k, v] of Object.entries(parsed || {})) {
    const addr = toChecksumAddress(v);
    if (addr) out[String(k)] = addr;
  }
  return out;
}

function resolveAgentAddress(agentLike, map, fallback) {
  const direct = toChecksumAddress(agentLike);
  if (direct) return direct;
  const mapped = toChecksumAddress(map[String(agentLike)]);
  if (mapped) return mapped;
  return toChecksumAddress(fallback);
}

function encodeEventCalldata(payload, map, fallbackFrom) {
  const eventName = String(payload.eventName || '').trim();
  const p = payload.payload || {};

  if (eventName === 'MemoryRecorded') {
    const memoryHash = toBytes32(p.memoryHash || p.contentHash || p.memoryId);
    const agent = resolveAgentAddress(p.agent || p.agentId, map, fallbackFrom);
    const tags = Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags || '');
    const cidHash = toBytes32(p.cid || p.memoryId || memoryHash);
    if (!agent) fail('EVENT_HOOK_AGENT_ADDRESS_MISSING');
    return iface.encodeFunctionData('recordMemory', [memoryHash, agent, tags, cidHash]);
  }

  if (eventName === 'MemoryTransferred') {
    const memoryHash = toBytes32(p.memoryHash || p.memoryId);
    const from = resolveAgentAddress(p.from || p.fromAgent, map, fallbackFrom);
    const to = resolveAgentAddress(p.to || p.toAgent, map, fallbackFrom);
    const operator = resolveAgentAddress(p.operator, map, from || fallbackFrom);
    if (!from || !to || !operator) fail('EVENT_HOOK_TRANSFER_ADDRESS_MISSING');
    return iface.encodeFunctionData('transferMemory', [memoryHash, from, to, operator]);
  }

  if (eventName === 'BattleResult') {
    const battleId = toBytes32(p.battleId);
    const winner = resolveAgentAddress(p.winnerAgentId || p.winner, map, fallbackFrom);
    const scoreA = BigInt(Math.max(0, Math.round(Number(p.scoreA || 0) * 1_000_000)));
    const scoreB = BigInt(Math.max(0, Math.round(Number(p.scoreB || 0) * 1_000_000)));
    const resultHash = toBytes32(p.resultHash || crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex'));
    if (!winner) fail('EVENT_HOOK_WINNER_ADDRESS_MISSING');
    return iface.encodeFunctionData('recordBattle', [battleId, winner, scoreA, scoreB, resultHash]);
  }

  if (eventName === 'AntiSybilFeeBurned') {
    const requestId = toBytes32(p.requestId);
    const payer = resolveAgentAddress(p.payer || p.payerAgent, map, fallbackFrom);
    const burnAddress = toChecksumAddress(p.burnAddress) || toChecksumAddress(process.env.BURN_ADDRESS);
    const amount = toScaledInt(p.amountUsdc ?? p.amount ?? '0', Number(process.env.ONCHAINOS_EVENT_USDC_DECIMALS || 6));
    const burnTxHash = toBytes32(p.burnTxHash);
    if (!payer || !burnAddress) fail('EVENT_HOOK_BURN_ADDRESS_MISSING');
    return iface.encodeFunctionData('recordAntiSybilBurn', [requestId, payer, burnAddress, amount, burnTxHash]);
  }

  fail(`EVENT_HOOK_UNSUPPORTED_EVENT:${eventName}`);
}

function encodeCalldataOnlyEnvelope(payload) {
  const eventName = String(payload.eventName || '').trim() || 'Unknown';
  const p = payload.payload || {};
  const payloadJson = JSON.stringify(p);
  const payloadHash = keccak256(toUtf8Bytes(payloadJson));

  const envelope = {
    app: 'EvoHive',
    kind: 'event-proof-calldata',
    version: 1,
    eventName,
    payloadHash,
    refs: {
      memoryId: p.memoryId || null,
      battleId: p.battleId || null,
      requestId: p.requestId || null
    },
    arenaId: process.env.ARENA_ID || 'arena-main',
    chainId: Number(process.env.CHAIN_ID || 196),
    timestamp: Math.floor(Date.now() / 1000)
  };

  return hexlify(toUtf8Bytes(JSON.stringify(envelope)));
}

async function run() {
  const action = String(process.env.EVOHIVE_ACTION || '').trim();
  if (action !== 'event') fail(`EVENT_HOOK_UNSUPPORTED_ACTION:${action}`);

  const payloadRaw = process.env.EVOHIVE_PAYLOAD_JSON || '{}';
  const payload = parseJson(payloadRaw, 'EVOHIVE_PAYLOAD_JSON');

  const contract = toChecksumAddress(process.env.EVOHIVE_MEMORY_EVENTS_CONTRACT);

  const cliBin = process.env.ONCHAINOS_SKILL_CLI_BIN || 'onchainos';
  const chain = String(process.env.ONCHAINOS_SKILL_WALLET_CHAIN || process.env.CHAIN_ID || '196');
  const from = toChecksumAddress(process.env.ONCHAINOS_SKILL_WALLET_FROM || process.env.ONCHAINOS_SKILL_X402_FROM || '');
  const force = ['1', 'true', 'yes', 'on'].includes(String(process.env.ONCHAINOS_SKILL_WALLET_FORCE || 'true').toLowerCase());
  const baseUrl = String(process.env.ONCHAINOS_BASE_URL || '').trim();
  const addressMap = loadAgentMap();

  const txTo = contract || toChecksumAddress(process.env.ONCHAINOS_EVENT_TX_TO || from);
  if (!txTo) fail('EVENT_HOOK_TX_TO_MISSING');

  const inputData = contract ? encodeEventCalldata(payload, addressMap, from) : encodeCalldataOnlyEnvelope(payload);

  const args = [];
  if (baseUrl) args.push('--base-url', baseUrl);
  args.push('wallet', 'contract-call', '--to', txTo, '--chain', chain, '--input-data', inputData, '--value', '0');
  if (from) args.push('--from', from);
  if (force) args.push('--force');

  const { stdout } = await execFileAsync(cliBin, args, {
    timeout: Number(process.env.ONCHAINOS_SKILL_TIMEOUT_MS || 30000),
    maxBuffer: 1024 * 1024
  });

  const result = parseJson(stdout || '{}', 'EVENT_HOOK_ONCHAINOS_STDOUT');
  const txHash = pick(result, ['eventTxHash', 'txHash', 'hash', 'data.txHash', 'data.hash', 'data.transactionHash']);
  if (!txHash) fail('EVENT_HOOK_TX_HASH_MISSING');

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        eventTxHash: txHash,
        source: contract ? 'skill-cmd-event-contract' : 'skill-cmd-event-calldata',
        eventMode: contract ? 'contract' : 'calldata-only',
        eventTarget: txTo,
        raw: result
      },
      null,
      2
    )}\n`
  );
}

run().catch((err) => {
  fail(`EVENT_HOOK_FAILED:${String(err?.message || err)}`);
});
