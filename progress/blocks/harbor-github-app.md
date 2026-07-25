# Harbor GitHub App

## Current Focus

把 GitHub 从管理员静态 PAT 收敛为 Account OAuth identity + Workspace GitHub App installation；后台 Delivery/Automation 只使用 installation token，daemon credential 不改。

## Domain decisions

- `GitHub AuthIdentity` 只证明 Harbor Account 对应 GitHub immutable numeric user id；login 是展示字段，不能作为 subject。
- `GitHubInstallation` 是 GitHub account/organization 对 Harbor App 的授权实例；一个 installation 可显式连接多个 Harbor Workspace。
- `GitHubRepositoryConnection` 把 installation 内的 GitHub repository id 映射到一个或多个 Workspace Repository alias；这是生产上普通开发与 self-hosting/release 使用不同 mounts/Agents 的真实需求。remote URL 只用于首次发现全部同源 alias，之后外部数字 id 才是稳定身份。
- GitHub user access token 只在 OAuth callback 内验证用户与 installation 的交集，随后丢弃；后台自动化只缓存约一小时的 installation token，二者均不落 SQLite。
- v29 由本功能占用；原 P6.2 Device ownership/enrollment 顺延，daemon shared credential 保持 legacy compatibility。

## Log

- 2026-07-21：从 `origin/main@6566418` 建 `codex/harbor-github-app`；完成领域边界核对。
- 2026-07-21：开始 v28→v29 migration fixtures/dry-run。migration 只扩展 OAuth state、installation、Workspace connection、repository connection 四张表，不读取或迁移静态 GitHub token。
- 2026-07-21：v29 fixture、只读 dry-run report 与 migration preflight 已完成；非法可变 GitHub subject 会阻断，重复 remote 只告警且不猜 installation 映射。
- 2026-07-21：完成 GitHub App JWT、OAuth identity、installation ownership 复核、内存 installation token、Repository connection/sync、全局 App webhook、Delivery/Skill import credential provider，以及 Login/Account/Integrations Web 入口。旧 `HARBOR_GITHUB_TOKEN`/`github.token` 运行路径已移除。
- 2026-07-21：对 Mac mini schema v28 online backup 运行真实 dry-run：`migratable=true`，1 Account、2 Workspaces、2 GitHub remote Repository、0 旧 GitHub identity/Delivery、0 blocker。唯一 warning 是 `smokingmouse/sm-toolkit` 有 2 个 Harbor Repository alias；核对 mounts/Agents/self-deploy target 后确认这是开发与 release 的有意分视图，因此 v29 改为一份 GitHub repository id 映射全部 alias，不合并/归档历史 Repository。
- 2026-07-21：验证完成：`bun run build` 通过（含 Next production export），全量 `bun test` 449 pass / 0 fail，`git diff --check` 通过；旧 schema lineage 断言已推进到 v29。
- 2026-07-21：PR #3 合并为 `e72e75e`；真实 merge webhook 首投因 Harbor 10s 响应超时未触发，使用同一 GitHub delivery id、GitHub API 的真实 PR 数据与主机内 webhook secret 做签名 replay 后，Release Agent 正常创建 generation 6 sidecar job。
- 2026-07-21：generation 6 在切换前的 launchd stop proof 遇到 label/PID 短暂过渡态并 fail-closed；首次管理员 recovery 因手工注入 raw health token 超时，改用 worker-entry 原格式 `Bearer <token>` 后验证旧 `6566418` baseline、释放 gate，DB 保持 v28。根因是 `bootout` 后只有一次即时 proof，修复为在任何 DB/plist/symlink 变更前有界重试 exact unload + 全部 observed PID death，超时仍 fail-closed。
- 2026-07-21：PR #4 合并为 `6970525`，真实 GitHub webhook 202 并由 Agent 创建 generation 7；新 server 启动时发现 production 仅有旧独立 `github.webhook_secret`，GitHub App all-or-nothing parser 将其误判为半配置并退出，sidecar 验证 PID 失败后自动完整回滚，DB 仍为 v28、旧 baseline 健康。rolling config 修复为仅 App 字段出现时才激活完整校验，standalone legacy webhook secret 在新 GitHub App runtime 中保持 disabled。
- 2026-07-21：PR #5 合并为 `208b88c`，真实 merge webhook 触发 generation 8 sidecar 成功部署；生产 server + daemon 均运行 exact `208b88cde7ddf77c72e80accb9bad36d66e1e628`，schema v29、health healthy、maintenance=false、DB integrity=ok，daemon credential 未改。
- 2026-07-21：用 GitHub App manifest flow 创建 private App `harbor-smokingmouse-home`；修正 manifest 中不受支持的 `email_addresses` default permission，并为 `issues` / `issue_comment` 事件补齐 `issues: write`。App config 与 private key 原子写入 Mac mini，均为当前用户 `0600`；Harbor `/api/auth/github/status` 已 configured。
- 2026-07-21：真实 Account OAuth identity 已按 GitHub numeric subject 绑定 `acc_bootstrap`；installation 已 active 连接 `ws_personal`，installation token 成功列仓并生成 64 条 active Repository connection / 63 个 distinct GitHub repository，其中 `smokingmouse/sm-toolkit` 正确映射普通开发与 self-hosting 两个 alias。user access token 与 installation token 均未落 SQLite。
- 2026-07-21：App 创建/安装时的首个 `ping` 与 `installation.created` 撞上配置重启窗口而为 502；server healthy 后通过 GitHub App redelivery API 重放，两条均真实返回 200。当前 installation 选择 `all` repositories；多人加入前需由 owner 决定是否收窄为 selected repositories，避免 `ws_personal` 暴露无关仓库。

## Next

- 多人协作前把 GitHub installation 从 `all` 收窄到所需 repositories，或新建边界独立的团队 Workspace；成员只走 Harbor Invitation + 自己的 GitHub identity，不重复安装同一 target 的 App。
- 需要把成员自己的机器作为 Device 时进入 P6.2 Device ownership/enrollment；这与 Account/Workspace GitHub onboarding 分开，当前 daemon credential 仍保持 legacy compatibility。
