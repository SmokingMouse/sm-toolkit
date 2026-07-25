# Harbor GitHub Repository provider

## Current Focus

GitHub Repository provider 与受控 push transport 均已部署到控制面和 Feature Builder 的 MacBook Device；剩余验收仅是用户从已登录 Account Session 再 Continue 原 Issue，确认真实 PR/Delivery 闭环。daemon credential 未改。

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
- 2026-07-21：用户以 Account principal 重试后，Repository/GitHub connection 与 credential broker 已通过，但 Run `r_47hshysn17` 在 daemon push 阶段失败：临时 bare transport 缺少 Git repository discovery 必需的 `HEAD`，因此 `git --git-dir=... push` 在认证前报 `not a git repository`；Issue 安全退回 Ready，未创建虚假 Delivery/PR。
- 2026-07-21：修复 transport 写入指向固定 source ref 的 `HEAD`；回归测试不再只检查目录文件，而是让 Git 识别该 bare repository、实际 push 到本地 bare remote 并核对目标 branch SHA。全量 `bun test` 475 pass / 0 fail。
- 2026-07-21：PR #12 merge 为 feature revision `df81c878e9214f37faad6a610e2aea0fb0f17cc3`。GitHub App merged delivery 首投 502，以同一 delivery `3832481130917920768` 走 App redelivery API 返回 202；Release Run `r_2i9etjonqh` 成功，sidecar Job `depjob_26h4mulgof` generation 14 attempt 1 到 `healthy`。控制面 `/api/health` exact revision、schema v32、integrity/FK/gate、server/daemon revision 全部通过。
- 2026-07-21：执行 Feature Builder 的 MacBook daemon 建立独立 immutable release 并切到同一 feature revision。首次启动验收发现 release prep 命令 cwd 错在开发 worktree，导致 release 缺 `node_modules`；立即停掉 crash loop，在 release 目录重新 frozen install + 跑真实 push regression 后重启。PID 连续稳定、Device `online=true` 且重新 hello，旧 plist/release 可回滚；daemon credential 未改。

## Next

- PR #10 已 merge 为 `5dd4fee98c0921d0d30a76b739e777be41ac5ffd`；GitHub event → Release Run `r_3aqwcnqraz` → sidecar Job `depjob_2alfeix0cj` generation 12 attempt 1 exact cutover 已完成。生产 schema v32、integrity/FK/gate、两条 active alias、REST projection、server/daemon revision 与 health 全部通过。
- 原 Issue `c_1d0ymfs03b` 由用户从已登录 Session 再 Continue 一次，完成 Account principal controlled push + GitHub PR/Delivery acceptance。这一步不能由 system token 替代，否则会破坏 principal 设计。
