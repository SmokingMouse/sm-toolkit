# Harbor GitHub Repository provider

## Current Focus

把 GitHub App connection 提升为一等 `Repository.scmProvider = github`，让 UI、Run context、credential broker 与 Delivery 都使用同一个可信状态；不改 daemon credential。

## Domain decisions

- `local` 表示只有 checkout、没有 Harbor 托管的外部交付；`github` 表示存在 active GitHub installation + Workspace binding + Repository connection；`codebase` 表示显式配置的 Codebase Repository。
- GitHub provider 由 integration connection 生命周期维护，不允许用户手填，也不允许 implementation Agent 为绕过失败而修改。
- active GitHub connection 与 Codebase provider 互斥；connection active 时 Repository 自动为 `github`，removed/disconnected/suspended/deleted 时自动回到 `local`。
- implementation Run 的 Delivery provider 必须与冻结 Repository provider 一致；`manual` 只保留给人工登记，不能作为 Agent 绕过路径。

## Log

- 2026-07-21：从 `origin/main@87b4ac6` 建 `codex/harbor-github-provider`；确认生产 schema v31 中 GitHub connection 与 Repository provider 分裂，UI 仅暴露 `local/codebase`，导致 Agent 把真实 GitHub Repository 错改为 Codebase。
- 2026-07-21：实现 v32 migration、三态协议/UI、connection 生命周期 trigger、provider-aware Agent context/credential broker/Delivery、integration sync 防止占用 Codebase Repository，以及 credential 409 安全错误正文透传；builtin Harbor Skill 禁止 Agent 猜测或修改 provider。
- 2026-07-21：v32 fixture 覆盖冲突 backfill、active connection 防改、disconnect/reconnect/removal；相关 REST/integration/broker/Agent tests 已覆盖。
- 2026-07-21：生产 v31 online backup 只在本地副本迁移：schema v32、`integrity_check=ok`、0 FK failure；2 个 active `smokingmouse/sm-toolkit` alias 均变为 `github`，62 个 removed/unmapped Repository 保持 `local`。
- 2026-07-21：验证完成：全量 `bun test` 475 pass / 0 fail，root typecheck、全 workspace production build、`git diff --check` 通过。

## Next

- 提交并推送 PR，由 Harbor Agent + self-deployer 执行 exact-revision cutover。
- 部署后核对 schema v32、两条 active sm-toolkit alias provider、server/daemon revision、health/FK/maintenance gate；再从原 Issue 触发一次 implementation Run 验证受控 push + GitHub PR/Delivery。
