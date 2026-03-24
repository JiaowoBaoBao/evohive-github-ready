# GitHub Publish Checklist (Privacy-first)

> 建议先发到 **private repo**，确认无敏感信息后再改 public。

## A. 推送前

- [ ] 在 EvoHive 根目录执行：
  ```bash
  bash deploy/remote-agent-github-kit/privacy-preflight.sh
  ```
- [ ] 建议安装本地 pre-commit 闸门：
  ```bash
  bash deploy/remote-agent-github-kit/enable-local-pre-commit.sh
  ```
- [ ] 确认 `.env`、`data/`、`output/`、`.secrets/` 没有被 git 跟踪
- [ ] `.env.example` 仅保留占位符，不含真实 key/secret
- [ ] 检查最近提交信息里没有敏感信息

## B. 需要分享但不想带敏感数据时

- [ ] 导出干净快照：
  ```bash
  bash deploy/remote-agent-github-kit/prepare-github-snapshot.sh ../evohive-github-ready
  cd ../evohive-github-ready
  ```
- [ ] 在快照目录再次执行 preflight
- [ ] 仅从快照目录 push

## C. GitHub 初始化（快照目录中）

```bash
git init
git add .
git commit -m "chore: initial open-source snapshot"
git remote add origin <your-github-repo-url>
git push -u origin main
```

## D. CI 安全闸门复核

- [ ] 确认 `.github/workflows/security-baseline.yml` 已存在并启用
- [ ] 首次 push 后，检查 Actions 中 `security-baseline` 工作流是否通过
- [ ] 若工作流失败，先修复告警再合并/发布

## E. 推送后复核

- [ ] GitHub Web 上全局搜索 `EVOHIVE_AUTH_SECRET` / `ONCHAINOS_API_KEY` / `PRIVATE KEY`
- [ ] 若发现泄露，立刻：
  1. 删除远端 commit/历史（filter-repo）
  2. **轮换**相关 secret
  3. 重建干净仓库并重新 push
