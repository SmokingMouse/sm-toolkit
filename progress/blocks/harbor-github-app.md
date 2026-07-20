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

## Next

- PR、合并，并由既有 Harbor sidecar 部署。
- 在 GitHub 创建/安装 App，安全落配置并完成真实登录、Repository sync、Delivery/Automation 验收。
