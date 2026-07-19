# ADR: Harbor 提供开放式 Agent 编排机制，不内置团队策略

## Context

早期 Agent team 方案把 Orchestrator、Developer、Reviewer 固定为产品角色，并配置统一 Review Automation。这证明了 Harbor 的 Run-scoped capability、Delivery policy 与事件闭环可行，但也把一种用户编排方案误当成了 control plane 本身：控制面开始承担“应该选哪个 Reviewer”的策略，Device/Agent 关系也容易被理解为中央 Reviewer Pool。

用户要求 Harbor 以扩展能力为核心：是否需要协调 Agent、每个事件交给谁、采用直接派发还是 Agent 二次路由，都应由用户自行定义。Harbor 只负责让这些选择可持久、可审计、可恢复且不能绕过安全边界。

本 ADR 推翻 `2026-07-19-harbor-agent-team.md` 中“固定三类 Agent 是产品层结构”和“由统一 Reviewer Automation 代表默认策略”的部分；其中 Run-scoped capability、Provider/Delivery gate 和确定性 Deployment worker 的安全结论继续有效。

## Decision

### 1. Run 是执行主体，Agent 拓扑是用户配置

- Harbor 不创建或保留特殊 Orchestrator、Developer、Reviewer 类型，也不维护 Reviewer Pool。
- Agent 仍是普通执行配置；角色来自 instruction + bound Skills + Automation/人工派发关系。
- `coordination` 是中性的 Run purpose：可读取控制面安全快照并派生 Run，但自身不改 Issue stage、Assignee 或 Delivery。
- 用户可选择 direct Automation、自定义协调 Agent、人工派发或混合模式；这些都是同一机制的不同配置，不是 Harbor 内部分支。

### 2. Automation 消费持久领域事件

- Harbor 把 `issue.created / issue.ready / issue.review_ready / delivery.merge_ready / delivery.merged` 持久化为稳定 Domain Event。
- 领域事实与事件在同一 SQLite 事务中提交；投递以 Trigger + event id 幂等，重启会重放未投递事件。
- Trigger 只消费其创建时间之后的事件，避免新增 Automation 意外扫过全部历史任务。
- Automation 的 Agent、prompt、purpose、output、overlap、enabled、target、notify 与 Trigger 可从 Web/API 修改，无需删除重建。

### 3. Run-scoped dispatch 显式选择 Agent

- action-capable Run 获得短期 context/dispatch URL，而不是 owner token。
- context 只返回当前 Run、Conversation、Issue、Delivery、可选 Agents/Repositories 的安全快照，不泄漏 session、mount、worktree 或凭证。
- dispatch 请求必须显式提交目标 Agent、purpose、prompt 与稳定 idempotency key；Harbor 不推断“最佳 Reviewer”。
- child Run 固定同 Workspace/Conversation/source，持久化 parent/root/depth/dispatch key；深度上限、语义冲突、Conversation 串行、Repository 与 Delivery policy 均 fail closed。

### 4. 跨 Device Review 绑定 Provider exact revision

- Review Agent 可位于用户选择的任意兼容 Device，不要求共享 implementation worktree。
- GitHub/Codebase Provider 必须先提供 latest trusted head revision、head/base 与 remote identity；server 将证据冻结在 RunSpec。
- daemon 校验 Repository remote identity，fetch exact ref，并证明 `FETCH_HEAD` 等于 Provider revision 后创建 detached per-Run linked worktree。
- Run 结束正常清理；dirty/unremovable checkout 明确失败；daemon 重连会回收 orphan checkout。
- manual Delivery 或缺少可信 revision 时不降级猜测，只允许实现所在原 mount/worktree 本地 Review。

### 5. 合并与部署边界不变

Review decision、CI、head SHA、merge revision 与 deployment completion 仍由 Harbor policy + SCM Provider + deterministic host worker 收敛。自定义协调 Agent只能决定“派谁做下一次 Run”，不能自行写外部事实、跳过 approval/check/merge 或获得部署权限。

## Rationale

- 角色和团队拓扑是产品使用策略；事件、幂等、授权、隔离和状态收敛才是 Harbor 的基础设施职责。
- 显式 Agent 目标让行为可解释，也允许单人单机、固定团队、多 Device、领域 Reviewer、人工插入等不同组织方式复用同一内核。
- 持久 Domain Event 消除内存 event bus 在 commit 后崩溃的丢失窗口；Run lineage 和稳定 key 消除协调 Agent 重试造成的重复派发。
- exact-revision checkout 解开 Review Agent 与实现 Device 的物理耦合，同时不牺牲“审查的就是 Provider 当前 head”这一证据链。

## Alternatives

- **内置 Orchestrator Agent**：拒绝。不是所有用户都需要二次路由，且会把一种 prompt 策略固化进 Harbor core。
- **Control plane 从 Reviewer Pool 自动选人**：拒绝。设备负载、领域能力、信任和组织分工属于用户策略；平台推断会制造隐藏行为。
- **只允许 Automation 直派**：拒绝。简单但无法支持需要读取上下文、拆解或动态选择的自定义协调流程。
- **Review 继续要求共享本地 worktree**：拒绝。会让 Agent 永久绑定 implementation Device，阻碍多机参与；对有 SCM trusted revision 的 Delivery 没有必要。
- **任意 git ref checkout**：拒绝。branch 名会漂移，调用方自报 SHA 也不可作为 Delivery 事实；必须由 Provider 证明且 daemon 再校验 fetch 结果。

## Consequences

- 既有名为 Orchestrator/Developer/Reviewer 的 Agent 与 Automation 仍可继续工作，但只是用户配置，不再具备隐式平台地位。
- Automation/自定义协调 Agent 的配置质量决定具体流程；Harbor 保证的是授权与事实正确性，而非团队策略一定合理。
- SQLite schema 升至 v22；server 与 daemon 应作为同一 release 部署，旧 daemon 不具备 exact Review checkout/cleanup 协议。
- 单控制面仍保持 SQLite single-writer；Mac mini cutover 必须停旧 server、复制并验证 DB、启动新 server/worker，再让所有 Device 重连，不能双活。
