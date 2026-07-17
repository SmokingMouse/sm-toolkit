# Harbor Workspace Scope

## Current Focus

实现已完成并通过测试：Workspace 是 Harbor 的一级逻辑作用域；Repository 是可跨 Device 挂载的执行资源；Run 保持单仓库执行。

## Contract

- 结果：Workspace 隔离 Agents / Skills / Issues / Chats / Automations / Settings / Usage；Repository 可在不同 Device 上配置 mount；Run 以 Agent + Repository mount 执行。
- 验证：SQLite 旧库迁移保数据；REST 隔离和跨 Workspace 拒绝测试；Harbor / Web typecheck、build、浏览器关键路径通过。
- 约束：Device 与 Runtime capability 保持全局；一个 Run 只写一个 Repository；不引入 RBAC、多租户或单 Run 多写根。
- 兼容：既有数据迁入 Personal Workspace；旧 `--workdir` CLI 自动注册 Repository + mount。
- Pause if：旧数据无法无损映射，或跨仓库单 Run 成为硬依赖。

## Log

- 2026-07-17：创建 `codex/harbor-workspaces` worktree，并同步当前未提交 Harbor 基线；主工作区未修改。
- 2026-07-17：新增 v9 schema 与旧库迁移。既有 Agent / Skill / Conversation / Run / Automation / prompt settings 迁入稳定的 `ws_personal`；旧 Agent `workdir` 自动转换为 Repository + Device mount。
- 2026-07-17：REST / CLI / Web 全面传递 `X-Harbor-Workspace`；Agents、Skills、Issues/Chats、Automations、prompt settings、Usage 按 Workspace 隔离，Devices 与 Runtime capabilities 维持全局。
- 2026-07-17：新增 Repositories 主从页、Workspace switcher，以及 Agent / Issue / Chat / Automation 的 Repository 选择；只展示 Agent 所在 Device 已挂载的 Repository。
- 2026-07-17：Scheduler 将 workspace / repository / mount / execution root 快照进 Run；worktree 绑定创建它的 mount，禁止跨 Device / Repository 误用；mount 被 Run、worktree、Agent 或活跃任务引用时禁止删除。
- 2026-07-17：Feishu Agent 引用支持 `workspace/agent`，同名 Agent 不再造成不可选；旧 CLI `--workdir` 保持兼容。
- 2026-07-17：验证通过：根 `tsc --build`；Harbor 26 tests / 154 expects；Harbor Web production build；临时数据库真实浏览器验收 Workspace 创建/切换、Repository mount、Agent 默认 Repository、Issue 自动选仓库与 Run mount 快照。视觉验收把侧栏固定文案改成当前 Workspace slug。

## Decisions

- Workspace 是 scope，不是 Repository、目录、Device 或租户；可以零仓库，也可以包含多个仓库。
- Agent 永久属于一个 Workspace 与一个 Device，但不永久绑定 cwd；`defaultRepositoryId` 仅是任务默认值。
- Repository 是逻辑代码资源；RepositoryMount 表示它在某台 Device 上的 checkout 路径。
- Conversation 属于 Workspace，可选一个 Repository；Run 只写一个 Repository，并冻结具体 mount / execution root。
- 跨仓库工作拆成多个 Issue / Run，通过 Workspace 聚合，不引入一个 Run 多写根。

## Next

- 合入主工作区后，由集成者把本块决策同步到共享 `progress/README.md` / `progress/harbor.md` / glossary 并归档本块。
- 用真实双机 checkout 为同一 Repository 配置两个 mount，完成一次跨 Device 的 dogfood。
