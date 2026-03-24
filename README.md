# EvoHive

EvoHive is a **single-machine multi-agent evolution arena** built for X Layer + OnchainOS workflows.

This implementation is the practical starter for the agreed architecture:
- **Zero-state contract** (event-only)
- **Gateway replay protection** (`requestId + deadline + signature` pattern)
- **Local hive storage** (SQLite + optional IPFS URI)
- **Domain-safe battles** (spot/perp/strategy/earn matching)
- **Realtime/paper multi-round simulation engine**
- **Anti-sybil premium endpoint** with burn-route evidence fields

> This repo is intentionally thin and hackathon-friendly: run locally, prove flows, then swap stubs for production integrations.

## Quick Start

```bash
cd evohive
cp .env.example .env
npm install
npm run seed-demo
npm run dev
```

Server default: `http://localhost:4310`

Visual panel: `http://localhost:4310/panel/` (replace port if customized)

Panel service helpers:
```bash
npm run panel:start
npm run panel:status
npm run panel:logs
npm run panel:stop
```

## OnchainOS mode

EvoHive supports `stub`, `live`, and `hybrid` adapters via env:

```bash
ONCHAIN_MODE=auto      # auto -> live if ONCHAINOS_BASE_URL is set, else stub
ONCHAINOS_BASE_URL=
ONCHAINOS_API_KEY=
ONCHAINOS_X402_VERIFY_PATH=/x402/verify
ONCHAINOS_WALLET_TRANSFER_PATH=/wallet/transfer
ONCHAINOS_EVENT_PROOF_PATH=/events/proof

# Skill-first path (used when ONCHAIN_MODE=hybrid)
ONCHAINOS_SKILL_ENABLED=true
ONCHAINOS_SKILL_USE_CLI=true
ONCHAINOS_SKILL_CLI_BIN=onchainos

# Built-in onchainos CLI config for payment x402-pay
ONCHAINOS_SKILL_X402_NETWORK=eip155:196
ONCHAINOS_SKILL_X402_PAY_TO=0xYourReceiver
ONCHAINOS_SKILL_X402_ASSET=0xYourUsdcToken
ONCHAINOS_SKILL_X402_AMOUNT_DECIMALS=6
ONCHAINOS_SKILL_VERIFY_FALLBACK_WALLET=false

# Built-in onchainos CLI config for wallet send (burn transfer)
ONCHAINOS_SKILL_WALLET_CHAIN=196
ONCHAINOS_SKILL_USDC_TOKEN=0xYourUsdcToken

# Optional custom hooks (fallback after CLI attempt)
ONCHAINOS_SKILL_VERIFY_CMD="node ./scripts/skill-hook.example.js"
ONCHAINOS_SKILL_BURN_CMD="node ./scripts/skill-hook.example.js"
ONCHAINOS_SKILL_EVENT_CMD="node ./scripts/onchainos-event-hook.js"

# Event-proof hook config
# Option A: contract-call to deployed MemoryEvents (structured methods)
EVOHIVE_MEMORY_EVENTS_CONTRACT=0xYourMemoryEventsAddress
# Option B: no deploy, write event digest into calldata (0-value tx)
ONCHAINOS_EVENT_TX_TO=0xYourEOAorReceiver
ONCHAINOS_AGENT_ADDRESS_MAP_JSON='{"agent-a":"0x...","agent-b":"0x...","agent-c":"0x..."}'
```

- `live`: HTTP API only
- `hybrid`: try OnchainOS skill (CLI/custom command) first, then fallback to HTTP API
  - verify flow prefers `payment x402-pay`; optional wallet micro-transfer fallback is controlled by `ONCHAINOS_SKILL_VERIFY_FALLBACK_WALLET` (default: false)

For local demo, keep defaults (`stub`).
For real integration, set `ONCHAIN_MODE=hybrid` for skill-first behavior.

Battle market data mode:
- `MARKET_DATA_MODE=paper`: deterministic simulation shocks
- `MARKET_DATA_MODE=live`: WS ticker primary, REST fallback, then simulation fallback

Resilience hardening:
- retry with backoff+jitter (`ONCHAINOS_RETRY_*`)
- circuit breaker (`ONCHAINOS_CIRCUIT_*`)
- retry queue + worker endpoint (`POST /api/jobs/retry-onchain`)
- automatic retry/reconcile/alert workers (`AUTO_*`, `ALERT_*`)
- fault injection test knob (`ONCHAINOS_FAULT_INJECT_JSON`)

Security hardening:
- `ONCHAINOS_API_KEY_FILE` for file-backed secret loading
- `EVOHIVE_AUTH_SECRET_FILE` for file-backed HMAC auth secret (avoid putting auth secret inline in `.env`)
- optional local panel signer (`PANEL_AUTH_SIGNER_ENABLED=true`) to keep browser panel usable in HMAC mode
- optional high-risk confirmation token flow (`RISK_CONFIRMATION_*` + `POST /api/security/risk-token`)

UI logs now annotate source tags (`stub/http/skill/...`) and only make explorer links clickable when `hashLive=true`.

## Core APIs

