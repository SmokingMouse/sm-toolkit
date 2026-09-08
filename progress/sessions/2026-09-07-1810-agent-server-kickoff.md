# 2026-09-07 18:10 · agent-server 立项与设计定稿

## 背景
用户拍板：参考 codex app-server，把 sm-toolkit 从「库」升级为「本机 daemon + 薄前端」：daemon 独占每个 thread 的引擎子进程（Claude 走 Agent SDK 双向 stream-json，codex 走 app-server 协议），引擎事件落成 item 日志广播，turn 排队，审批与提问是服务发给客户端的反向请求，多前端（Trellis 网页、手机、飞书、TUI）attach 同一份日志。动机：解决同一会话多前端同时使用与渲染、手机审批、会话不随网页进程死亡。

## 已交付
- 设计文档（opus 坐席，3 commit）：`docs/agent-server/README.md`（目标/非目标/架构/生命周期/持久化/安全/路线）、`protocol.md`（AS Protocol v1：JSON-RPC 2.0 + NDJSON，initialize 能力协商，thread/turn/item 方法与通知，四个反向请求，竞答与租约，错误码 -32001…-32015，幂等键，seq 重放，队列语义，与 codex v2 的 12 条差异）、`trellis-migration.md`。
- §12 未定项按倾向执行：fork 缺省走原生 --fork-session；finalStart 不进协议；用量复用 Cost（usd 可空）。

## 进行中
- as-core（codex gpt-6-astra）：packages/agent-server 协议 zod、ThreadManager、ItemLog(sqlite)、TurnQueue、ApprovalBroker、MockEngine/ClaudeEngine、进程内 Server、单测。
- 后续：as-transport（unix socket + ws + daemon）与 as-codex-engine 并行 → as-tui → as-review → Trellis 迁移（另一仓）。

## Next
- 核心交付后派传输与 codex 引擎；TUI 在 Herdr 内用 pane.report_agent_session 报会话。
- 由 trellis 仓的 leader（Herdr workspace w4）统一编排，契约与归档在 trellis/.fenjue。
