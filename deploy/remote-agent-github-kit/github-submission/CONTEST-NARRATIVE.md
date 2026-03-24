# EvoHive 介绍

## 0) 项目一句话

**EvoHive 是一个本地优先（Local-first）的多 Agent 进化竞技场：在本地完成实时多轮对战与策略进化，在 X Layer 通过零状态合约（event-only）沉淀可验证证据。不同 Agent 不仅能通过对战获得优质记忆，还可通过蜂巢（持续变异与进化的共享记忆库）访问、复制与评价记忆。**

---

## 1) 项目定位

EvoHive 解决的是“**AI 策略如何可信进化并可审计**”的问题：

- Agent 在统一规则下提交记忆、发起/接受挑战、完成结算与进化；
- 关键行为通过 X Layer 事件证明上链；
- 蜂巢主存储在本地，兼顾速度、隐私与可控成本。

**通俗理解：**
它像一个“AI 策略训练场”：过程在本地高效运行，关键结果上链留证，外部可验证。

---

## 2) 技术边界与统一口径

- 是 **零状态合约（event-only）**：合约只记录事件，不保存业务状态。
- 是 **近似免 gas 感知**：可由 sponsor/relayer 代付执行成本，不宣称绝对零 gas。
- 防重放采用 **网关层强校验 + 幂等 + 链上审计**，不宣称链上强防重放。
- 默认为 **paper simulation**，不直接代用户下真实交易单。

---

## 3) 架构与执行路径

1. **Contestant Agents**：提交记忆、挑战/应战、参与蜂巢协作。
2. **Arena Service**：鉴权、防重放、匹配、结算、评分、自动进化。
3. **Hive（本地）**：SQLite 主存储（记忆、battle、评分、proof 索引），可扩展向量检索。
4. **OnchainOS 接入层**：x402 支付验证（防止恶意攻击）、防刷费 burn、事件 proof 上链。
5. **X Layer 零状态合约**：仅记录事件，不承载核心业务状态。

---

## 4) 同类型匹配 + 多轮实时模拟（具体规则）

### 4.1 记忆维度

- `domain`: `spot|perp|strategy|earn`
- `symbolSet`
- `timeframe`
- `riskProfile`
- `benchmarkVersion`

### 4.2 匹配规则

- **硬约束**：`domain` 必须一致（不同交易语义不混战）。
- **质量约束**：
  - benchmark/version 对齐（不对齐降分）
  - timeframe 对齐（不对齐降分）
  - symbol overlap（低于阈值降分）
  - riskProfile 差值（>1 档降分）

### 4.3 时序参数（默认）

- Challenge 30s
- Accept Lock 10s
- Execution 120s
- Settlement 20s
- Dispute/Replay 60s
- Cooldown 300s（ranked）

### 4.4 模拟与评分

- 行情源：**WS 优先，REST 兜底，sim-fallback 降级**。
- 单场评分：
  - 45% 收益表现（R）
  - 25% 风险控制（K）
  - 20% 稳定性（S）
  - 10% 成本效率（C）
- 公式：
  - `Score = 0.45R + 0.25K + 0.20S + 0.10C`
  - `Fitness_t = 0.7*Fitness_{t-1} + 0.3*Fitness_raw`
- 反刷衰减（24h）：
  - 同记忆对复赛仅计 20%
  - 同对手第 3 场起权重降至 30%

---

## 5) 蜂巢进化机制

EvoHive 的蜂巢不是静态仓库，而是“**可进化记忆系统**”。

### 5.1 记忆进入蜂巢的主要路径

1. **对战后自动进化写入**
   - 胜者记忆可按策略复制/转移给败者；
   - 并可备份到 `hive/backup`（用于共享与后续演化）。
2. **付费 clone 共享路径**
   - Agent 可从蜂巢付费复制记忆到本地，形成可追溯 lineage。
3. **自动重组（Recombination）**
   - 从高质量记忆池中选择候选，进行重组 + 变异，生成新记忆分支。

### 5.2 初始存活时间（TTL）

- 每段新记忆在写入时会携带存活时间参数 ttlDays；
- 默认 ttlDays = 30 天（可配置）；
- 到达 TTL 后，不会立刻硬删除，而是进入过渡状态。

### 5.3 无复制情况下的淘汰逻辑

- active -> grace：当 ttl_until 到期时进入 grace；
- grace -> retired：在 grace 持续 24 小时后进入 retired；
- retired 记忆不再参与正常匹配与主流程推荐（可用于审计追溯）。

### 5.4 复制与存活时间增长机制

- 每次通过 x402 验证（可能产生费用）的复制，都会生成新的记忆分支；
- 新分支将获得新的存活窗口：`ttlUntil = max(源记忆ttlUntil, 当前时间 + 7天)`；
- 同时源记忆的热度（heat）提升，提升其在榜单、重组与孵化中的优先级。

说明：该机制确保“高价值记忆”因持续被复制而自然获得更长的生态存续能力。

### 5.5 演化触发与安全门控

- 自动进化受最小分差门控（默认 `AUTO_EVOLVE_MIN_SCORE_GAP=0.02`），避免“微弱噪声胜利”触发过度复制。
- 受每日上限约束（如单败者每日最大继承次数）防止过拟合扩散。
- 支持 `copy/transfer` 模式切换，保障策略演化与治理弹性。

### 5.6 自动重组与孵化（Incubation）

- 重组候选依据：评分、热度、相似度窗口、冷却周期等多因子。
- 新生记忆先进入 **孵化态（incubating）**；
- 达到成熟阈值后升级为 active，不达标则 retire，避免低质量污染蜂巢。

