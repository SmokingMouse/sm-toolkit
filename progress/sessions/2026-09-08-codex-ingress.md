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

## Claude 线程显示与交互（fj-tui-ingress-slice2-6772）

- 注入 sonnet/opus，Claude UUID 使用 AS 去前缀 ID；单向 Item/流式 delta、线程/turn 状态、历史分页和 settings 通知投影 native。交互仍走 as/1 队列、租约、model guard 和 broker；不支持的方法明确报错。
- 官方 schema 找到并修复 item/started、item/completed 漏必需时间戳的呈现缺陷；修复后真实 TUI 自动标题恢复。最终 508 pass / 0 fail / 3023 expect，typecheck exit 0；368 条合成样本与真实 native 帧/响应通过官方 0.153.4 experimental schema。
- 真实 Claude CLI 显式 sonnet，init 三次均确认 claude-sonnet-5；最终三连六判据全过（24.11 / 24.11 / 22.11s），包含 approval_roundtrip、resume_fresh_ok、真实流中 Esc。Codex 六项再过（8.91s），保留原 fixture 与自动标题判据。旧的缺时间戳三连归档到 out/pre-schema，不作为最终证据。
- 方案差异已上报主控：AS Claude generic permissions={toolName,input} 不符合 native network/fileSystem profile（schema 明确拒绝）；当前向 TUI 报错并保留 broker 待决，交 as/1 客户端或超时处理。live effort 标签仅 launch 生效，AS live 接口是 maxThinkingTokens，未擅自换算。native 问题无 multiSelect 字段，协议文档列明呈现限制。
- 证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-tui-ingress-slice2-6772/out/result.md`。Next：主控裁决上述协议差异并独立验收；不变更 Trellis Goals。未委派、未 push、未操作生产 daemon。

## slice 2 返工（fj-tui-ingress-slice2-fix-d5b8）

- 接手指定 stash；默认关闭的 claude_threads 开关贯通 daemon/listener/session/router，隔离冒烟按 backend 自动开启。
- 依主控三条投影裁决：通用工具权限改为 requestUserInput allow/deny，经原 permissions broker 决策；多选题改编号自由文本并还原 answers 数组；live effort 变更明确说明仅新建生效。
- P2：command_execution_output 检查真实 aggregatedOutput；缺失退出码保留 null 并入协议限制；线程回退闸与 Claude UUID 解析改主键查询。
- 最终全量测试 511 pass / 0 fail / 3066 expect、typecheck exit 0；契约原样命令 Claude/Codex 各 3/3 通过，Claude 三轮同时十项全绿（包含真实 Read 权限问答）。方案 slice 2 七项命令另跑一次通过。
- 冒烟探针修正：审批表 kind 实际为完整 method，原 permissions 简称查询漏报；改成 item/permissions/requestApproval 后真实 Read 审计可证（/tmp/ingress-fix-claude-all.json）。
- 证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-tui-ingress-slice2-fix-d5b8/out/result.md` 及 read-permission-proof.json、双方 runs.json、bun-test.log、typecheck.log。
- Next：交主控独立复跑验收；Trellis Goals 不变，未 push、未委派、未操作生产 daemon。

## 输入租约返工（fj-tui-ingress-lease-fix-400a）

- 按主控裁决去掉 guardThread 的 full 自动租约；live resume 走 attach，冷恢复和普通输入省略与当前相同的 permission override。AS 输入门控保留，权限设置升 full 仅持十秒短租约，成功/失败均 finally 释放；重复权限不重设。CodexSession 既有 disconnect 清理沿用。
- AS close 去掉输入租约检查并保留关闭后清租约；interrupt 本来已不检查。回归验证跨客户端生命周期操作、full 冷/热恢复无租约与零审批行、升权调用期间持锁且成功/失败后释放、他端输入仍被 -32012 拒绝。
- 冒烟新增 external_client_reply_while_attached_ok：官方 TUI full resume 后持续附着，独立 Python as/1 Unix 客户端完成 reply 与 close，SQLite 确认指定 turn completed 和 thread closed。Codex fixture 修复固定 item ID 不能用于第二轮的问题。
- 验证：agent-server 全量 514 pass / 0 fail / 3117 expect，typecheck exit 0；Codex 与真实 Claude sonnet 最终各三次七判据通过。原 fixture 失败保留在 failures.md 与契约 codex-1.log，不计最终证据。
- 证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-tui-ingress-lease-fix-400a/out/result.md`、runs.json、六组 wire/external-as1/summary。Next：主控独立验收；Trellis Goals 不变，未 push、未委派、未操作生产 daemon。
