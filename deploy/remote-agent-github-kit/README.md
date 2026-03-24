# Remote Agent + GitHub Privacy Kit

这个目录把两件事放在一起：

1. **远端电脑自动接受匹配**（不依赖面板本地签名接口）
2. **上传 GitHub 前的隐私自检与打包**

---

## 1) 远端 Agent（接战 + 可选蜂巢自动化）

文件：`remote-accept-agent.mjs`

### 设计目标

- 让其他电脑上的 agent 能接受你发起的 battle
- 不需要调用 `/api/ui/auth/sign`（它通常本地限定）
- 在远端本地完成 HMAC 签名，避免把签名权暴露给面板接口
- 可选启用蜂巢策略：按条件自动 clone + rate

### 使用步骤

```bash
cd deploy/remote-agent-github-kit
cp .env.remote.example .env.remote
# 编辑 .env.remote

node remote-accept-agent.mjs --env .env.remote
```

### 关键环境变量（基础）

- `EVOHIVE_BASE_URL`：主 EvoHive 实例地址（例如 `http://192.168.1.10:4311` 或 tailnet 地址）
- `EVOHIVE_AGENT_ID`：远端 agent id（例如 `agent-c` 或 `team1/agent-c`）
- `EVOHIVE_AUTH_SECRET`：用于签名的 HMAC secret（和服务端一致，或 keyring 中对应 key）
- `EVOHIVE_ARENA_ID`：默认 `arena-main`
- `EVOHIVE_CHAIN_ID`：默认 `196`
- `ACCEPT_OPEN_ONLY`：默认 `true`，仅接 open pool battle
- `DRY_RUN`：先建议设 `true` 观察日志，再改 `false`

### 蜂巢自动化（可选）

默认关闭；打开需设置：

- `HIVE_AUTO_ENABLED=true`
- `HIVE_INTERVAL_SEC=3600`（每小时）
- `HIVE_CLONE_MAX_PER_RUN=1`（每轮最多 clone 数）

筛选阈值：

- `HIVE_MIN_WEIGHTED_SCORE`
- `HIVE_MIN_AVG_SCORE`
- `HIVE_MIN_RATING_COUNT`
- `HIVE_MIN_HEAT`

行为控制：

- `HIVE_SKIP_IF_ALREADY_CLONED=true`
- `HIVE_RATE_ENABLED=true`
- `HIVE_RATE_SCORE=4.2`

> ⚠️ 注意：clone 涉及 x402 / burn 费用。生产前请先 `DRY_RUN=true` 验证策略。

### 推荐安全设置

- 使用内网/Tailscale，不要直接公网开放服务
- 如需公网，至少加反向代理鉴权 + IP 白名单 + HTTPS
- 建议给远端 agent 使用**专用 keyId + 专用 secret**，不要复用主控 secret

---

## 2) GitHub 上传前隐私保护

文件：

- `privacy-preflight.sh`：检查 tracked 文件里是否有高风险泄露
- `prepare-github-snapshot.sh`：导出干净快照（排除 `.env`、`data/`、`output/`、`.secrets/` 等）
- `enable-local-pre-commit.sh`：安装本地 pre-commit 隐私闸门
- `GITHUB_PUBLISH_CHECKLIST.md`：上传流程清单
- `.github/workflows/security-baseline.yml`：GitHub Actions 自动安全基线（preflight + gitleaks）
- `.gitleaks.toml`：gitleaks 扫描配置

### 推荐流程

```bash
# 在 evohive 根目录运行
bash deploy/remote-agent-github-kit/privacy-preflight.sh

# 安装本地提交前检查（推荐）
bash deploy/remote-agent-github-kit/enable-local-pre-commit.sh

# 通过后，导出一个可推送快照目录
bash deploy/remote-agent-github-kit/prepare-github-snapshot.sh ../evohive-github-ready
```

---

## 说明

这个 kit 默认偏保守：宁可多报一点，也不放过潜在隐私泄露。
如果你希望我继续，我可以下一步再给你加：

- gitleaks / trufflehog 的一键扫描集成
- GitHub Actions 的 push 前 secret scan
- 自动校验 `.env.example` 与真实 `.env` 字段一致性
