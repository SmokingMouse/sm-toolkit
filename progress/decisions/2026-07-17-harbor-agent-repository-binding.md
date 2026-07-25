# Harbor Agent / Repository Binding

## Context

上一版把 Repository 作为 Conversation 可选执行目标、Agent 只保存默认值。实际对标 Mew 后，这会在 Workspace、Agent、Issue、Chat 与 Automation 之间制造多个仓库入口：用户既不知道哪个值最终生效，也可能把同一个 Agent 的长期指令和技能带到意外代码库。用户期望的心智模型是“先配置 Agent 的代码上下文，再把任务交给这个 Agent”。

本决策取代 `2026-07-17-harbor-workspace-repository-scope.md` 中关于可选 `defaultRepositoryId` 与 Conversation 独立选择 Repository 的部分；Workspace 作为逻辑作用域、Run 单仓库快照等其余结论不变。

## Decision

- Workspace 不配置统一仓库地址。Repository 的 `workspace_id` 只用于目录可见性与跨 Workspace 引用保护。
- 每个 Agent 必须绑定恰好一个 Repository 和一台 Device；该 Repository 在 Agent Device 上必须存在 mount。
- Repository、remote、base branch 与本地 checkout 从 Agent 创建/详情界面配置，不提供独立 Repositories 产品入口。
- Issue、Chat、AI Issue draft 与 `new_issue` Automation 不接受独立 Repository；指派 Agent 时派生 Conversation Repository 快照。未指派 Inbox Issue 可以暂时没有 Repository。
- 更换 Assignee 时，未建立 worktree 的 Issue 跟随新 Agent Repository；已有 worktree 或 Review 执行只能使用绑定同一 Repository 的 Agent。
- Run 入队时冻结 Repository、mount 与 execution root。implementation 以当前 Agent Repository 为准；review/verification 必须使用实现 Conversation 的 Repository。
- 旧 CLI `--workdir` 仅作为 Agent 创建兼容入口，自动登记 Repository + mount；任务级 `--repository` 移除。

## Rationale

Agent 是用户真正“派活”的对象，把 Repository 收敛到 Agent 后，选择 Agent 就同时选择了 Runtime、模型、权限、技能、设备和代码上下文。Conversation 仍保存 Repository 快照用于 worktree、Review 与历史审计，但不再成为第二个配置源。Workspace 继续负责工作视图隔离，不承担代码地址语义。

## Alternatives

- **Conversation 独立选 Repository**：灵活，但每次派活都要重复决策，并允许 Agent 在缺少明确代码上下文的情况下跨仓库漂移，因此拒绝。
- **Workspace 绑定一个 Repository**：入口最少，但无法在同一工作视图中维护多个代码库和不同 Agent，因此拒绝。
- **Agent 直接保存绝对 workdir**：实现简单，但无法表达同一 Repository 在多 Device 的不同 checkout，也削弱 Run/Review 的仓库身份校验，因此保留 Repository + mount 两层。

## Consequences

- Schema 变化追加为 v10，不改写已发布 v9；v9 的未绑定 Agent 迁到无 mount 的待配置占位 Repository，保留配置但禁止误执行。
- Agent 创建失败于未选择 Repository 或目标 Device 没有 mount。
- Agent 切换 Repository 必须在无活跃 Run、无未结束 worktree 时进行。
- UI、REST 与 CLI 都必须拒绝任务级 Repository override，避免隐式优先级。
- 同一 Repository/Device mount 仍可被多个 Agent 共享；修改 checkout 路径会影响这些 Agent，UI 必须明确提示。
