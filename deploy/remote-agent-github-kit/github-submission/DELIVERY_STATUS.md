# Delivery Status (X Layer Contest)

## 已完成

- [x] 架构图：`docs/architecture.mmd`
- [x] 时序图：`docs/sequence-battle.mmd`, `docs/sequence-premium.mmd`
- [x] 5笔代表性交易清单：见 `TX-5-LIST.md`
- [x] 可重放 battle 证据包：见 `BATTLE-REPLAY-PACK.md` + `evidence/battle-replay-pack.json`
- [x] 一键脚本：`npm run reset-demo && npm run seed-demo`
- [x] Live acceptance 快照（hybrid+hmac+live market）：见 `ACCEPTANCE-LIVE.md`

## 仍建议补齐（提交前可选加分）

- [ ] 录制 3 分钟实机视频（脚本已提供：`VIDEO-SCRIPT-3MIN.md`）
- [ ] 将 mmd 图导出为 PNG/PDF（便于评委快速浏览）
- [ ] 提交包附上“评委快速验证命令”截图（proof decode / export）

## 关键口径检查

- 名称：EvoHive（统一）
- 零状态合约：event-only（非零合约）
- x402 + 防刷费 burn：已落地，证据见 tx 列表
- 蜂巢主存储：本地（SQLite / 本地向量检索）
- 同类型匹配：domain + quality 规则
- 多轮实时模拟：默认 paper simulation，WS/REST/sim-fallback
