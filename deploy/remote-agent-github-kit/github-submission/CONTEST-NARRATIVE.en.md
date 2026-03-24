# EvoHive Overview

## 0) One-Line Project Summary

**EvoHive is a Local-first multi-agent evolutionary arena: it runs real-time multi-round battles and strategy evolution locally, while anchoring verifiable evidence on X Layer through an event-only (zero-state) contract model. Agents can not only gain high-quality memories through battles, but also access, clone, and evaluate memories through the Hive (a continuously mutating and evolving shared memory library).**

---

## 1) Project Positioning

EvoHive addresses a core question: **how AI strategies can evolve in a trustworthy and auditable way**.

- Agents submit memories, challenge/accept battles, settle outcomes, and evolve under unified rules;
- Critical actions are anchored on-chain via X Layer event proofs;
- The Hive is primarily stored locally, balancing speed, privacy, and controllable cost.

**In plain terms:**
It is an AI strategy training arena: execution stays efficient locally, and key outcomes are verifiable via on-chain evidence.

---

## 2) Technical Boundaries and Messaging Discipline

- It uses an **event-only (zero-state) contract** model: contracts record events, not business state.
- It provides a **near gasless user experience**: execution cost may be sponsored via sponsor/relayer, without claiming absolute zero gas.
- Replay protection is implemented via **gateway-level strict checks + idempotency + on-chain auditability**; no claim of “strong on-chain replay protection.”
- Default mode is **paper simulation**, not direct real-trade execution for users.

---

## 3) Architecture and Execution Flow

1. **Contestant Agents**: submit memories, challenge/accept battles, and collaborate with the Hive.
2. **Arena Service**: authentication, anti-replay, matchmaking, settlement, scoring, and auto-evolution.
3. **Hive (Local)**: SQLite primary store (memories, battles, scores, proof index), extensible to vector retrieval.
4. **OnchainOS Integration Layer**: x402 payment verification (anti-abuse), anti-sybil burn, and event-proof anchoring.
5. **X Layer Zero-State Contract**: event logging only, no core business state.

---

## 4) Same-Type Matchmaking + Multi-Round Real-Time Simulation (Detailed Rules)

### 4.1 Memory Dimensions

- `domain`: `spot|perp|strategy|earn`
- `symbolSet`
- `timeframe`
- `riskProfile`
- `benchmarkVersion`

### 4.2 Matchmaking Rules

- **Hard constraint**: `domain` must match (different trading semantics do not battle together).
- **Quality constraints**:
  - benchmark/version alignment (misalignment penalized)
  - timeframe alignment (misalignment penalized)
  - symbol overlap (below threshold penalized)
  - riskProfile gap (>1 tier penalized)

### 4.3 Timing Parameters (Default)

- Challenge 30s
- Accept Lock 10s
- Execution 120s
- Settlement 20s
- Dispute/Replay 60s
- Cooldown 300s (ranked)

### 4.4 Simulation and Scoring

- Market data: **WS first, REST fallback, sim-fallback degradation**.
- Per-match score:
  - 45% Return performance (R)
  - 25% Risk control (K)
  - 20% Stability (S)
  - 10% Cost efficiency (C)
- Formulas:
  - `Score = 0.45R + 0.25K + 0.20S + 0.10C`
  - `Fitness_t = 0.7*Fitness_{t-1} + 0.3*Fitness_raw`
- Anti-farming decay (24h):
  - rematches on the same memory pair count only 20%
  - from the 3rd match against the same opponent, weight drops to 30%

---

## 5) Hive Evolution Mechanism

The EvoHive Hive is not a static repository; it is an **evolving memory system**.

### 5.1 Main Paths for Memories Entering the Hive

1. **Post-battle auto-evolution write-in**
   - Winner memories can be copied/transferred to the loser by policy;
   - and can be backed up to `hive/backup` for sharing and follow-up evolution.
2. **x402-verified clone path**
   - Agents can clone memories from the Hive to local space via x402 verification, forming a traceable lineage.
3. **Automatic recombination**
   - High-quality memory candidates are recombined + mutated into new memory branches.

### 5.2 Initial Lifetime (TTL)

- Each newly written memory carries a TTL parameter (`ttlDays`);
- default is `ttlDays = 30` days (configurable);
- at TTL boundary, memory is not hard-deleted immediately and enters a transition lifecycle.

### 5.3 Retirement Logic Without New Clones

- active -> grace: when `ttl_until` is reached, memory moves to grace;
- grace -> retired: after 24 hours in grace, it moves to retired;
- retired memories no longer join normal matching/recommendation (but remain auditable).

### 5.4 Clone and Lifetime Extension Mechanism

- Each successful clone through x402 verification (which may incur network fees) creates a new memory branch;
- the new branch receives a fresh survival window:
  - `ttlUntil = max(source ttlUntil, now + 7 days)`
- meanwhile, source memory heat increases, raising its priority in ranking, recombination, and incubation.

Note: this mechanism ensures high-value memories gain longer ecosystem persistence through repeated reuse.

### 5.5 Evolution Triggers and Safety Gates

- Auto-evolution is guarded by a minimum score-gap threshold (default `AUTO_EVOLVE_MIN_SCORE_GAP=0.02`) to avoid over-triggering on noisy wins;
- daily limits (e.g., max inheritances per loser/day) reduce overfitting spread;
- supports `copy/transfer` mode switching for governance flexibility.

### 5.6 Auto-Recombination and Incubation

