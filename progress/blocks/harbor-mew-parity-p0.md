# Harbor Mew Parity P0

## Current Focus

Mew parity P0 已完成：Automation 是一等 Run Source，schedule/manual/webhook、输出模式和 overlap 语义已贯通协议、DB、调度、REST/CLI 与 Web。

## Scope

- Run 持久化真实 source type/id，不再从 Conversation origin 反推。
- Automation 支持 schedule/manual/webhook trigger，并保存规范化 event context。
- Automation 支持直接 Run 与 Chat 输出；旧 `new_issue`/`append` 数据无损迁移。
- overlap 支持 `skip`/`queue`，触发与跳过均可审计。
- 禁止改动主工作区 `progress/README.md`、`progress/glossary.md` 和既有共享 ADR。

## Acceptance

- 旧数据库迁移后既有 Issue/Chat/Automation/Run 行为不回归。
- webhook secret 校验、event filter、重复事件幂等和 overlap 均有测试。
- schedule/manual/webhook 三类 prompt event 持久化且 dispatch 正确。
- Harbor 后端测试、根 TypeScript build、Web typecheck/build 通过。

## Log

- 2026-07-19：从 `df31183` 建立独立 worktree/branch `harbor-mew-parity-p0`，开始领域审计。
- 2026-07-19：SQLite v12 将 Run 收敛为恰好一个 `sourceType/sourceId`；Issue/Chat 继续关联 Conversation，Automation 直跑不创建伪 Issue。旧 `new_issue/append` 无损迁为 `issue/append`。
- 2026-07-19：Automation Trigger 独立为 1:N `schedule/webhook`，manual 为固有入口；Webhook 使用独立一次性 secret（仅存 SHA-256）、event allowlist、OR filter、delivery 去重和 256KB 输入闸。
- 2026-07-19：输出支持 `run/chat/issue/append`，overlap 支持 `skip/queue`；queue 通过 Run `concurrencyKey` 真正串行下发，不只是允许多建 queued Run。
- 2026-07-19：新增 webhook Prompt block 与低信任 payload 边界；Automation Run 在 approval、飞书结果回报、Usage/Run API 中不再依赖 Conversation。
- 2026-07-19：管理端可创建 Schedule/Webhook、选择输出与 overlap，Webhook secret 只显示一次；CLI 同步升级。
- **Verified**：根 `bun test` 82 tests / 454 assertions ✓；根 TypeScript build ✓；Harbor Web production build（12 static pages）✓；`git diff --check` ✓；agent-browser 真实创建 Codebase webhook，确认列表 `codebase:webhook / run / queue`、一次性 secret 面板与 390px 无横向溢出。

## Next

P1 接真实 Codebase Provider：仓库映射、MR/CI/review/merge 事件规范化、Delivery 同步和 Builders 风格 Issue 状态对账 Automation。
