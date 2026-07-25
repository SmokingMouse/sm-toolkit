# Harbor Delivery Control Plane

## Context

Harbor 现有流程在 implementation 成功后进入 Review，但 `Approve & Close` 会直接把 Issue 标为 Done 并清理 worktree。代码交付中的 MR/PR、CI、合并、部署没有结构化事实，也没有安全闸；把这些动作完全交给 Agent prompt 又无法保证幂等、权限和审计。

## Decision

1. Issue stage 保持现有看板语义；新增可选 `Delivery`，当前一个 Issue 最多一份主交付记录。代码 Issue 在 Delivery 完成前停留在 Review，非代码 Issue 仍可直接人工完成。
2. Delivery 不存单一可写状态，而是持久化 review/check/merge/deployment 四组正交事实，并由 control plane 派生展示状态。
3. 合并和部署由 Harbor 内置 policy 校验，具体外部操作通过 `DeliveryProvider` 适配。首期提供诚实的 `manual` provider：只在用户明确确认后记录事实，不声称已调用外部平台。
4. 合并门槛固定为人工验收 + CI passed；部署只能在 merged 后开始；无需部署或部署 succeeded 才推进 Issue Done 并触发 worktree cleanup。
5. 新一轮 implementation 会使未合并 Delivery 的人工验收与 CI 证据失效；已经 merged 的 Delivery 不允许继续在原 Issue 上返工。

## Rationale

- 保留 Mew 式五列看板，避免把 SCM/CD 的细状态扩散成八九列 Issue 状态。
- 正交事实可以容纳 CI 失败、先审批后等 CI、已合并待部署等真实组合，也便于未来由 webhook/provider 同步。
- policy 与 provider 分离后，自定义 Agent/Skill 可以请求动作，但不能绕过 Harbor 的确定性安全边界。
- `0..1` 主 Delivery 对齐当前一 Issue 一 worktree/branch 的实现；后续若出现一 Issue 多仓库，再在 Delivery 下增加 Change 集合，而不是现在提前放大模型。

## Alternatives

- **把 merge/deploy 全写进 Agent Skill**：拒绝。Skill 适合描述工具与 SOP，不适合持有状态真相、审批和幂等语义。
- **把 merge/deploy 全写死进 Harbor**：拒绝。Codebase/GitHub/TCE/其他 CD 的接口差异应由 Provider 隔离。
- **扩展 Issue stage 为 merge-ready/merged/deploying**：拒绝。它会把项目管理阶段与外部交付流水线耦合，破坏现有 Mew 式看板。
- **首期直接接 GitHub/Codebase**：暂缓。当前没有已配置的 API 凭证与统一仓库映射，先完成领域闭环和 manual provider，避免伪集成。

## Consequences

- Review 页面需要新增 Delivery 卡片和明确的“无交付直接完成”路径。
- REST 详情要返回 Delivery 与事件；Provider/Webhook 可在后续复用相同 service，不再修改 Issue 状态机语义。
- 多 MR、多环境部署、自动 merge/deploy 暂不在首期模型中，待真实 Provider 需求出现后扩展。
