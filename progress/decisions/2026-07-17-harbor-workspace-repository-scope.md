# Harbor Workspace / Repository Scope

## Context

Harbor 需要同时开发多个代码仓库，也需要把不同工作上下文下的 Agents、Skills、Issues 与 Automations 分开。若把 Workspace 直接等同于仓库，跨仓库项目会被拆散；若继续把 Agent 永久绑定 `workdir`，同一个 Agent 配置也无法自然服务多个仓库或多台设备上的不同 checkout。

## Decision

- Workspace 是 Harbor 的一级逻辑作用域，不是 Repository、目录、Device 或租户。
- Repository 是 Workspace 内的逻辑代码资源；RepositoryMount 表示它在某台 Device 上的 checkout 路径。
- Agent 固定归属一个 Workspace 与一台 Device，可选 `defaultRepositoryId`，但不保存永久 cwd 语义。
- Conversation 属于 Workspace，可选一个 Repository；Run 入队时冻结 workspace、repository、mount 与 execution root。
- 一个 Run 最多写一个 Repository。跨仓库工作拆成多个 Conversation / Run，由 Workspace 聚合。
- Device 与 Runtime capability 维持全局；不随 Workspace 复制，也不引入 RBAC 或团队多租户。

## Rationale

这个切分把“我正在处理哪组工作”与“代码实际在哪台机器的哪个目录”分离：Workspace 提供稳定的产品 scope，Repository / Mount 提供可验证的执行定位。Run 单仓库边界保留 worktree、审批与交付链的安全性，同时允许同一 Workspace 容纳前端、后端、基础设施等多个仓库。

## Alternatives

- **Workspace = Repository**：简单，但跨仓库项目会丢失统一的 Agents、Issues 与 Usage 视图，因此拒绝。
- **Agent 永久绑定 workdir**：延续旧模型，但会把逻辑角色与某台机器的 checkout 偶然绑定，因此迁移为可选默认 Repository。
- **单 Run 多写根**：能直接处理跨仓库修改，但会显著扩大权限、worktree、Review 与 Delivery 的一致性边界；当前用多个 Run 显式编排。
- **把 Workspace 当租户**：当前是个人平台，不需要 SSO/RBAC/成员关系，避免提前支付多租户复杂度。

## Consequences

- 旧库迁移到稳定的 `ws_personal`，旧 `workdir` 自动注册为 Repository + Device mount。
- REST / CLI / Web / 飞书必须显式解析 Workspace scope，并拒绝跨 Workspace 引用。
- Scheduler 必须验证 Agent Device 上存在目标 Repository mount，并把执行路径快照到 Run。
- 将来若引入跨仓库编排，应建立上层任务依赖，而不是放宽单 Run 的写根边界。
