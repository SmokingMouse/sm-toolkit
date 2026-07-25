# Harbor Open Orchestration

> 历史实现记录：Automation 的 purpose/output/overlap/event Trigger 产品面已在 schema v25 被 `progress/decisions/2026-07-19-harbor-mew-automation-model.md` 取代；Run dispatch 与开放 Agent 拓扑结论继续有效。

## Current Focus

把 Harbor 收敛为“开放编排机制、用户自定义策略”：不内置 Orchestrator/Reviewer Pool，补齐领域事件、Run-scoped dispatch/query、跨设备 exact-revision Review 与 Automation 编辑，并迁移单控制面到 Mac mini。

## Acceptance Contract

- Automation 可订阅 `issue.created` / `issue.ready` 等可信事件，事件持久化、幂等、重启可重放。
- 任意 action-capable Run 可在同 Workspace/Conversation 安全查询上下文并显式指定 Agent 派生后续 Run；Harbor 只校验，不替用户选择。
- 派生 Run 有 lineage、幂等键与深度上限，不能绕过 Issue purpose、Repository mount、Conversation 串行或 Delivery policy。
- Review 可在用户指定的任意兼容 Device 上检出 Delivery 的 exact trusted head revision；无可信远端 revision 时继续只允许原 mount 本地审查。
- Automation 的 Agent/prompt/purpose/output/overlap/trigger 可从 Web/API 修改，不再只能重建。
- 既有 direct Automation、手动 Reviewer、Issue worktree、Delivery/Deployment 与 Skill 隔离行为不回归。
- 定向测试、Harbor 全量测试、root typecheck/build 与生产 self-hosting Review/Deployment 全绿；随后 Mac mini 承载 server/DB/worker，其他 Device 重新接入。

## Constraints

- 不新增内置 Orchestrator Agent、Reviewer Pool 或 control-plane Agent 选择策略。
- 不给 Agent owner token、任意 REST/SQLite/SCM shell 权限；新增能力继续使用短期 Run token。
- 自动部署仍由确定性 host worker 执行；Agent 不获得部署权限。
- 暂不引入 HA、多控制面或单 Run 多写 Repository。

## Pause Conditions

- exact revision 无法从 Provider 事实证明，或目标 Device remote identity 不匹配 Repository 时 fail closed。
- Mac mini 迁移若无法证明 DB/release/launchd baseline 与回滚路径，停止 cutover，不双写两个控制面。

## Log

- 2026-07-19：从 `main@a5bf458` 创建 `codex/harbor-open-orchestration` 独立 worktree，开始影响面审计。
- 2026-07-19：完成开放编排内核：持久 Domain Event、可编辑 Automation/Trigger、Run lineage 与显式 Agent dispatch、`coordination` purpose、Run-scoped context，以及 exact-revision Review checkout/cleanup；Harbor 未引入内置 Orchestrator、Reviewer Pool 或 Agent 选择策略。
- 2026-07-19：完成 Harbor Skill 与 Web 管理面同步；源码测试 204/204、focused GitHub Provider 测试 32/32、root typecheck、Harbor Web typecheck、root build 均通过。

## Verification

- `rg --files packages apps/harbor/src apps/harbor-web | rg '\.test\.(ts|tsx)$' | xargs bun test`：204 pass / 0 fail。
- `bun run typecheck`：pass。
- `apps/harbor-web: bun run typecheck`：pass。
- `bun run build`：所有 workspace build exit 0；Next.js 12/12 static pages generated。

## Next

- 已以 `60759a6` + `0d2d425` 提交、fast-forward 合并并推送。
- 已按单写原则把 server/DB/worker cut over 到 Mac mini；两台 Device 重连，生产 revision/schema/manifest/worker/Web smoke 与两端回滚备份均确认。
- 剩余外部验收：真 SCM credential/webhook、真飞书与时间性负载。
