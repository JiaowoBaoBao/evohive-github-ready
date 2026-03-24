import crypto from 'node:crypto';

function seededRng(seed) {
  let x = BigInt(`0x${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`);
  return () => {
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    const n = Number(x & 0xffffffffn) / 0xffffffff;
    return n;
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function runPaperBattle({ seed, rounds, memoryA, memoryB, mode = 'paper-realtime', marketShocks = null, marketSource = 'sim' }) {
  const rand = seededRng(`${seed}:${mode}:${memoryA.memory_id}:${memoryB.memory_id}`);
  const trace = [];

  let pnlA = 0;
  let pnlB = 0;
  let maxDrawdownA = 0;
  let maxDrawdownB = 0;
  let peakA = 0;
  let peakB = 0;
  let timeoutsA = 0;
  let timeoutsB = 0;

  for (let i = 1; i <= rounds; i += 1) {
    const marketShock = Array.isArray(marketShocks) && Number.isFinite(marketShocks[i - 1])
      ? marketShocks[i - 1]
      : (rand() - 0.5) * 2; // -1..1

    const alphaA = (memoryA.fitness - 0.5) * 0.8 + (rand() - 0.5) * 0.4;
    const alphaB = (memoryB.fitness - 0.5) * 0.8 + (rand() - 0.5) * 0.4;

    const roundPnlA = (alphaA + marketShock * 0.5) * 10;
    const roundPnlB = (alphaB + marketShock * 0.5) * 10;

    pnlA += roundPnlA;
    pnlB += roundPnlB;

    peakA = Math.max(peakA, pnlA);
    peakB = Math.max(peakB, pnlB);
    maxDrawdownA = Math.max(maxDrawdownA, peakA - pnlA);
    maxDrawdownB = Math.max(maxDrawdownB, peakB - pnlB);

    const latencyA = Math.floor(40 + rand() * 220);
    const latencyB = Math.floor(40 + rand() * 220);
    if (latencyA > 200) timeoutsA += 1;
    if (latencyB > 200) timeoutsB += 1;

    trace.push({
      roundNo: i,
      pnlA: Number(roundPnlA.toFixed(4)),
      pnlB: Number(roundPnlB.toFixed(4)),
      riskA: Number(maxDrawdownA.toFixed(4)),
      riskB: Number(maxDrawdownB.toFixed(4)),
      latencyA,
      latencyB
    });
  }

  const scoreA = calcScore({ pnl: pnlA, drawdown: maxDrawdownA, timeoutCount: timeoutsA, rounds });
  const scoreB = calcScore({ pnl: pnlB, drawdown: maxDrawdownB, timeoutCount: timeoutsB, rounds });

  const winner = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'A' : 'B';

  const traceHash = hashJSON(trace);
  const result = {
    mode,
    rounds,
    marketSource,
    winner,
    scoreA,
    scoreB,
    pnlA: Number(pnlA.toFixed(4)),
    pnlB: Number(pnlB.toFixed(4)),
    maxDrawdownA: Number(maxDrawdownA.toFixed(4)),
    maxDrawdownB: Number(maxDrawdownB.toFixed(4)),
    timeoutCountA: timeoutsA,
    timeoutCountB: timeoutsB,
    traceHash
  };

  return { result, trace };
}

function calcScore({ pnl, drawdown, timeoutCount, rounds }) {
  const r = clamp((pnl + 100) / 200, 0, 1); // return
  const k = clamp(1 - drawdown / 80, 0, 1); // risk control
  const s = clamp(1 - timeoutCount / rounds, 0, 1); // stability
  const c = clamp(1 - (timeoutCount * 2 + Math.max(0, -pnl) / 20) / 20, 0, 1); // cost proxy
  return Number((0.45 * r + 0.25 * k + 0.2 * s + 0.1 * c).toFixed(6));
}

export function hashJSON(obj) {
  return `0x${crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex')}`;
}
