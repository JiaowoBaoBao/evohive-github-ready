const metrics = {
  startedAt: Math.floor(Date.now() / 1000),
  requestsTotal: 0,
  requestsByPath: {},
  errorsByCode: {},
  latencyMs: { count: 0, sum: 0, p95Window: [] },
  battles: { challenged: 0, accepted: 0, settled: 0, expired: 0 },
  payments: {
    premiumCalls: 0,
    verified: 0,
    burned: 0,
    topup: 0,
    burnFailures: 0,
    burnAfterTopupFailures: 0,
    topupLatencyMs: { count: 0, sum: 0, p95Window: [] },
    burnLatencyMs: { count: 0, sum: 0, p95Window: [] }
  }
};

function recordPath(path, status) {
  const key = `${status}:${path}`;
  metrics.requestsByPath[key] = (metrics.requestsByPath[key] || 0) + 1;
  if (status >= 400) {
    const e = String(status);
    metrics.errorsByCode[e] = (metrics.errorsByCode[e] || 0) + 1;
  }
}

function recordLatency(ms) {
  metrics.latencyMs.count += 1;
  metrics.latencyMs.sum += ms;
  metrics.latencyMs.p95Window.push(ms);
  if (metrics.latencyMs.p95Window.length > 1000) {
    metrics.latencyMs.p95Window.splice(0, metrics.latencyMs.p95Window.length - 1000);
  }
}

export function observabilityMiddleware(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    metrics.requestsTotal += 1;
    recordPath(req.path, res.statusCode);
    recordLatency(ms);
  });
  next();
}

export function markBattleMetric(kind, delta = 1) {
  if (metrics.battles[kind] != null) metrics.battles[kind] += Number(delta) || 0;
}

export function markPaymentMetric(kind, delta = 1) {
  if (metrics.payments[kind] != null && typeof metrics.payments[kind] === 'number') {
    metrics.payments[kind] += Number(delta) || 0;
  }
}

export function markPaymentLatency(kind, ms) {
  const bucket = metrics.payments[kind];
  if (!bucket || typeof bucket !== 'object') return;
  const val = Math.max(0, Number(ms) || 0);
  bucket.count += 1;
  bucket.sum += val;
  bucket.p95Window.push(val);
  if (bucket.p95Window.length > 1000) {
    bucket.p95Window.splice(0, bucket.p95Window.length - 1000);
  }
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function snapshotMetrics() {
  const avg = metrics.latencyMs.count ? metrics.latencyMs.sum / metrics.latencyMs.count : 0;

  const topupAvg = metrics.payments.topupLatencyMs.count
    ? metrics.payments.topupLatencyMs.sum / metrics.payments.topupLatencyMs.count
    : 0;
  const burnAvg = metrics.payments.burnLatencyMs.count
    ? metrics.payments.burnLatencyMs.sum / metrics.payments.burnLatencyMs.count
    : 0;

  return {
    ...metrics,
    uptimeSec: Math.floor(Date.now() / 1000) - metrics.startedAt,
    latencyMs: {
      ...metrics.latencyMs,
      avg: Number(avg.toFixed(3)),
      p95: Number(percentile(metrics.latencyMs.p95Window, 0.95).toFixed(3))
    },
    payments: {
      ...metrics.payments,
      topupLatencyMs: {
        ...metrics.payments.topupLatencyMs,
        avg: Number(topupAvg.toFixed(3)),
        p95: Number(percentile(metrics.payments.topupLatencyMs.p95Window, 0.95).toFixed(3))
      },
      burnLatencyMs: {
        ...metrics.payments.burnLatencyMs,
        avg: Number(burnAvg.toFixed(3)),
        p95: Number(percentile(metrics.payments.burnLatencyMs.p95Window, 0.95).toFixed(3))
      }
    }
  };
}
