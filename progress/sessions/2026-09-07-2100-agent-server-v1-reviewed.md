# 2026-09-07 21:00 · agent-server v1 实现完成，两轮异源 review 通过

## 交付（分支 feat/agent-server，未 push）
- `packages/agent-server`：AS Protocol v1（zod + JSON schema 导出，`initialize` 能力协商，strictObject 拒未知字段）；core：ThreadManager（engineThreadId→活进程登记，resume 命中即 attach）、ItemLog（sqlite，seq 与 completedSeq 双游标，先落库再广播）、TurnQueue（一 thread 一轮、FIFO、steer/interrupt/cancel、引擎死亡冻结）、ApprovalBroker（广播竞答、resolved/expired、orphan 超时）、LeaseManager；engines：mock / claude（Agent SDK 常驻 stream-json）/ codex（app-server 协议，假 app-server 回放测试，未知 item 降级 + -32015）；transport：NDJSON unix socket + WebSocket（Origin 白名单、token）；client 库（自动重连、sinceSeq 补齐）；daemon（start/stop/status、0600 token/db、优雅关闭）；`scripts/check-codex-alignment.ts`（锁 codex 0.153.4 schema，四种漂移变红）。
- `apps/agent-tui`：薄客户端（attach 流式渲染、输入/排队/steer、审批与提问卡、他端先答撤卡、Herdr 内 pane.report_agent* 注册与 OSC 状态）。
- 测试：agent-server 与 tui 全绿，HOME=/tmp 下 hermetic。

## review
- 第一轮（opus）需返工 12 条：安全（thread/start.env 可覆盖 PATH/ANTHROPIC_*）、attach 游标丢断线正文、codex 对齐脚本缺席且未知 item 拆 thread、attach limit 被吞、测试非 hermetic、db 0644、WS 无 Origin、resume 无 cwd、孤立帧拆 thread、无 threadId error 丢弃。
- 返工（gpt-6-astra）后第二轮：**通过**，原探针全部反转；留 N1 低危自愈（trellis 仓 backlog 有记录）。

## Next（等用户）
- Trellis 迁移三步走（docs/agent-server/trellis-migration.md）是否开工；是否发布 @smokingmouse/agent-server 与 agent-tui；是否把 fj 起位默认改为 agent-tui。

## 追记 21:10
- as-fix2：N1 已修（mapper 无 turnId 时省略字段、引擎非 active 时早到 tool_result 降级为不带 turnId 的 error、client 畸形通知只丢弃不断线；probe12/13 转单测）。server 217 / TUI 23 全绿，HOME=/tmp hermetic。分支到此无已知缺陷。