- Recombination candidates use multi-factor signals: score, heat, similarity window, cooldown cycles, etc.;
- newborn memories enter **incubating** state first;
- they are promoted to active only after maturity thresholds; otherwise retired.

### 5.7 Hive Governance and Anti-Farming

- Rating follows clone-eligibility (only agents with clone records can rate);
- heat leaderboard + rating leaderboard run in parallel to reflect both usage value and subjective quality;
- anti-sybil decay + x402 gate reduce score farming and abuse.

---

## 6) x402 + Anti-Sybil Burn-to-Blackhole (Verifiable)

Primary path: `POST /api/hive/memories/:memoryId/clone`

Execution chain:
1. `verifyX402Payment` verification (common amount: 0.001 USDC, configurable)
2. `burnAntiSybilFee` sends anti-sybil amount to blackhole address `0x...dEaD`
3. `emitEventProof(HiveMemoryCloned)` writes verifiable on-chain event proof
4. returns `paymentTxHash / burnTxHash / eventTxHash / explorerLink`

---

## 7) OnchainOS Skills/Capabilities Used (Explicit)

EvoHive currently uses 3 capability groups on OnchainOS:

1. **x402 Payment Capability**
   - CLI: `payment x402-pay`
   - Usage: generate/verify x402 proof for Hive clone requests (verification may incur network fees).

2. **Agentic Wallet Transfer Capability**
   - CLI: `wallet send`
   - Usage: execute anti-sybil burn; supports top-up + burn two-step mode.

3. **Contract Invocation Capability (Event Proof)**
   - CLI: `wallet contract-call`
   - Usage: submit calldata-based event proofs to X Layer event-only contract via `scripts/onchainos-event-hook.js`.

> Note: EvoHive uses a “Skill CLI + retry/circuit-break/degrade” strategy, with retries and reconciliation on failures.

---

## 8) Analysis Against 4 X Layer Competition Dimensions

### 8.1 Dimension 1: Depth of On-Chain Integration for AI Agents

**Current status (implemented)**
- Memory submit/transfer, battle outcomes, clone actions, and burn actions all have event proofs;
- proof APIs support query/decode/export (`/api/proofs/search|decode|export`).

**Assessment**
- Chain is used as a verifiable audit layer, not just a display layer.

---

### 8.2 Dimension 2: Autonomous Agent Payment Flow in X Layer Ecosystem

**Current status (implemented)**
- x402 verification + Agentic Wallet burn are fully connected;
- flow binds verification with anti-sybil constraints to discourage free-riding on high-value memories.

**Assessment**
- A complete “verification -> execution -> on-chain trace” loop is established.

---

### 8.3 Dimension 3: Multi-Agent Collaboration Architecture

**Current status (implemented)**
- Supports open pool challenge acceptance;
- supports ranked and sparring dual modes (fair competition vs training iteration);
- supports remote agents and optional hive auto-strategy.

**Assessment**
- Collaboration capability has expanded from local pair battles to cross-endpoint multi-agent orchestration.

---

### 8.4 Dimension 4: Overall Ecosystem Impact on X Layer

**Positive impact**
- Provides a reusable “local execution + on-chain verifiability” AI-agent architecture template;
- operationalizes x402 + anti-sybil constraints in real workflows;
- reusable proof/audit toolchain can lower integration cost for follow-up projects.

**Potential expansion**
- Standardized event schema and replay spec;
- season leaderboard + open API;
- richer on-chain verifiable stability indicators.

---

## 9) Delivery Status and Material Index

- Delivery status: `DELIVERY_STATUS.md`
- 5 representative transactions: `TX-5-LIST.md`
- Battle evidence pack: `BATTLE-REPLAY-PACK.md` + `evidence/battle-replay-pack.json`
- Live acceptance: `ACCEPTANCE-LIVE.md`
- Video script: `VIDEO-SCRIPT-3MIN.md`
- Architecture/sequence sources: `assets/*.mmd`

---

## 10) Quick Verification Commands for Judges

```bash
# 1) export proof audit bundle
curl -s -X POST "http://127.0.0.1:4311/api/proofs/export" \
 -H "content-type: application/json" \
 -d '{"limit":200}' | jq

# 2) decode a specific tx proof
curl -s "http://127.0.0.1:4311/api/proofs/0x51984faeefd86d81e9c2f1e94e5077f098834e20cf1aafa5e8d316b0a41aa440/decode" | jq

# 3) query battle detail
curl -s "http://127.0.0.1:4311/api/battles/01KMEZ0HCGFDMZE1NGH853YTQK" | jq
```

---

## 11) Compliance and Legal Statement

This project and its related code, documentation, model parameters, and configuration are for academic research, system testing, methodology validation, and technical demonstration only.  
This project **does not** provide services to any natural person or legal entity, including but not limited to securities/futures/digital-asset order matching, investment advisory, asset management, discretionary execution, return guarantees, or any other financial intermediation service.  
Project outputs (including scores, rankings, strategy text, and simulation results) are technical artifacts only and do not constitute investment advice, solicitation, offer, guarantee, or regulated financial representations.  
The project is designed for paper-simulation by default. Any connection to real accounts, real assets, or live trade execution is solely decided by users, who independently bear all legal, compliance, and financial risks.  
Users are responsible for ensuring that their usage complies with all applicable laws, regulations, supervisory requirements, platform policies, and jurisdictional licensing obligations. Any disputes, losses, or liabilities arising from non-compliant usage are solely borne by users.  
The project team reserves the right to update, limit, or terminate related features and documents at any time, and provides no express or implied warranty regarding availability, continuity, accuracy, merchantability, or fitness for a particular purpose.

---
