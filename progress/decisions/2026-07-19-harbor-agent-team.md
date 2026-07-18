# Harbor Agent Team 与事件驱动交付

## Context

现有 Harbor 已经以 Run 为执行主体、Issue/Delivery 为治理主体，但 Agent 分工主要停留在 instruction：Developer 无法在不拿 owner token 的前提下把 PR 纳入 Delivery，Reviewer 无法把独立 review 转成受 policy 约束的 approve/request-changes/merge；Automation 只有 cron/webhook，也无法可靠表达“进入 Review 就派 Reviewer”。

用户希望形成一支固定团队：主控负责理解、拆解与路由；Developer 实现 Issue 并提 PR；Reviewer 独立 review、返工或合并；每次 merge 自动部署。

## Decision

### 1. 职责分层

- **Orchestrator Agent**：默认只理解请求、回答问题、拆解和路由。需要执行时通过 Run-scoped action 创建同 Workspace Issue，显式选择目标 Agent 并 dispatch；不直接写 Issue 状态。
- **Developer Agent**：`auto-edit + worktree`。只改当前 Issue 的 `harbor/<Issue ID>` 分支，完成验证、commit、push；再通过 Run-scoped Delivery action 注册已有 PR，或由 server-side GitHub credential 创建 PR。它不能 approve 或 merge。
- **Reviewer Agent**：`readonly + worktree`。读取同一 Issue worktree/PR/测试事实，提交 `approve` 或 `request_changes`。request changes 会把 Developer Run 串行排在当前 Review Run 后；approve 会由 server 重新同步外部事实，只有 head SHA 未变且 CI passed 才允许 merge。
- **Deployment Provider / host worker（非 Agent）**：`DeliveryService` 在 merge policy 满足后为管理员预配置 target 幂等入队 exact revision；独立 worker 执行 fetch、验证、切换、health 与 rollback。它不消费 prompt、不做开放式判断，也不持有 Agent 身份。把发布权限交给 Orchestrator 或第四个 LLM Agent 都会扩大 prompt injection 风险面。

### 2. Automation 是领域事件消费者，不是轮询状态机

新增可信 `event` Trigger，与外部低信任 `webhook` 分开。首批稳定事件：

- `issue.review_ready`：implementation Run 成功并把 Issue 推进 Review 后发出；`source + review` Automation 把 Reviewer Run 派回原 Issue。
- `delivery.merge_ready`：approval 与 checks 都满足且当前没有 Review Run 时发出；同一 Reviewer Automation 可补做延迟 merge。
- `delivery.merged`：Delivery 首次观察到 merged 时发出，可供通知、审计或低权限 verification Automation 消费；部署 target 的 durable enqueue 不依赖 event bus。

每个 Trigger 以稳定 `eventId` 持久化去重。server boot 会从已落库的 Run/Issue/Delivery 事实重放缺失事件，解决“事实已提交、进程在 dispatch 前崩溃”的窗口；重复重放不会重复派活。

`source` output 从可信事件的 `conversationId` 动态选择原 Conversation，不允许 schedule/webhook 冒充。Automation 持久化 Run `purpose`，Review 不再伪装成 implementation。

### 3. Run-scoped action 是 capability，不是缩小版 owner token

daemon 只给当前 Run 注入短期 token 和三个专用 URL：

- Issue action：创建/指派/dispatch 新 Issue；Repository 仍由目标 Agent 决定。
- Delivery action：仅 running implementation Run、仅当前 Issue、仅固定 `harbor/<Issue ID>` head branch；可调用 server-side Provider 创建 PR，但不能 approve/merge。
- Review action：仅当前 review Run；可 approve/request changes。merge 仍由 DeliveryService 重新同步 Provider 事实并执行 SHA、CI、open-state 与并发 revision policy。

token 在 Run 终态撤销，永不进入 prompt、数据库明文或日志。Agent 不能改当前 Issue 状态、不能调用任意 REST、不能拿 `HARBOR_TOKEN`。

### 4. Merge 与部署完成是两段事实

GitHub Delivery 现在允许 `deploymentRequired=true`，推翻旧 ADR 中“GitHub 固定无需部署”的阶段性限制。配置 target 时，merge 后由 `DeliveryService` 在同一事实收敛链路幂等创建 durable deployment job；worker 的 fenced result 才能写回 succeeded/failed。没有 target 时保留显式人工 deployment fallback。只有 review approved + checks passed + merged + deployment succeeded 才把 Issue 推进 Done，Agent 自报成功或单纯收到 merged event 都不能完成 Issue。

## Rationale

- Agent 负责判断与产出，control plane 负责授权、串行、状态和外部事实；模型失误不能越过 Delivery policy。
- 领域事件比每分钟扫描更及时，也避免重复 Review；boot reconciliation 又补上纯内存 event bus 的丢失窗口。部署队列直接以 Delivery/Job 唯一约束保证 durable idempotency，不把主机发布正确性押在事件消费上。
- PR 创建使用 server credential，Reviewer 使用 scoped decision，不要求在 Device 上散落 GitHub owner token。
- 确定性 host worker 让 Orchestrator/Reviewer 继续保持最小权限，并让主机 mutation、health、rollback 与 fencing 有单一审计入口。

## Alternatives

- **给所有 Agent 注入 HARBOR_TOKEN**：拒绝。它等价于 owner 权限，任何 prompt injection 都可改状态、成员与配置。
- **Reviewer 直接调用 `gh pr merge` / `bitscli merge`**：拒绝。会绕过 Harbor 的 head SHA、CI、revision 与 deployment policy。
- **cron 每分钟扫描 Review/merged**：拒绝。延迟、重复和 missed-run 语义都比稳定领域事件/durable job 差；cron 仍保留给真正基于时间的任务。
- **Orchestrator 同时负责部署**：拒绝。主控处理任意用户输入，给它生产写权限扩大了不必要的风险面。
- **第四个 LLM Deployment Agent**：拒绝。部署步骤、health identity、rollback baseline 与 fence 都可确定化；引入开放式模型判断只会增加权限和不可证明状态。
- **Review Agent 直接把 Issue 标 Done**：拒绝。Review 只是证据之一；merge/部署仍是独立外部事实。

## Consequences

- GitHub 全自动 PR/merge 仍要求 harbor-server 配置最小权限 `HARBOR_GITHUB_TOKEN`，Device 还需要能 push `harbor/<Issue ID>` 分支；缺配置时能力明确失败，manual/Codebase 不受影响。
- Reviewer 在 CI 尚未通过时会保留 SHA-bound approval 并返回 deferred；后续 Provider refresh/webhook 使 Delivery 进入 merge_ready 时可再次派 Reviewer。
- host worker 是唯一需要 production release、SQLite backup 与 launchd mutation 权限的进程；target 只能来自管理员 0600 配置，完整命令/路径/secret 不进入 Agent prompt 或 Delivery API。
- canonical SQLite v16 重建 Run prompt-event CHECK、Delivery actor CHECK、Automation/Trigger 表；Local launchd Provider 随后用 v17–v19 加入 durable job、recovery 与 host fencing，保留既有 Run、Delivery event、Automation delivery 去重数据。
