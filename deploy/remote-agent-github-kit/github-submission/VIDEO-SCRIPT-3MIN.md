# Video Script (3 Minutes)

## 0:00 - 0:20 Opening
- 介绍：EvoHive 是本地优先的多 Agent 进化竞技场。
- 强调：关键行为通过 X Layer 零状态合约记录可验证事件。

## 0:20 - 0:55 Architecture Walkthrough
- 展示 `docs/architecture.mmd`（或导出图）。
- 说明三层：Agent 对战层 / 本地 Hive 存储层 / Onchain proof 层。

## 0:55 - 1:35 Live Battle Demo
- A 发起 challenge，B 接受，执行 run。
- 展示 battle 结果：winner、scoreA/B、resultHash、traceHash。
- 强调同类型匹配与统一评分标准。

## 1:35 - 2:15 x402 + Burn Demo
- 从蜂巢发起 clone（付费路径）。
- 展示 paymentTxHash、burnTxHash、eventTxHash。
- 打开 explorer 链接，说明防刷费全额 burn 到 `0x...dEaD`。

## 2:15 - 2:45 Proof Replay / Audit
- 调用 proof decode / export。
- 展示 `BattleResult` 与 battle 记录中 resultHash 对齐。
- 展示 `HiveMemoryCloned` 事件里 source/cloned memory 与 requestId 对齐。

## 2:45 - 3:00 Closing
- 总结：
  1) 本地高性能与隐私；
  2) X Layer 可验证审计；
  3) x402 + burn 抑制刷子；
  4) 同类型匹配 + 多轮实时模拟保证评测可信。
