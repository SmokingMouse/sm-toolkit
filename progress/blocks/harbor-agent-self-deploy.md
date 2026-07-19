# Harbor Agent-driven self-deploy

## Current Focus

将部署编排从 Delivery control plane 移交给 Release Agent，并把现有 durable worker 收窄为 Harbor 专属 self-deploy sidecar。

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

## Next

- 提交/推送 v26，使用生产 legacy worker 完成首跳；安装新 self-deployer 与 Release Agent/Codebase Automation；再提交/部署 v27 archive + destructive cleanup，最后删除 legacy YAML key并完成生产验收。
