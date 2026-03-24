# EvoHive implementation spec (v1)

## 1) Battle subject and timing

Battle subject = `memoryHashA vs memoryHashB` under same task pack:
- same `domain` (`spot|perp|strategy|earn`)
- same `benchmarkVersion`
- symbol overlap >= 70%
- risk profile distance <= 1 level

Timing defaults:
- challenge window: 30s
- accept lock: 10s
- execution: 120s (10 rounds)
- settlement: 20s
- dispute/replay window: 60s
- same-opponent cooldown: 300s (only for `matchMode=ranked`)

Battle mode:
- `matchMode=sparring`: bypass same-opponent cooldown and daily cap
- `matchMode=ranked`: enforce same-opponent cooldown + daily cap

Lifecycle sweeper (`/api/jobs/sweep-battles`) marks stale matches:
- `challenged -> expired_challenge`
- `accepted -> expired_execution`

## 2) Replay protection (gateway)

Uses signed auth envelope + idempotency table:

- `requestId` unique globally
- `arenaId + chainId` must match server config
- `issuedAt/deadline` must be valid and TTL cannot exceed `REQUEST_TTL_SEC`
- `payloadHash` deterministic hash of payload
- status machine: `processing -> done|failed`

Signature behavior (`AUTH_SIGNATURE_MODE`):
- `legacy`: local mode, non-empty signature accepted
- `hmac`: signature must match HMAC-SHA256 over canonical envelope
- `eip712`: signature must recover configured signer (`EIP712_EXPECTED_SIGNER`)
- `auto`: prefer eip712 if signer configured, else hmac if secret configured, else legacy
- HMAC secret can be loaded from `EVOHIVE_AUTH_SECRET_FILE` (preferred over inline env)
- For local browser panel in HMAC mode, optional signer endpoint: `POST /api/ui/auth/sign` (guarded by `PANEL_AUTH_SIGNER_ENABLED` + localhost-only by default)

EIP-712 domain:
- `name = EIP712_DOMAIN_NAME` (default `EvoHiveArenaAuth`)
- `version = EIP712_DOMAIN_VERSION` (default `1`)
- `chainId = auth.chainId`
- `verifyingContract = EIP712_VERIFYING_CONTRACT`

Typed struct `AuthEnvelope`:
`requestId, agentId, action, payloadHash(bytes32), issuedAt(uint256), deadline(uint256), arenaId, chainId(uint256)`

Repeated request with same `requestId` returns cached response.

## 3) Fitness model

Battle simulation still produces a market score:

`SimScore = 0.45*Return + 0.25*Risk + 0.20*Stability + 0.10*Cost`

Settlement now supports **composite memory scoring** (default enabled):

`Composite = w1*Quality + w2*Relevance + w3*PotentialImpact + w4*Novelty + w5*Freshness`

Default weights:
- `w1=0.25` Quality
- `w2=0.25` Relevance
- `w3=0.20` PotentialImpact
- `w4=0.15` Novelty
- `w5=0.15` Freshness

Final battle score uses composite mode by default (`BATTLE_SCORE_USE_COMPOSITE=true`), while still preserving `simScoreA/simScoreB` in result payload for audit.

Then EWMA smoothing:

`Fitness_t = 0.7 * Fitness_(t-1) + 0.3 * FinalScore`

Anti-sybil decay layer before EWMA:
- repeated same memory pair within 24h -> raw score multiplier `0.2`
- from the 3rd settled match of same opponent pair in 24h -> raw score multiplier `0.3`
- final multiplier uses the stricter one (`min`) when both match

## 4) Anti-sybil fee burn + event proof strategy

Primary paid flow (`POST /api/hive/memories/:memoryId/clone`):
1. x402 payment verify
2. route anti-sybil fee to burn address
3. clone selected hive memory to caller local memory
4. emit `HiveMemoryCloned`
5. return clone/payment/burn/event evidence

