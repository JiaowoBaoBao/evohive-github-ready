import { z } from 'zod';

export const domains = ['spot', 'perp', 'strategy', 'earn'];
const risk = ['low', 'mid', 'high'];

export const authEnvelopeSchema = z.object({
  requestId: z.string().min(8),
  agentId: z.string().min(2),
  action: z.string().min(3),
  payloadHash: z.string().min(4),
  issuedAt: z.number().int(),
  deadline: z.number().int(),
  arenaId: z.string().min(2),
  chainId: z.number().int(),
  keyId: z.string().min(1).max(64).optional(),
  namespace: z.string().min(1).max(64).optional(),
  riskToken: z.string().min(8).max(128).optional(),
  signature: z.string().min(4)
});

export const memoryCommitSchema = z.object({
  auth: authEnvelopeSchema,
  memory: z.object({
    memoryId: z.string().min(4),
    domain: z.enum(domains),
    symbolSet: z.array(z.string().min(3)).min(1),
    timeframe: z.string().min(1),
    riskProfile: z.enum(risk),
    benchmarkVersion: z.string().min(1),
    featureVersion: z.string().min(1),
    contentHash: z.string().min(8),
    cid: z.string().optional(),
    encryptedUri: z.string().optional(),
    contentText: z.string().max(4000).optional(),
    note: z.string().max(500).optional(),
    attributes: z
      .array(
        z.object({
          trait_type: z.string().min(1),
          value: z.string().min(1)
        })
      )
      .max(64)
      .optional(),
    ttlDays: z.number().int().min(1).max(365).default(30)
  })
});

export const memoryTransferSchema = z.object({
  auth: authEnvelopeSchema,
  memoryId: z.string().min(4),
  toAgentId: z.string().min(2),
  note: z.string().max(200).optional()
});

export const memoryDeleteSchema = z.object({
  auth: authEnvelopeSchema,
  memoryId: z.string().min(4)
});

export const challengeSchema = z.object({
  auth: authEnvelopeSchema,
  challengerMemoryId: z.string().min(4),
  opponentAgentId: z.string().min(2).optional(),
  matchMode: z.enum(['ranked', 'sparring']).optional(),
  rounds: z.number().int().min(1).max(50).default(10),
  benchmarkVersion: z.string().min(1),
  timeframe: z.string().min(1),
  symbolSet: z.array(z.string().min(3)).min(1)
});

export const acceptSchema = z.object({
  auth: authEnvelopeSchema,
  opponentMemoryId: z.string().min(4)
});

export const runBattleSchema = z.object({
  auth: authEnvelopeSchema,
  mode: z.enum(['paper-realtime', 'paper-replay']).default('paper-realtime')
});

export const premiumBuffSchema = z.object({
  auth: authEnvelopeSchema,
  scope: z.enum(['global', 'domain']).default('global'),
  domain: z.enum(domains).optional()
});

export const hiveMemoryCloneSchema = z.object({
  auth: authEnvelopeSchema,
  note: z.string().max(200).optional()
});

export const hiveMemoryRateSchema = z.object({
  auth: authEnvelopeSchema,
  score: z.number().min(1).max(5),
  note: z.string().max(240).optional()
});

export const memoryGenerateSchema = z.object({
  agentId: z.string().min(2).max(64),
  trajectoryText: z.string().min(20).max(200000),
  manualFocus: z.string().max(200).optional(),
  titleHint: z.string().max(200).optional(),
  domain: z.enum(domains).default('strategy'),
  timeframe: z.string().min(1).max(32).default('1h'),
  riskProfile: z.enum(risk).default('mid'),
  symbolSet: z.array(z.string().min(3)).max(20).optional(),
  benchmarkVersion: z.string().min(1).max(64).optional(),
  featureVersion: z.string().min(1).max(64).optional(),
  ttlDays: z.number().int().min(1).max(365).default(30),
  cid: z.string().max(256).optional(),
  encryptedUri: z.string().max(2048).optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  reusableTemplate: z.string().max(1000).optional(),
  whyItWorked: z.string().max(500).optional()
});
