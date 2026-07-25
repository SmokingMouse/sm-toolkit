# ADR: Harbor Automation 对齐 Mew 的 Output 与 Trigger 模型

## Context

Harbor 早期为了快速贯通多种执行路径，把底层调度概念直接暴露成 Automation 表单：purpose、output mode、overlap、notify target，以及 1:N schedule/event/webhook Trigger。它们分别有意义，但组合后形成大量互相约束的状态，也偏离用户在 Mew 中已经建立的心智模型。

用户需要回答的只有两件事：结果落到哪里，以及什么时候触发。Run purpose、Conversation 串行和并发冲突是 control plane 的执行细节，不应要求用户理解。

## Decision

### 1. 一个 Automation 恰好一个 Output

- `Run`：只保留 Run history，不创建 Conversation；control plane 派生 `coordination` purpose。
- `Chat`：创建 Chat 并在其中执行；control plane 派生 `coordination` purpose。
- `Issue`：创建可继续推进的 Issue；control plane 派生 `implementation` purpose。
- 删除产品面的 purpose、append、source、target Conversation、notify Chat 与 overlap 选项。
- 同一 Automation 有 active Run 时不并发启动；这是固定的单飞安全语义，不是可选策略。

### 2. 一个 Automation 恰好一个 Trigger

- `Schedule`：保存 cron 与 IANA timezone，执行时使用 Agent 当前 primary Repository。
- `Codebase`：显式选择 Agent 可访问的 Codebase Repository 与一个规范化事件：merge request opened/updated/merged，或 issue opened/updated/commented。
- SCM Provider 的 webhook/refresh/CLI 都先投影外部事实，再归一化成 Codebase event；Automation 不暴露通用 incoming webhook、secret、任意 payload filter 或 Harbor 内部 Domain Event。
- `Run now` 是人工测试动作，不是第三种持久 Trigger。

### 3. v25 是收敛 migration，不保留双产品模型

- 新表对 Output 和 Trigger 使用数据库 CHECK；每个 Automation 由 unique trigger row 保证恰好一个 Trigger。
- 可无歧义表达的旧配置保留：`run/chat/issue + exactly one schedule`，或 `run/chat/issue + exactly one Codebase webhook event + Repository`。
- `append/source`、多 Trigger、内部 event、generic webhook 或其他旧组合写入 `automation_legacy_archive_v25`，不继续出现在新 Automation UI。
- Trigger delivery 去重记录只随成功迁移的 Trigger 保留；历史 Run/Conversation/Issue 不改写。
- 生产现有 `Auto review and merge` 使用 `review + source + internal event`，因此进入归档表；历史 Run 保留。

## Rationale

- Output 和 Trigger 是用户任务语言；purpose 和 overlap 是执行器语言。
- 单值模型消除无效组合，也让 REST、CLI、Web 与 DB 使用同一契约。
- Codebase 是 Repository event，不是把“webhook”换一个展示名称；Provider 边界仍负责认证、映射和外部事实校验。
- 显式归档比静默猜测旧配置更安全：无法证明语义等价时不自动运行。

## Alternatives

- **只改 UI 标签，保留旧 API/DB**：拒绝。隐藏字段仍会从 CLI、旧调用方和 migration 重新进入产品，继续制造双模型。
- **把内部 Domain Event 重命名为 Codebase**：拒绝。Issue/Delivery 生命周期事实与 SCM Repository event 不是同一来源和授权边界。
- **把多个旧 Trigger 拆成多个新 Automation**：拒绝。会改变 Run 次数、幂等和并发语义，属于不可证明的自动化扩张。
- **继续支持 generic webhook 高级模式**：首期拒绝。真实 Provider 应通过 SCM adapter 归一化；未来若需要 integration product，应独立建模而不是污染 Automation Trigger。

## Consequences

- Automation 创建和编辑页只显示 Name、Agent、Prompt、Output、Trigger 与 Enabled。
- REST/CLI 拒绝旧 purpose/outputMode/overlap/target/notify 字段；旧 webhook endpoint 删除。
- Domain Event 继续作为内部 durable audit/状态协调基础，但不再作为用户 Automation Trigger。
- 本 ADR 取代 `2026-07-19-harbor-open-agent-orchestration.md` 第 2 节和 `harbor-mew-parity-p0.md` 中的 Automation 产品模型；开放 Agent 拓扑、Run dispatch、Delivery/Deployment 安全结论不变。
