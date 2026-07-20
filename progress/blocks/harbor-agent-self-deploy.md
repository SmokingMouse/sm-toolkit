# Harbor Agent-driven self-deploy

## Current Focus

v26 已在生产完成 Delivery 解耦与 Harbor 专属 self-deployer 首跳；当前收尾 v27 GitHub Repository event adapter、legacy deployment audit archive/schema cleanup 与生产 Automation/Webhook。

## Contract

- Delivery 仅承载 MR/PR、review、checks 与 merge；merge 完成即交付完成。
- Codebase `merge_request_merged` Automation 启动 Release Agent Run；Harbor 不内置“merge 后自动 deploy”策略。
- Release Agent 只能提交 Trigger 证明的 exact revision，不能注入 target 路径、argv、凭证或自报成功。
- Self-deploy sidecar 仅操作 Harbor server、daemon、SQLite 与固定 launchd topology；其他项目使用自己的 Agent/Skill/CLI。
- Sidecar 在 server/daemon 重启期间独立存活，保留 immutable release、fencing、backup、health、rollback 与 needs-recovery 语义。
- 历史 Delivery deployment audit 保留为 archive，不改写为新 self-deploy 事实。

## Verification

- Migration fixture 证明历史 Delivery/Job 审计完整归档、Delivery 新语义无 deployment 字段。
- REST/Run action 证明非 Automation、非 Codebase merged、Repository/revision 不匹配均拒绝 enqueue。
- Sidecar 测试证明 queue 幂等、stale fence 拒绝、server/daemon cutover、rollback 与 recovery。
- 全量 Bun tests、root/Web typecheck、全部 production build 与 `git diff --check` 通过。
- 生产分阶段 cutover 后，Codebase merged Automation 能启动 Release Agent，sidecar exact health 成功，旧 Delivery deploy UI/API 不再可达。

## Log

- 2026-07-20：用户确认 Agent-driven self-deploy 边界；创建 `codex/harbor-agent-self-deploy` 隔离 worktree。
- 2026-07-20：v26 bridge 实现完成：Delivery/UI/REST 解耦，新增 Run-scoped exact-revision action、独立 `self_deploy_*` queue、v2→v3 sentinel bridge 与 `com.smokingmouse.harbor.self-deployer` service；root/Web typecheck、Harbor 188-test suite（修正 latest-schema fixture 后）通过。
- 2026-07-20：v26 `368debf` 已推送并由生产 legacy worker exact 部署；schema v26、server/daemon health 与新 `com.smokingmouse.harbor.self-deployer` one-shot service 已验证，旧 deploy-worker 不再加载。
- 2026-07-20：v27 实现完成：Mew Codebase Trigger 可绑定任意 Agent-visible Repository，新增 GitHub HMAC webhook adapter 与 exact merged revision；legacy Delivery deployment snapshot/job 审计迁入 immutable archive，旧字段/表/config fallback 删除，self-deploy gate/fence 保留。Migration fixtures、Harbor 193 tests / 1006 assertions、root typecheck、全 workspace production build 与 diff check 通过；生产 YAML 已安全双写 `self_deploy_target` + 独立 GitHub webhook secret，旧 key 待 v27 验收后删除。

## Next

- 提交/推送 v27；对生产 DB copy 跑 migration dry-run，再创建 Release Automation 并由 Agent 触发 exact self-deploy；验收 schema/archive/health 后删除旧 YAML key、创建 GitHub webhook并完成端到端事件验证。
