# Battle Replay Pack

## Target Battle

- battleId: `01KMEZ0HCGFDMZE1NGH853YTQK`
- runRequestId: `RUN_BATTLE-1774323838395-hyfbc`
- resultHash: `0x5ec4bfbb5e0ca3151a7366a6cc9a958ef3507fb7813ed6925810f7a393b0a37c`
- traceHash: `0xbaaa00e443489d20a71afa7399ee4a8dd76d80b454b7d25f16b3994729de5a0b`
- winner: `B`
- scoreA/scoreB: `0.722123` / `0.724735`
- marketSource: `rest`

## Proof Reference

- BattleResult tx: `0x51984faeefd86d81e9c2f1e94e5077f098834e20cf1aafa5e8d316b0a41aa440`
- explorer: <https://www.oklink.com/xlayer/tx/51984faeefd86d81e9c2f1e94e5077f098834e20cf1aafa5e8d316b0a41aa440>
- full proof package: `evidence/proof-audit-2026-03-24T06-37-51.940Z.json`
- battle bundle: `evidence/battle-replay-pack.json`

## Replay / Verification Steps

```bash
# 1) Decode battle event proof
curl -s "http://127.0.0.1:4311/api/proofs/0x51984faeefd86d81e9c2f1e94e5077f098834e20cf1aafa5e8d316b0a41aa440/decode" | jq

# 2) Query battle detail
curl -s "http://127.0.0.1:4311/api/battles/01KMEZ0HCGFDMZE1NGH853YTQK" | jq

# 3) Export proof audit package
curl -s -X POST "http://127.0.0.1:4311/api/proofs/export"   -H "content-type: application/json"   -d '{"limit":200}' | jq
```

## What judges can verify

- `BattleResult.payload.resultHash` 与 battle 记录中的 `result_hash` 一致
- `traceHash` 与 battle 记录中的 `trace_hash` 一致
- `requestId` 可在活动日志/审计包中交叉对应
