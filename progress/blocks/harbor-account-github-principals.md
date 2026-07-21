# Harbor Account-scoped GitHub principals

## Current Focus

把 GitHub identity、Repository scope 与执行 principal 解耦：人工 Run 使用发起人的 GitHub user authorization；Automation/webhook/self-deploy 使用 Workspace ServicePrincipal + installation token；Workspace Repository 仅是项目上下文与 allowlist。

## Domain decisions

- `AuthIdentity` 只证明 Harbor Account 对应 GitHub immutable numeric user id，不等于可调用 GitHub API 的授权。
- `GitHubUserAuthorization` 是 Account 对 Harbor GitHub App 的 user-to-server grant。长期 credential 不进入 SQLite、Agent config、prompt、Run event 或普通 daemon environment；SQLite 只保存状态/expiry/credential ref，secret 由 server-owned `0600` credential store 持有。
- `GitHubInstallation` 是无人值守机器权限。它不授予 Workspace 成员个人权限，也不替代 GitHub 对具体用户的权限判定。
- `WorkspaceRepository` / 现有 GitHub repository connection 保留为项目上下文与 allowlist；它限定 Harbor 中这个 Workspace/Run 可以指向什么，但不是 Account credential 的来源。
- 每个 Run 冻结 `RunPrincipal`。人工 Session/PAT 发起的 root Run 使用 Account principal；Automation 使用其一对一 ServicePrincipal；child Run 继承 root principal；未知历史 Run 诚实迁为 system principal。
- GitHub credential broker 的有效权限是 Harbor Run/Agent ACL、Workspace Repository allowlist、GitHub App permissions、installation repository selection 与 GitHub 用户实际访问权的交集。
- Shared Agent 不借用创建者 credential：人工调用时始终 `run_as=caller`。无人值守入口必须显式为 service principal，不能持久化或借用最后一次人类 Session。
- 用户 token 只由 server broker 交给受控 GitHub REST / Git transport；GitHub API action 归因于用户。Automation action 继续归因于 App。
- v30 占用本功能；现有 v29 installation/Repository mapping 无损保留。既有 GitHub identity 因没有可恢复的 user token，迁移后显示“已绑定、待重新授权”。daemon shared credential 本阶段不改。

## Implementation status

1. [x] v30：Account GitHub authorization metadata、ServicePrincipal、Run principal snapshot；migration fixtures 与只读 dry-run。
2. [x] GitHub user-token bundle（access/refresh/expiry）与 server-owned `0700/0600` credential store，支持刷新、撤销、失效和重新授权。
3. [x] principal-aware GitHub credential broker；Delivery / Skill import / Agent action 按 Run/request principal 解析 user 或 installation token，并在取 token 时复验 Membership/ServicePrincipal。
4. [x] 受控 Git push broker：Agent 只提交 push/Delivery intent，daemon 用 dual credential handoff，在隔离的 clean bare transport 中执行 push；LLM runtime 不接收原始 secret，也不能用 Agent 可写 Git config/hook 改写目标或窃取 token。
5. [x] Account/Integrations UI 区分 identity、user authorization、installation 与 Repository allowlist；Harbor builtin Skill 记录 GitHub/Codebase 两类交付方式。

## Log

- 2026-07-21：用户确认推翻“Workspace installation 是所有 Agent 统一权限”的隐含模型。GitHub 官方能力核对：user access token 适合代表具体用户且受 user × App × installation 三重限制；installation token 适合无人参与的 automation。
- 2026-07-21：代码核对确认 v29 只持久化 AuthIdentity/installation/Repository connection；OAuth user token 在 callback 后丢弃，Run 无 principal，GitHub Delivery 与 Skill import 固定使用 installation token。
- 2026-07-21：实现 schema v30、credential vault、OAuth refresh/revoke、Run principal propagation、GitHub broker、daemon-controlled push 与 UI。历史 Run 回填 system；既有 GitHub identity 不伪造 authorization，部署后需一次 reauthorization。
- 2026-07-21：验证通过：`bun test src` 225 tests / 1162 assertions；`harbor` build、`harbor-web` typecheck、`git diff --check` 全绿。daemon credential 未改，仅继续作为 daemon→server dual-auth 的既有 machine credential。
- 2026-07-21：PR #7 merge 后 Agent + sidecar 自动部署 `e29c282` attempt 1 healthy，生产 schema v30、integrity/FK/gate 均正常；验收发现 2 条既有 Automation 的 ServicePrincipal 行已建、但 FK 列为 NULL。根因是 self-deploy cutover 持有 v21 SQLite maintenance trigger，v30 首次 backfill 没像旧 backfill migration 那样在同一 transaction 临时移除并重装 trigger。
- 2026-07-21：追加 v31 repair：v29→v30 与 v30→v31 都在 migration transaction 内临时移除 Automation maintenance trigger，v31 幂等补建/回填 ServicePrincipal 并用 insert/update trigger 禁止 NULL。新增生产形状 v30 repair 与 active-gate regression；全量验证 227 tests / 1165 assertions、双 typecheck/build 全绿。

## Release next

- 推送 v31 repair PR 并由现有 Agent/self-deployer 完成第二次 exact-revision cutover。
- 部署后核对 schema v31、Automation FK 非空 + trigger、credential directory 权限、server/daemon revision 与健康状态；当前用户重新走一次 GitHub OAuth 生成可执行 user authorization。
