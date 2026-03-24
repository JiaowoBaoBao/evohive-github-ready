# EvoHive 值班 SOP (On-Call)

> 本文按当前实现维护（hive library + paid clone 主路径，legacy buffs 兼容但已弃用）。

## 0) 快速约定

```bash
# 默认本地服务地址（按实际端口改）
export EVOHIVE_BASE_URL="http://127.0.0.1:4310"
```

---

## 1) 健康度快速检查

```bash
curl -s "$EVOHIVE_BASE_URL/health"
curl -s "$EVOHIVE_BASE_URL/api/system/status" | jq
```

重点字段：
- `onchain.mode`：`stub|hybrid|live`
- `onchain.circuit.verify/burn/event.open`：是否熔断
- `retryQueue.pending/failed`
- `checks.x402.ok`
- `checks.premiumCoverage24h.ok/liveOk/finalizedOk`

---

## 2) 标准排障流程

### Step A — 先清理/推进重试队列

```bash
# 1) 维护：隔离不应重试任务、归档历史失败
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/retry-maintenance" \
  -H "Content-Type: application/json" \
  -d '{"limit":500}' | jq

# 2) 执行重试
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/retry-onchain" \
  -H "Content-Type: application/json" \
  -d '{"limit":20}' | jq
```

### Step B — 运行对账

```bash
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/reconcile" \
  -H "Content-Type: application/json" \
  -d '{"coverageWindowSec":86400}' | jq
```

关注：`checked / mismatch / premiumCoverage24h`。

### Step C — 检查证明链路

```bash
# 搜索证明事件
curl -s "$EVOHIVE_BASE_URL/api/proofs/search?eventName=AntiSybilFeeBurned&limit=50" | jq

# 导出审计包
curl -s -X POST "$EVOHIVE_BASE_URL/api/proofs/export" \
  -H "Content-Type: application/json" \
  -d '{"eventName":"AntiSybilFeeBurned","limit":200}' | jq
```

> 注意：当前正确路径是 `/api/proofs/*`（不是 `/api/proof/*`）。

### Step D — battle 过期清扫

```bash
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/sweep-battles" | jq
```

---

## 3) 常见问题与处理

### A. retryQueue.failed 偏高
1. 先跑 `retry-maintenance`
2. 查看失败类型：
```bash
curl -s "$EVOHIVE_BASE_URL/api/system/status" | jq '.retryQueue.failedByType'
```
3. 再跑 `retry-onchain`

### B. x402 预检告警
```bash
curl -s "$EVOHIVE_BASE_URL/api/system/status" | jq '.checks.x402'
```
- `ok=false` 且 `blocking=false`：通常可降级继续跑
- `ok=false` 且 `blocking=true`：需要补齐配置后再恢复写路径

### C. premium coverage 不足
1. 检查：
```bash
curl -s "$EVOHIVE_BASE_URL/api/system/status" | jq '.checks.premiumCoverage24h'
```
2. 触发一次真实付费样本（推荐主路径：clone）
   - `POST /api/hive/memories/:memoryId/clone`
3. 再执行一次 `POST /api/jobs/reconcile`

### D. 链路抖动（TLS reset / handshake eof）
- 先确认 circuit 是否已打开：`onchain.circuit.*.open`
- 再看 retry 是否持续增长
- 必要时短时切回 `stub` 做演示连续性，生产恢复后再回 `hybrid/live`

---

## 4) 告警阈值建议

```bash
ALERT_RETRY_PENDING_THRESHOLD=30
ALERT_CIRCUIT_OPEN_THRESHOLD_SEC=300
ALERT_RECONCILE_MISMATCH_THRESHOLD=0
ALERT_WEBHOOK_URL="https://your-webhook-url/alerts"
ALERT_WEBHOOK_TIMEOUT_MS=5000
ALERT_DEDUPE_SEC=300
```

触发关注：
1. `retryQueue.pending >= 30`
2. circuit 连续 open 超阈值
3. reconciliation mismatch > 0
4. premiumCoverage24h 为 0 或 live/finalized 失败

---

## 5) 值班最小日常（建议）

```bash
# 1) 状态
curl -s "$EVOHIVE_BASE_URL/api/system/status" | jq '{onchain,retryQueue,checks,reconciliation}'

# 2) 维护 + 重试
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/retry-maintenance" -H "Content-Type: application/json" -d '{"limit":500}' | jq
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/retry-onchain" -H "Content-Type: application/json" -d '{"limit":20}' | jq

# 3) 对账
curl -s -X POST "$EVOHIVE_BASE_URL/api/jobs/reconcile" -H "Content-Type: application/json" -d '{"coverageWindowSec":86400}' | jq
```

---

最后更新：2026-03-23