- `POST /api/memories/commit` - submit memory metadata into hive
- `POST /api/memories/transfer` - transfer memory ownership to another agent + emit proof
- `POST /api/battles/challenge` - challenge with memory + benchmark settings
- `POST /api/battles/:battleId/accept` - accept challenge
- `POST /api/battles/:battleId/run` - execute paper simulation + settle
- `GET /api/hive/memories` - browse hive memory library (metadata/hashes only; no plaintext strategy body)
- `POST /api/hive/memories/:memoryId/clone` - clone selected hive memory to local agent with x402 verification + anti-sybil burn
- `POST /api/hive/memories/:memoryId/rate` - rate hive memory (only agents with clone receipt eligibility can rate)
- `GET /api/hive/memories/leaderboards` - heat/rating leaderboards for hive memories (rating uses Bayesian weighted score)
- `GET /api/hive/recombinations/recent` - recent recombination lineage edges
- `GET /api/hive/memories/:memoryId/lineage` - lineage graph (parent/child recombination edges)
- `GET /api/hive/buffs` - legacy buffs view (**deprecated**, compat only)
- `POST /api/hive/buffs/premium` - legacy premium buff access (**deprecated**, compat only)
- `POST /api/jobs/hive-recombine` - trigger high-score similar-tag hive memory recombination + mutation (child starts as `incubating`)
- `POST /api/jobs/hive-incubation` - run incubation gate sweep (`incubating -> active|retired`)
- `POST /api/jobs/sweep` - lifecycle sweep (`active -> grace -> retired`)
- `POST /api/jobs/sweep-battles` - expire stale challenged/accepted battles by timing windows
- `GET /api/memories/search?q=...` - semantic-style memory search (sqlite vector fallback / qdrant optional)
- `GET /api/memories/detail/:memoryId?includeStrategy=true` - memory detail; includes strategy body/note only when explicitly requested
- `GET /api/system/status` - panel-ready runtime + circuit + retry queue + reconciliation snapshot
- `POST /api/ui/auth/sign` - local panel auth envelope signer (HMAC mode; disabled by default)
- `GET /api/proofs/search` - search indexed proof events by tx/request/battle/memory
- `GET /api/proofs/:txHash/decode` - decode indexed proof payload
- `POST /api/proofs/export` - export proof audit package to `output/`
- `POST /api/jobs/retry-onchain` - process queued onchain retry tasks
- `POST /api/jobs/retry-maintenance` - quarantine non-retryable queue items
- `POST /api/jobs/reconcile` - run burn/payment/proof consistency reconciliation
- `POST /api/security/risk-token` - issue one-time confirmation token for high-risk actions
- `GET /metrics` - runtime observability snapshot (request latency/error counters + onchain queue/circuit)

## Replay Protection Model (Gateway)

All protected write endpoints require:

```json
{
  "requestId": "01J...",
  "agentId": "agent-a",
  "action": "SUBMIT_BATTLE",
  "payloadHash": "0x...",
  "issuedAt": 1710000000,
  "deadline": 1710000120,
  "arenaId": "arena-main",
  "chainId": 196,
  "signature": "0x..."
}
```

Current template validates action/payload hash, arena/chain binding, issuedAt/deadline window (`REQUEST_TTL_SEC`), idempotency uniqueness, and signature.

Signature mode (`AUTH_SIGNATURE_MODE`):
- `auto` (default): prefer EIP-712 (if `EIP712_EXPECTED_SIGNER` set), else HMAC (if `EVOHIVE_AUTH_SECRET` set), else legacy demo mode
- `legacy`: any non-empty signature is accepted (demo only)
- `hmac`: signature must be `0x + HMAC_SHA256(secret, canonicalAuthEnvelopeWithoutSignature)` (supports key rotation via `EVOHIVE_AUTH_KEYRING` + `auth.keyId`)
- `eip712`: signature must recover one allowed signer (`EIP712_EXPECTED_SIGNER` + optional `EIP712_ALLOWED_SIGNERS`)

EIP-712 typed data (`AuthEnvelope`) fields:
`requestId, agentId, action, payloadHash(bytes32), issuedAt, deadline, arenaId, chainId`

Local helper for generating EIP-712 signatures:
```bash
cat auth.json | EIP712_PRIVATE_KEY=0x... npm run sign-eip712
```

## Zero-state Contract

See `contracts/MemoryEvents.sol`.

Only emits:
- `MemoryRecorded`
- `MemoryTransferred`
- `BattleResult`
- `AntiSybilFeeBurned`

No mappings, no mutable business state.

## Integration status

Implemented with adapter pattern in `apps/arena/src/onchain.js`:

- ✅ Supports live HTTP integration for:
  - x402 verification
  - wallet burn transfer
  - event proof submission
- ✅ Supports `hybrid` mode (OnchainOS CLI/custom skill command first, HTTP fallback)
- ✅ Supports local stub fallback for hackathon demo stability
- ✅ Replay guard now enforces TTL window and optional HMAC signature (`EVOHIVE_AUTH_SECRET`)
- ✅ Event-proof custom hook available: `scripts/onchainos-event-hook.js` (`contract-call` mode with deployed MemoryEvents, or no-deploy calldata-only mode)

So you can run full demo locally today, then switch to skill-first or real OnchainOS APIs by env only.

## Architecture and sequence diagrams

- Architecture: `docs/architecture.mmd`
- Battle lifecycle sequence: `docs/sequence-battle.mmd`
- Premium x402 + burn sequence: `docs/sequence-premium.mmd`

## Demo flow

1. Reset + seed demo state: `npm run reset-demo && npm run seed-demo`
2. Challenge battle (same domain/risk/timeframe gate)
3. Accept + run battle
4. Read battle result, scores, fitness delta (+ anti-sybil decay)
5. Call premium buff endpoint and inspect burn evidence fields

Acceptance/evidence snapshot:
```bash
npm run acceptance
```

Regression matrix (stub / hybrid-fault-inject / calldata-only):
```bash
npm run regression
```

## Safety note

This is **paper simulation only**. It does not place real exchange orders.