Legacy compatibility flow (`POST /api/hive/buffs/premium`, deprecated):
1. x402 payment verify
2. route anti-sybil fee to burn address
3. emit `AntiSybilFeeBurned`
4. return legacy premium buffs payload

Event-proof strategy in hybrid mode:
- option A (structured): `ONCHAINOS_SKILL_EVENT_CMD` custom hook using `onchainos wallet contract-call`
  against deployed `MemoryEvents` (0-value + calldata)
- option B (no deploy): `ONCHAINOS_EVENT_TX_TO` + calldata-only envelope tx (0-value)
  to preserve onchain proofability without contract deployment
- fallback: if event proof backend/hook fails, service degrades to local proof hash
  (`source=degraded-local-proof`) and does **not** block core battle/payment flow

## 5) Memory transfer model

Transfer API: `POST /api/memories/transfer`

- verifies current owner (`fromAgent`) matches authenticated agent
- updates `memories.source_agent` to `toAgent`
- appends transfer audit row to `memory_transfers`
- emits `MemoryTransferred` proof event

## 6) Storage model

Local-first:
- SQLite: metadata, battle logs, idempotency, burn records, transfer audits
- Memory metadata now includes classifier outputs: `memory_type` (`episodic|semantic|procedural|sentiment`), `memory_sub_type`, OpenSea-style `attributes[]`, `classifier_confidence`, `encrypted_uri_hash`
- SQLite vector fallback (`memory_vectors`) for semantic-style retrieval
- optional Qdrant remote upsert/search backend
- content pointer: CID to IPFS/Arweave (or encrypted URI)
- chain proof: X Layer event tx hashes (`memoryHash + encryptedUriHash + type/tags`)

## 7) Contract model

`contracts/MemoryEvents.sol` is event-only (zero-state):
- no mapping
- no mutable business storage
- only audit logs

## 8) Reliability and reconciliation

- Retry with backoff+jitter: `ONCHAINOS_RETRY_*`
- Per-action circuit breaker (`verify`/`burn`/`event`): `ONCHAINOS_CIRCUIT_*`
- Retry queue persistence table: `onchain_retry_jobs`
- Worker endpoint: `POST /api/jobs/retry-onchain`
- Maintenance endpoint: `POST /api/jobs/retry-maintenance` (quarantine non-retryable pending jobs)
- Reconciliation endpoint: `POST /api/jobs/reconcile`
  - compares premium activity log, burn record, and proof index consistency
- Optional auto workers + alerting: `AUTO_RETRY_*`, `AUTO_RECONCILE_*`, `ALERT_*`

## 9) Proof observability and audit export

- Indexed proofs table: `proof_events`
- Search: `GET /api/proofs/search`
- Decode: `GET /api/proofs/{txHash}/decode`
- Export package: `POST /api/proofs/export` (writes JSON to `output/`)

## 10) Security hardening

- File-backed API key loading: `ONCHAINOS_API_KEY_FILE`
- File-backed auth secret loading: `EVOHIVE_AUTH_SECRET_FILE`
- Optional file-backed OKX creds for skill/CLI path: `OKX_API_KEY_FILE`, `OKX_SECRET_KEY_FILE`, `OKX_PASSPHRASE_FILE`
- Optional high-risk confirmation token flow:
  - issue token: `POST /api/security/risk-token`
  - consume token via `auth.riskToken` when `RISK_CONFIRMATION_REQUIRED=true`

## 11) 2026-03 Ops optimization notes

