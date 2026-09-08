# Codex native ingress 首个切片

- 契约 fj-tui-ingress-slice1-9065，基线 b45cc7c，分支 feat/codex-ingress。
- 独立 loopback WS / bearer upgrade / 128 MiB，codex_ingress.enabled 默认关闭；每 TUI 一个 AS client，另有无 thread 的 control 进程。生命周期经 as/1，native 通知与启动响应保留，四类审批由 broker 仲裁并记 codex-tui: label。
- CodexEngine 只新增只读 native 响应观察与历史读取；持久 engine UUID 索引承担路由。为真实恢复补齐 owning-process thread/items/list / thread/turns/list；返工补齐 AS thread/name/set，标题持久化并投影 native read/list/resume/通知。
- 主控复跑揭露旧冒烟时序依赖：改为完成渲染后 /quit，恢复轮按消息标记选择始终挂起的 SSE，匹配 interrupt 请求、成功响应和 interrupted 终态后才释放。无活动 interrupt 错误与官方 0.153.4 源码及隔离实测对齐；旧单次通过证据已由返工替代。
- 验证：agent-server 全量 482 pass / 0 fail；bun run typecheck exit 0；官方 codex-cli 0.153.4 PTY 连续五次五项全过（thread_started、turn_completed、approval_roundtrip、resume_ok、interrupt_ok），附命名落库断言。模型端为本地 Responses fixture，TUI、app-server、daemon、SQLite broker 均为真实实现，HOME/socket/DB 全隔离；证据契约 out/rework-smoke-1..5。
- 原始证据与偏离说明：契约 out/result.md、wire.ndjson、summary.json；协议文档 §13。
- Next：交主控独立验收；Trellis Goal 不变，Claude 线程、完整多线程操作和 Unix WebSocket 留后续切片。未 push、未委派、未操作生产 daemon。
