import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const envPath = process.env.EVOHIVE_ENV_PATH || '.env';
dotenv.config({ path: envPath });

const toNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const onchainMode = process.env.ONCHAIN_MODE || 'auto';

function toBool(value, fallback = false) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parsePolicyJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function resolveConfigPath(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return '';
  if (path.isAbsolute(fp)) return fp;
  const base = path.dirname(path.resolve(envPath));
  return path.resolve(base, fp);
}

function readSecret(primary, filePath) {
  if (primary) return primary;
  if (!filePath) return '';
  try {
    const content = fs.readFileSync(resolveConfigPath(filePath), 'utf8').trim();
    return content;
  } catch {
    return '';
  }
}

export const config = {
  port: toNum(process.env.PORT, 4310),
  dbPath: process.env.DB_PATH || './data/evohive.db',
  arenaId: process.env.ARENA_ID || 'arena-main',
  chainId: toNum(process.env.CHAIN_ID, 196),
  burnAddress: process.env.BURN_ADDRESS || '0x000000000000000000000000000000000000dEaD',
  premiumBuffFeeUsdc: toNum(process.env.PREMIUM_BUFF_FEE_USDC, 0.001),
  requestTtlSec: toNum(process.env.REQUEST_TTL_SEC, 120),
  maxBattlesPerHour: toNum(process.env.MAX_BATTLES_PER_HOUR, 12),
  maxSameOpponentPerDay: toNum(process.env.MAX_MATCHES_SAME_OPPONENT_PER_DAY, 3),
  battleDefaultMode: String(process.env.BATTLE_DEFAULT_MODE || 'ranked').trim().toLowerCase() === 'sparring' ? 'sparring' : 'ranked',
  signatureSecret: readSecret(process.env.EVOHIVE_AUTH_SECRET || '', process.env.EVOHIVE_AUTH_SECRET_FILE || ''),
  authIssuedAtSkewSec: toNum(process.env.AUTH_ISSUED_AT_SKEW_SEC, 5),
  authSignatureMode: (process.env.AUTH_SIGNATURE_MODE || 'auto').toLowerCase(),
  authDefaultKeyId: process.env.EVOHIVE_AUTH_DEFAULT_KEY_ID || '',
  eip712: {
    name: process.env.EIP712_DOMAIN_NAME || 'EvoHiveArenaAuth',
    version: process.env.EIP712_DOMAIN_VERSION || '1',
    verifyingContract: process.env.EIP712_VERIFYING_CONTRACT || '0x0000000000000000000000000000000000000000',
    expectedSigner: (process.env.EIP712_EXPECTED_SIGNER || '').toLowerCase(),
    allowedSigners: parseCsv(process.env.EIP712_ALLOWED_SIGNERS).map((x) => x.toLowerCase())
  },
  hmacKeyring: parseCsv(process.env.EVOHIVE_AUTH_KEYRING).reduce((acc, pair) => {
    const idx = pair.indexOf(':');
    if (idx <= 0) return acc;
    const keyId = pair.slice(0, idx).trim();
    const secret = pair.slice(idx + 1).trim();
    if (keyId && secret) acc[keyId] = secret;
    return acc;
  }, {}),
  marketData: {
    mode: (process.env.MARKET_DATA_MODE || 'paper').toLowerCase(), // paper|live
    symbols: parseCsv(process.env.MARKET_DATA_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT'),
    wsTimeoutMs: toNum(process.env.MARKET_WS_TIMEOUT_MS, 1200),
    restTimeoutMs: toNum(process.env.MARKET_REST_TIMEOUT_MS, 3000)
  },
  vector: {
    backend: (process.env.VECTOR_BACKEND || 'sqlite').toLowerCase(), // sqlite|qdrant
    qdrantUrl: process.env.QDRANT_URL || '',
    qdrantCollection: process.env.QDRANT_COLLECTION || 'evohive_memories'
  },
  scoring: {
    useComposite: toBool(process.env.BATTLE_SCORE_USE_COMPOSITE, true),
    weights: {
      quality: toNum(process.env.BATTLE_SCORE_W_QUALITY, 0.25),
      relevance: toNum(process.env.BATTLE_SCORE_W_RELEVANCE, 0.25),
      potentialImpact: toNum(process.env.BATTLE_SCORE_W_POTENTIAL_IMPACT, 0.2),
      novelty: toNum(process.env.BATTLE_SCORE_W_NOVELTY, 0.15),
      freshness: toNum(process.env.BATTLE_SCORE_W_FRESHNESS, 0.15)
    }
  },
  memory: {
    classifierMode: (process.env.MEMORY_CLASSIFIER_MODE || 'heuristic').toLowerCase(), // heuristic|oracle
    classifierOracleUrl: process.env.MEMORY_CLASSIFIER_ORACLE_URL || '',
    classifierTimeoutMs: toNum(process.env.MEMORY_CLASSIFIER_TIMEOUT_MS, 4000),
    autoStrategySimilarityThreshold: toNum(process.env.MEMORY_AUTO_STRATEGY_SIMILARITY_THRESHOLD, 0.85)
  },
  rbac: {
    enabled: toBool(process.env.RBAC_ENABLED, false),
    tokenRoles: parsePolicyJson(process.env.RBAC_TOKEN_ROLES_JSON, {}),
    rolePolicies: parsePolicyJson(process.env.RBAC_ROLE_POLICIES_JSON, {
      admin: ['*'],
      trader: ['COMMIT_MEMORY', 'TRANSFER_MEMORY', 'DELETE_MEMORY', 'CHALLENGE_BATTLE', 'ACCEPT_BATTLE', 'RUN_BATTLE', 'GET_PREMIUM_BUFF', 'CLONE_HIVE_MEMORY', 'RATE_HIVE_MEMORY'],
      reader: []
    })
  },
  security: {
    requireRiskConfirmation: toBool(process.env.RISK_CONFIRMATION_REQUIRED, false),
    riskActions: parseCsv(process.env.RISK_CONFIRMATION_ACTIONS || 'GET_PREMIUM_BUFF,CLONE_HIVE_MEMORY,RATE_HIVE_MEMORY'),
    riskTokenTtlSec: toNum(process.env.RISK_CONFIRM_TOKEN_TTL_SEC, 180),
    redactSecretsInHealth: toBool(process.env.REDACT_SECRETS_IN_HEALTH, true),
    strictSignatureInProd: toBool(process.env.STRICT_SIGNATURE_IN_PROD, true),
    strictSignatureAllowedModes: parseCsv(process.env.STRICT_SIGNATURE_ALLOWED_MODES || 'eip712,hmac'),
    strictSignatureFailClosed: toBool(process.env.STRICT_SIGNATURE_FAIL_CLOSED, true)
  },
  ui: {
    panelAuthSignerEnabled: toBool(process.env.PANEL_AUTH_SIGNER_ENABLED, false),
    panelAuthSignerLocalOnly: toBool(process.env.PANEL_AUTH_SIGNER_LOCAL_ONLY, true)
  },
  ops: {
    autoRetryEnabled: toBool(process.env.AUTO_RETRY_ENABLED, true),
    autoRetryIntervalSec: toNum(process.env.AUTO_RETRY_INTERVAL_SEC, 120),
    autoRetryBatch: toNum(process.env.AUTO_RETRY_BATCH, 20),
    autoReconcileEnabled: toBool(process.env.AUTO_RECONCILE_ENABLED, true),
    autoReconcileIntervalSec: toNum(process.env.AUTO_RECONCILE_INTERVAL_SEC, 300),
    autoBattleSweepEnabled: toBool(process.env.AUTO_BATTLE_SWEEP_ENABLED, true),
    autoBattleSweepIntervalSec: toNum(process.env.AUTO_BATTLE_SWEEP_INTERVAL_SEC, 300),
    alertEnabled: toBool(process.env.ALERT_ENABLED, true),
    alertIntervalSec: toNum(process.env.ALERT_INTERVAL_SEC, 120),
    alertDedupeSec: toNum(process.env.ALERT_DEDUPE_SEC, 1800),
    alertRetryPendingThreshold: toNum(process.env.ALERT_RETRY_PENDING_THRESHOLD, 30),
    alertCircuitOpenThresholdSec: toNum(process.env.ALERT_CIRCUIT_OPEN_THRESHOLD_SEC, 300),
    alertReconcileMismatchThreshold: toNum(process.env.ALERT_RECONCILE_MISMATCH_THRESHOLD, 0),
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    alertWebhookTimeoutMs: toNum(process.env.ALERT_WEBHOOK_TIMEOUT_MS, 5000),
    failedRetentionDays: toNum(process.env.RETRY_FAILED_RETENTION_DAYS, 7),
    failedArchiveEnabled: toBool(process.env.RETRY_FAILED_ARCHIVE_ENABLED, true),
    failedArchiveBatch: toNum(process.env.RETRY_FAILED_ARCHIVE_BATCH, 500),
    autoPremiumAcceptanceEnabled: toBool(process.env.AUTO_PREMIUM_ACCEPTANCE_ENABLED, true),
    autoPremiumAcceptanceIntervalSec: toNum(process.env.AUTO_PREMIUM_ACCEPTANCE_INTERVAL_SEC, 86400),
    autoPremiumAcceptanceCmd: process.env.AUTO_PREMIUM_ACCEPTANCE_CMD || '',
    autoPremiumAcceptanceTimeoutMs: toNum(process.env.AUTO_PREMIUM_ACCEPTANCE_TIMEOUT_MS, 120000),
    autoPremiumAcceptanceRequireLiveSample: toBool(process.env.AUTO_PREMIUM_ACCEPTANCE_REQUIRE_LIVE_SAMPLE, true),
    autoPremiumAcceptanceBalanceGuardEnabled: toBool(process.env.AUTO_PREMIUM_ACCEPTANCE_BALANCE_GUARD_ENABLED, true),
    autoPremiumAcceptanceMinUsdc: toNum(process.env.AUTO_PREMIUM_ACCEPTANCE_MIN_USDC, 0.0015),
    autoPremiumAcceptanceMinGasToken: toNum(process.env.AUTO_PREMIUM_ACCEPTANCE_MIN_GAS_TOKEN, 0.003),
    autoPremiumAcceptanceGuardChain: process.env.AUTO_PREMIUM_ACCEPTANCE_GUARD_CHAIN || process.env.ONCHAINOS_SKILL_WALLET_CHAIN || String(process.env.CHAIN_ID || 196),
    premiumBalanceCheckIntervalSec: toNum(process.env.AUTO_PREMIUM_ACCEPTANCE_BALANCE_CHECK_INTERVAL_SEC, 900),
    alertPremiumCapacityWarnThreshold: toNum(process.env.ALERT_PREMIUM_CAPACITY_WARN_THRESHOLD, 3),
    alertPremiumCapacityCriticalThreshold: toNum(process.env.ALERT_PREMIUM_CAPACITY_CRITICAL_THRESHOLD, 1),
    autoEvolveEnabled: toBool(process.env.AUTO_EVOLVE_ENABLED, false),
    autoEvolveMode: (process.env.AUTO_EVOLVE_MODE || 'copy').toLowerCase(), // copy|transfer
    autoEvolveBackupToHive: toBool(process.env.AUTO_EVOLVE_BACKUP_TO_HIVE, true),
    autoEvolveBackupAgentId: process.env.AUTO_EVOLVE_BACKUP_AGENT_ID || 'hive/backup',
    autoEvolveMinScoreGap: toNum(process.env.AUTO_EVOLVE_MIN_SCORE_GAP, 0.02),
    autoEvolveMaxPerLoserPerDay: toNum(process.env.AUTO_EVOLVE_MAX_PER_LOSER_PER_DAY, 5),
    autoHiveRecombineEnabled: toBool(process.env.AUTO_HIVE_RECOMBINE_ENABLED, true),
    autoHiveRecombineIntervalSec: toNum(process.env.AUTO_HIVE_RECOMBINE_INTERVAL_SEC, 21600),
    autoHiveRecombineMaxPerDay: toNum(process.env.AUTO_HIVE_RECOMBINE_MAX_PER_DAY, 3),
    autoHiveRecombinePairCooldownSec: toNum(process.env.AUTO_HIVE_RECOMBINE_PAIR_COOLDOWN_SEC, 86400),
    autoHiveRecombineMinAvgScore: toNum(process.env.AUTO_HIVE_RECOMBINE_MIN_AVG_SCORE, 4.2),
    autoHiveRecombineMinRatingCount: toNum(process.env.AUTO_HIVE_RECOMBINE_MIN_RATING_COUNT, 3),
    autoHiveRecombineMinHeat: toNum(process.env.AUTO_HIVE_RECOMBINE_MIN_HEAT, 2),
    autoHiveRecombineSimilarityMin: toNum(process.env.AUTO_HIVE_RECOMBINE_SIMILARITY_MIN, 0.45),
    autoHiveRecombineSimilarityMax: toNum(process.env.AUTO_HIVE_RECOMBINE_SIMILARITY_MAX, 0.95),
    autoHiveRecombineMutationRate: toNum(process.env.AUTO_HIVE_RECOMBINE_MUTATION_RATE, 0.15),
    autoHiveRecombineClusterWindowSec: toNum(process.env.AUTO_HIVE_RECOMBINE_CLUSTER_WINDOW_SEC, 43200),
    autoHiveRecombineClusterMaxInWindow: toNum(process.env.AUTO_HIVE_RECOMBINE_CLUSTER_MAX_IN_WINDOW, 1),
    autoHiveIncubationEnabled: toBool(process.env.AUTO_HIVE_INCUBATION_ENABLED, true),
    autoHiveIncubationIntervalSec: toNum(process.env.AUTO_HIVE_INCUBATION_INTERVAL_SEC, 1800),
    autoHiveIncubationMinMaturitySec: toNum(process.env.AUTO_HIVE_INCUBATION_MIN_MATURITY_SEC, 900),
    autoHiveIncubationMinScore: toNum(process.env.AUTO_HIVE_INCUBATION_MIN_SCORE, 0.68),
    autoHiveIncubationMaxAgeSec: toNum(process.env.AUTO_HIVE_INCUBATION_MAX_AGE_SEC, 172800),
    ratingBayesPriorMean: toNum(process.env.RATING_BAYES_PRIOR_MEAN, 3.8),
    ratingBayesPriorWeight: toNum(process.env.RATING_BAYES_PRIOR_WEIGHT, 3),
    dailyBudgetEnabled: toBool(process.env.DAILY_BUDGET_ENABLED, true),
    dailyBudgetCloneCallsMax: toNum(process.env.DAILY_BUDGET_CLONE_CALLS_MAX, 200),
    dailyBudgetUsdcMax: toNum(process.env.DAILY_BUDGET_USDC_MAX, 2),
    dailyBudgetChainCallsMax: toNum(process.env.DAILY_BUDGET_CHAIN_CALLS_MAX, 600),
    dailyBudgetRecombineRunsMax: toNum(process.env.DAILY_BUDGET_RECOMBINE_RUNS_MAX, 10),
    hardThresholdsEnabled: toBool(process.env.HARD_THRESHOLDS_ENABLED, true),
    hardEventTxLiveRatioMin: toNum(process.env.HARD_EVENT_TX_LIVE_RATIO_MIN, 0.85),
    hardReconcileMismatchMax: toNum(process.env.HARD_RECONCILE_MISMATCH_MAX, 0),
    hardPremiumRemainingCallsMin: toNum(process.env.HARD_PREMIUM_REMAINING_CALLS_MIN, 1),
    hard404RateMax: toNum(process.env.HARD_404_RATE_MAX, 0.05),
    hardThresholdWindowSec: toNum(process.env.HARD_THRESHOLD_WINDOW_SEC, 86400),
    reconcileRequireEventLive: toBool(process.env.RECONCILE_REQUIRE_EVENT_LIVE, true),
    reconcileMinFinalitySec: toNum(process.env.RECONCILE_MIN_FINALITY_SEC, 120),
    reconcileExcludeTestOnly: toBool(process.env.RECONCILE_EXCLUDE_TEST_ONLY, true),
    reconcileTestRequestIdPrefixes: parseCsv(process.env.RECONCILE_TEST_REQUEST_ID_PREFIXES || 'REGPREM-,01JDEMO')
  },
  battleTiming: {
    challengeWindowSec: toNum(process.env.BATTLE_CHALLENGE_WINDOW_SEC, 30),
    acceptLockSec: toNum(process.env.BATTLE_ACCEPT_LOCK_SEC, 10),
    executionSec: toNum(process.env.BATTLE_EXECUTION_SEC, 120),
    settlementSec: toNum(process.env.BATTLE_SETTLEMENT_SEC, 20),
    disputeSec: toNum(process.env.BATTLE_DISPUTE_SEC, 60),
    cooldownSec: toNum(process.env.BATTLE_COOLDOWN_SEC, 300)
  },
  onchain: {
    mode: onchainMode,
    baseUrl: process.env.ONCHAINOS_BASE_URL || '',
    apiKey: readSecret(process.env.ONCHAINOS_API_KEY || '', process.env.ONCHAINOS_API_KEY_FILE || ''),
    timeoutMs: toNum(process.env.ONCHAINOS_TIMEOUT_MS, 10000),
    x402VerifyPath: process.env.ONCHAINOS_X402_VERIFY_PATH || '/x402/verify',
    x402VerifyFallbackUrl: process.env.ONCHAINOS_X402_VERIFY_FALLBACK_URL || '',
    x402VerifyFallbackApiKey: readSecret(
      process.env.ONCHAINOS_X402_VERIFY_FALLBACK_API_KEY || '',
      process.env.ONCHAINOS_X402_VERIFY_FALLBACK_API_KEY_FILE || ''
    ),
    walletTransferPath: process.env.ONCHAINOS_WALLET_TRANSFER_PATH || '/wallet/transfer',
    eventProofPath: process.env.ONCHAINOS_EVENT_PROOF_PATH || '/events/proof',
    eventTxTo: process.env.ONCHAINOS_EVENT_TX_TO || '',
    disableEventHttpFallbackWhenTxTo: toBool(process.env.ONCHAINOS_EVENT_DISABLE_HTTP_FALLBACK_WHEN_TX_TO, true),
    verifyPreferHttpWhenX402Missing: toBool(process.env.ONCHAINOS_VERIFY_PREFER_HTTP_WHEN_X402_MISSING, true),
    resilience: {
      maxAttempts: toNum(process.env.ONCHAINOS_RETRY_MAX_ATTEMPTS, 6),
      baseBackoffMs: toNum(process.env.ONCHAINOS_RETRY_BASE_MS, 400),
      maxBackoffMs: toNum(process.env.ONCHAINOS_RETRY_MAX_MS, 8000),
      jitterRatio: toNum(process.env.ONCHAINOS_RETRY_JITTER_RATIO, 0.2),
      circuitFailThreshold: toNum(process.env.ONCHAINOS_CIRCUIT_FAIL_THRESHOLD, 5),
      circuitOpenSec: toNum(process.env.ONCHAINOS_CIRCUIT_OPEN_SEC, 45)
    },
    faultInject: parsePolicyJson(process.env.ONCHAINOS_FAULT_INJECT_JSON, {}),
    skill: {
      enabled: toBool(process.env.ONCHAINOS_SKILL_ENABLED, false),
      timeoutMs: toNum(process.env.ONCHAINOS_SKILL_TIMEOUT_MS, 12000),
      verifyCmd: process.env.ONCHAINOS_SKILL_VERIFY_CMD || '',
      burnCmd: process.env.ONCHAINOS_SKILL_BURN_CMD || '',
      eventCmd: process.env.ONCHAINOS_SKILL_EVENT_CMD || '',
      useCli: toBool(process.env.ONCHAINOS_SKILL_USE_CLI, true),
      cliBin: process.env.ONCHAINOS_SKILL_CLI_BIN || 'onchainos',
      walletChain: process.env.ONCHAINOS_SKILL_WALLET_CHAIN || String(process.env.CHAIN_ID || 196),
      walletFrom: process.env.ONCHAINOS_SKILL_WALLET_FROM || '',
      burnFrom: process.env.ONCHAINOS_SKILL_BURN_FROM || '',
      burnFromAccountId: process.env.ONCHAINOS_SKILL_BURN_FROM_ACCOUNT_ID || '',
      burnFromX402PayTo: toBool(process.env.ONCHAINOS_SKILL_BURN_FROM_X402_PAY_TO, false),
      burnMinGasToken: toNum(process.env.ONCHAINOS_SKILL_BURN_MIN_GAS_TOKEN, 0.001),
      walletForce: toBool(process.env.ONCHAINOS_SKILL_WALLET_FORCE, true),
      usdcToken: process.env.ONCHAINOS_SKILL_USDC_TOKEN || '',
      x402Network: process.env.ONCHAINOS_SKILL_X402_NETWORK || '',
      x402PayTo: process.env.ONCHAINOS_SKILL_X402_PAY_TO || '',
      x402Asset: process.env.ONCHAINOS_SKILL_X402_ASSET || '',
      x402From: process.env.ONCHAINOS_SKILL_X402_FROM || '',
      x402FromAccountId: process.env.ONCHAINOS_SKILL_X402_FROM_ACCOUNT_ID || '',
      x402AmountDecimals: toNum(process.env.ONCHAINOS_SKILL_X402_AMOUNT_DECIMALS, 6),
      verifyFallbackWallet: toBool(process.env.ONCHAINOS_SKILL_VERIFY_FALLBACK_WALLET, false),
      okxApiKey: readSecret(process.env.OKX_API_KEY || '', process.env.OKX_API_KEY_FILE || ''),
      okxSecretKey: readSecret(process.env.OKX_SECRET_KEY || '', process.env.OKX_SECRET_KEY_FILE || ''),
      okxPassphrase: readSecret(process.env.OKX_PASSPHRASE || '', process.env.OKX_PASSPHRASE_FILE || '')
    }
  }
};