- Event noise reduction: if `ONCHAINOS_EVENT_TX_TO` is configured, event HTTP fallback can be disabled via `ONCHAINOS_EVENT_DISABLE_HTTP_FALLBACK_WHEN_TX_TO=true`.
- Event hook reliability: custom event hook command now retries transient network/CLI failures with backoff before degrading to local proof.
- Retry failed archival: failed jobs can be auto-archived after `RETRY_FAILED_RETENTION_DAYS` to `onchain_retry_failed_archive`.
- Failed error clustering: queue status now includes `failedByType` (`config|network|unrecoverable|other`).
- X402 preflight: startup/runtime exposes `checks.x402`; missing x402 config is warned and can avoid enqueueing via preflight guard.
- Verify second channel: `ONCHAINOS_X402_VERIFY_FALLBACK_URL` can serve as backup HTTP verify endpoint when primary verify channel fails.
- Payment hash semantics: premium response/log now includes `paymentHashType` (`tx|proof|synthetic|local`) to avoid treating proof hashes as clickable chain tx.
- Two-step burn model supported: set `ONCHAINOS_SKILL_BURN_FROM` (or `ONCHAINOS_SKILL_BURN_FROM_X402_PAY_TO=true`) to burn from the premium receiver account after payment lands. In this mode, system does `payer -> receiver (topup)` then `receiver -> burnAddress`. For stability, you can pin account id via `ONCHAINOS_SKILL_BURN_FROM_ACCOUNT_ID`.
- Premium endpoint now gates on burn-sender gas readiness (`ONCHAINOS_SKILL_BURN_MIN_GAS_TOKEN`) to avoid charging payment when burn account has no gas.
- Reconciliation coverage: reconciliation summary includes premium coverage window/sample count **and** `liveSampleCount/liveOk`, plus `finalizedSampleCount/finalizedOk` using configurable finality (`RECONCILE_MIN_FINALITY_SEC`) and optional event-live requirement (`RECONCILE_REQUIRE_EVENT_LIVE`). Live sample now accepts either onchain payment tx or valid x402 payment proof as payment evidence.
- Test sample isolation: premium samples tagged as `testOnly`/`sampleClass=test` (e.g. requestId prefixes `REGPREM-`, `01JDEMO`) are excluded from reconciliation by default (`RECONCILE_EXCLUDE_TEST_ONLY=true`), with override support in `/api/jobs/reconcile` (`excludeTestOnly=false`) for CI/dev checks.
- Reconciliation consistency checks now include payment hash type/tx validation, event tx hash consistency, and burnTx propagation consistency from premium log -> burn record -> proof index.
- Daily premium acceptance guard: optional wallet balance pre-check (`AUTO_PREMIUM_ACCEPTANCE_MIN_USDC`, `AUTO_PREMIUM_ACCEPTANCE_MIN_GAS_TOKEN`) before running acceptance command.
- Premium capacity observability: periodic balance snapshot computes estimated remaining premium runs and emits threshold alerts (`ALERT_PREMIUM_CAPACITY_WARN_THRESHOLD`, `ALERT_PREMIUM_CAPACITY_CRITICAL_THRESHOLD`).
- Two-step burn observability: payment metrics include topup/burn latency buckets and counters (`topup`, `burnFailures`, `burnAfterTopupFailures`); when topup succeeds but burn fails, system emits `OPS_PREMIUM_BURN_INCOMPLETE` activity + webhook alert.
- Auto-evolution loop: after battle settle, optional auto-evolve can copy (or transfer) winner memory to loser (`AUTO_EVOLVE_*`), and optionally back up winner memory into hive backup owner for audit/recovery.
- External alert channel: optional `ALERT_WEBHOOK_URL` receives alert events with `severity` and dedupe control (`ALERT_DEDUPE_SEC`).
- Memory classifier: `MEMORY_CLASSIFIER_MODE=heuristic|oracle`; commit flow auto-labels `episodic|semantic|procedural|sentiment` and writes OpenSea-style `attributes[]`.
- Vector-assisted auto-tagging: when nearest-memory similarity >= `MEMORY_AUTO_STRATEGY_SIMILARITY_THRESHOLD` (default `0.85`), memory gets `Trading Strategy` tag.
- Event health probe: `npm run event-check` performs no-premium event-path smoke test and writes `output/event-check-*.json` with source/live/degrade diagnostics.
- CI regression: `npm run ci:regression` validates premium success path, event degraded path, and reconciliation coverage transition.
- On-call SOP: see `docs/oncall-sop.md`.