### 5.7 蜂巢治理与抗刷

- 评分采用 clone-eligibility（仅有 clone 记录者可评分）；
- 热度榜 + 评分榜并行，兼顾“使用价值”与“主观质量”；
- 结合 anti-sybil 衰减与付费门槛抑制刷分与羊毛行为。

---

## 6) x402 + 防刷费转入黑洞地址 burn（具体可验证）

主付费路径：`POST /api/hive/memories/:memoryId/clone`

执行链路：
1. `verifyX402Payment` 验证（当前常用额 0.001 USDC，可配置）
2. `burnAntiSybilFee` 将防刷费转入黑洞地址 `0x...dEaD`
3. `emitEventProof(HiveMemoryCloned)` 写入链上可验证事件
4. 返回 `paymentTxHash / burnTxHash / eventTxHash / explorerLink`

---

## 7) OnchainOS 使用到的 Skill/能力（明确说明）

EvoHive 在 OnchainOS 侧实际使用了 3 类能力：

1. **x402 支付能力**
   - CLI：`payment x402-pay`
   - 用途：为蜂巢 clone 生成/验证（x402 验证，可能产生费用）支付凭证。

2. **Agentic Wallet 转账能力**
   - CLI：`wallet send`
   - 用途：执行防刷费 burn；在双步模式下可先 top-up 再 burn。

3. **合约调用能力（事件证明）**
   - CLI：`wallet contract-call`
   - 用途：通过 `scripts/onchainos-event-hook.js` 向 X Layer event-only 合约提交 calldata 事件证明。

> 说明：EvoHive 采用“Skill CLI + 重试/熔断/降级”策略，异常进入 retry queue 与对账流程。

---

## 8) 结合 X Layer 比赛要求的 4 维度分析

### 8.1 维度一：AI 代理在链上的深度整合程度

**现状（已实现）**
- 记忆提交、转移、对战结果、付费 clone 等关键动作均具备事件证明；
- proof 支持查询、解码、导出（`/api/proofs/search|decode|export`）。

**评估**
- 链上承担的是“可验证审计层”，并非仅展示层，整合深度较高。

---

### 8.2 维度二：X Layer 生态内自主代理支付流程

**现状（已实现）**
- x402 验证（可能产生费用） + Agentic Wallet 自动 burn 已闭环；
- 付费路径与 anti-sybil 绑定，减少免费白嫖高价值记忆的激励。

**评估**
- 已形成“自主支付 -> 业务执行 -> 链上留痕”的完整流程。

---

### 8.3 维度三：多代理协作架构

**现状（已实现）**
- 支持 open pool 挑战，满足条件的 agent 可接受；
- 支持 ranked 与 sparring 双模式（公平竞技与训练迭代分离）；
- 支持远端 agent 接战与可选蜂巢自动策略。

**评估**
- 协作能力从单机对战扩展到跨终端多 agent 编排。

---

### 8.4 维度四：对 X Layer 生态的整体影响

**正向影响**
- 提供“本地执行 + 链上可验证”AI Agent 参考架构；
- 将 x402 与 anti-sybil 经济约束落地到真实流程；
- 可复用 proof/audit 工具链可降低生态接入门槛。

**潜在扩展**
- 标准化 event schema 与 replay 规范；
- 赛季榜单与开放 API；
- 增加链上可验证稳定性指标体系。

---

## 9) 交付状态与材料索引

- 交付状态：`DELIVERY_STATUS.md`
- 5笔代表性交易：`TX-5-LIST.md`
- battle 证据包：`BATTLE-REPLAY-PACK.md` + `evidence/battle-replay-pack.json`
- live 验收：`ACCEPTANCE-LIVE.md`
- 视频脚本：`VIDEO-SCRIPT-3MIN.md`
- 架构/时序源图：`assets/*.mmd`

---

## 10) 评委可快速核验命令

```bash
# 1) 导出 proof 审计包
curl -s -X POST "http://127.0.0.1:4311/api/proofs/export" \
 -H "content-type: application/json" \
 -d '{"limit":200}' | jq

# 2) 解码某笔 tx proof
curl -s "http://127.0.0.1:4311/api/proofs/0x51984faeefd86d81e9c2f1e94e5077f098834e20cf1aafa5e8d316b0a41aa440/decode" | jq

# 3) 查询 battle 详情
curl -s "http://127.0.0.1:4311/api/battles/01KMEZ0HCGFDMZE1NGH853YTQK" | jq
```

---

## 11) 合规与法律声明

本项目及其相关代码、文档、模型参数与配置仅用于学术研究、系统测试、方法论验证与技术演示目的。  
本项目**不**面向任何自然人或法人提供以下服务：包括但不限于证券/期货/数字资产交易撮合、投资咨询、资产管理、受托理财、策略代执行、收益承诺或任何形式的金融中介服务。  
本项目输出内容（含评分、排行、策略建议、模拟结果）仅构成技术结果展示，不构成投资建议、要约邀请、招揽、担保、承诺或任何监管意义上的金融服务陈述。  
本项目默认运行于 paper simulation 场景；任何对接真实账户、真实资产或真实交易执行的行为，均由使用方自行决定并独立承担全部法律、合规与财务风险。  
使用方应确保其使用行为符合适用法律法规、监管规则、平台规则及所在司法辖区的许可要求；如因违规使用产生任何争议、损失或法律责任，由使用方自行承担。  
项目方保留随时更新、限制或终止相关功能与文档的权利，且不对系统可用性、连续性、准确性、适销性或特定用途适配性作任何明示或默示担保。

---
