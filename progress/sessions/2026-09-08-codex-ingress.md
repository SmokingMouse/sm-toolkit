# Codex native ingress 首个切片

- 契约 fj-tui-ingress-slice1-9065，基线 b45cc7c，分支 feat/codex-ingress。
- 独立 loopback WS / bearer upgrade / 128 MiB，codex_ingress.enabled 默认关闭；每 TUI 一个 AS client，另有无 thread 的 control 进程。生命周期经 as/1，native 通知与启动响应保留，四类审批由 broker 仲裁并记 codex-tui: label。
- CodexEngine 只新增只读 native 响应观察与历史读取；持久 engine UUID 索引承担路由。为真实恢复补齐 owning-process thread/items/list / thread/turns/list；返工补齐 AS thread/name/set，标题持久化并投影 native read/list/resume/通知。
- 主控复跑揭露旧冒烟时序依赖：改为完成渲染后 /quit，恢复轮按消息标记选择始终挂起的 SSE，匹配 interrupt 请求、成功响应和 interrupted 终态后才释放。无活动 interrupt 错误与官方 0.153.4 源码及隔离实测对齐；旧单次通过证据已由返工替代。
- 验证：agent-server 全量 482 pass / 0 fail；bun run typecheck exit 0；官方 codex-cli 0.153.4 PTY 连续五次五项全过（thread_started、turn_completed、approval_roundtrip、resume_ok、interrupt_ok），附命名落库断言。模型端为本地 Responses fixture，TUI、app-server、daemon、SQLite broker 均为真实实现，HOME/socket/DB 全隔离；证据契约 out/rework-smoke-1..5。
- 原始证据与偏离说明：契约 out/result.md、wire.ndjson、summary.json；协议文档 §13。
- Next：交主控独立验收；Trellis Goal 不变，Claude 线程、完整多线程操作和 Unix WebSocket 留后续切片。未 push、未委派、未操作生产 daemon。

## 零 turn 恢复返工（fj-tui-ingress-slice1-fix-cf4c）

- 复核 P1：旧冒烟只覆盖已有 turn 的恢复；0.153.4 新线程未物化时，完整 read / turns list / items list 报 Unsupported。现在只对本引擎新建且从未派发 turn 的线程识别精确原生错误，返回完整空页（含 backwardsCursor）；导入线程、坏 cursor、派发后的错误和其他读失败仍报错。
- resume 遵守 excludeTurns，补 initialTurnsPage 与两个原生 backwards cursor；非空历史及 cursor 原样转交 owning app-server。P2-1：具名中断在 native ack 前等待绑定再比 ID，避免错误中断另一个 turn。
- 新冒烟先由 as/1 建零 turn 线程，官方 TUI resume 后发送首轮、收到匹配完成通知并渲染响应；resume_fresh_ok 纳入默认六判据。最终全量 487 pass / 0 fail，typecheck exit 0，连续五次六项通过。真实三轮分页 193 断言通过；140 条读/恢复/分页响应通过官方 0.153.4 生成 schema 校验。
- 原 41 项探针逐项比基线零回归，唯一变化是 P1 false→true。probe1 仍有原报告已知的两项失败，修正 fixture 的 probe2 全过；readonly 审计缺口、既有 name/set 方法净增与无 AS 活动 turn 的保守拒绝均逐条记录在 result，未伪造审计或绕过 as/1 治理。
- 证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-tui-ingress-slice1-fix-cf4c/out/result.md`。Next：交主控独立复验；不变更 Trellis Goals。
