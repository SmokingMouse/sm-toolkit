# Failures

## 待查

无。

## 已结案

### codex-ingress slice 3 再审：启动模型覆盖与权限卡 schema（resolved）

- 症状：TUI `--model sonnet` 切到 Codex 线程被拒绝；Claude Read 权限卡缺官方 schema 必填 isBlocking。
- 可证伪假设：guardThread 将 TUI 粘性默认模型当作引擎切换；权限卡自造 params 漏字段，旧 schema 校验未覆盖全部 serverRequest。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend claude`（默认含 cross_backend_model_override_tolerated 与 wire_schema_clean）。
- 修复：已有线程忽略跨后端模型 override 并发带 threadId 的可见 warning，同后端校验保留；权限卡补 isBlocking=true，所有出站帧过新生成官方 schema，缺映射也失败。本条取代下条「不传 --model」规避方式，该规避未满足原契约。

### codex-ingress slice 4：Unix 路径过长与重连初始化竞态（resolved）

- 症状：macOS 默认 TMPDIR 下隔离 CODEX_HOME 的 Unix socket 超过 sun_path；新增显示端崩溃冒烟在重连后立即 close，迟到的 TUI 初始化 read 又恢复线程。
- 可证伪假设：失败取决于临时目录长度与 close 前是否等到重连历史显示，而非断连导致引擎中断。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex --transport unix --expect display_disconnect_ok,external_client_reply_while_attached_ok`。
- 修复：临时目录固定在 /tmp 下并检查 socket 字节上限；重连先等待离线完成历史在官方 TUI 渲染，再验 close。Codex unix / Claude ws 均已通过；进行中的 turn 经 TUI SIGKILL 仍完成。

### codex-ingress slice 3 返工：混合 picker 的模型与准备状态（resolved）

- 症状：Claude 主会话切 Codex 被 changing backend guard 拒绝；合并后的 fresh 关闭/重开与旧 full 租约断言不兼容；对当前线程重复 /resume 不发新 resume RPC。
- 可证伪假设：TUI 启动 --model 是后续 resume 的粘性覆盖；fresh 仍带 full 或显式向 Claude 传 sandbox；脚本把当前选择当成新选择。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend claude`；wire 中跨后端 resume 必须 model=null，双线程轮流完成且各自审批/中断可核验。
- 修复：用配置默认模型和显式 sonnet 建线程，保留跨后端模型 override 拒绝；fresh 在关闭前命名、关闭后停旧 PTY，再以 auto-edit 重开（仅 Codex 传 sandbox）；跟踪真实 resume/turn 选择。旧租约测试改为普通 full 输入不占租约，与 129f581 一致。

### codex-ingress slice 3：分页错误被包装为引擎不可用（resolved）

- 症状：真实 0.153.4 的无效 items cursor 原本返回 -32600，ingress 返回 -32004，并附引擎 stderr；活进程被错误描述为 unavailable。
- 可证伪假设：CodexEngine 的统一 AS 错误包装遮住了只读 native RPC 的 code/message。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex`；history-proof.json 中 invalid cursor 断言必须严格等于 -32600 与上游原文。
- 修复：nativeResult 解包 read/history 原始错误，保留 code/message/data；Claude 无效 opaque cursor 同样使用 -32600。223 项、双向 28 页、空页、resume 与中间 fork 的真实探针已通过。

### codex-ingress slice 3：picker 搜索被误认为必发 RPC（resolved）

- 症状：首轮扩展冒烟在 picker search 超时，真实屏幕已经筛出 S3-FRESH。
- 可证伪假设：官方 picker 优先本地过滤已取回的行，只有需要更多页时才再请求 thread/list。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex`；要求真实 picker 列出目标后选择，随后主连接发匹配 UUID 的 resume/turn。
- 修复：不等待不存在的搜索 RPC；以选中后的 resume 和对应线程 turn 为判据。picker 自己另开的列表连接不计入主连接的 turn/start 同连接断言。

### codex-ingress：full 附着长期占用输入租约（resolved）

- 症状：TUI full resume 后独立 as/1 reply / close 返回 -32012；扩展冒烟首轮另发现 Responses fixture 重复 msg_fresh 导致 items 唯一键冲突。
- 可证伪假设：guardThread 把 full 权限等同于每次取默认五分钟输入租约；AS close 也误用输入门控。fixture 固定 item ID 无法覆盖同线程第二轮。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex --expect external_client_reply_while_attached_ok`。
- 修复：full resume/普通输入不取租约，重复权限省略 override；仅 permission/set 升权持十秒短租约并在 finally 释放；close 与 interrupt 均不检查输入租约。fixture 逐响应唯一 ID，并对不可重试执行错误立即失败。
- 证据：fj-tui-ingress-lease-fix-400a/out/result.md、codex-1.log（原失败）、final-codex-1..3.log（修复后）；单测同时覆盖他人持租约时输入仍拒绝。

### codex-ingress：主控复跑揭露恢复冒烟时序依赖（resolved）

- 症状：初次自跑通过，但主控连续两次复跑 resume_ok/interrupt_ok=false；迟到的具名 turn/interrupt 被 ingress 自造 -32011 拒绝，thread/name/set 未实现。
- 可证伪假设：Ctrl-C 退出会在 TUI 尚未消费完成通知时发出旧 interrupt；模型请求次数无法可靠标识恢复轮，立即结束的响应无法保证 Esc 到达时仍在执行。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex --expect thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok` 连续五次。
- 修复：等待实际完成文本再 /quit；恢复用户消息携唯一标记，模型返回保持打开的 SSE，直到匹配的 interrupt 请求、成功响应和 interrupted 终态齐备才释放。普通 RPC 错误不能被完成判据掩盖。
- 官方 0.153.4 隔离探针：空 turnId 无活动时返回 {}；具名返回 -32600、no active turn to interrupt。桥接保留上游错误，命名经 AS 标题持久化且受租约/根目录检查；证据契约 out/upstream-interrupt-probe.json 与 rework-smoke-1..5。

### codex-ingress：真实 TUI 冷启动、恢复与审批时序（resolved）

- 症状：初版 PTY 未提交文本、审批快捷键落入输入框；native 默认 collaborationMode 被拒，恢复缺少原生 thread/items/list。
- 可证伪假设：快速文本后立刻 CR 被视为粘贴；官方审批有一秒输入静默延迟；当前 TUI 的默认模式和分页属于真实生命周期依赖。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex --expect thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok`。
- 修复：bracketed paste 后独立 Enter，审批前等两秒；default collaboration model/effort 经 AS 校验，历史分页只读转 owning 进程。五项全过，证据 fj-tui-ingress-slice1-9065/out/result.md。
- 额外实测：0.153.4 配置文件已拒绝 approval_policy=untrusted，冒烟改用 on-request + 显式 require_escalated；初版拒绝 name/set/goal/get，返工后 name/set 已实现，旧单次通过不代表稳定性，见上条主控复跑记录。

### midfork：无坐标原生 tip fork 的并发追加竞态（resolved）

- 症状：审查发现 AS 先捕获前缀、原生稍后加载 tip，期间源追加可能进入引擎上下文而不在复制日志中。
- 可证伪假设：无 UUID/turnId 坐标的原生 tip 加载无法约束到请求时刻。
- 判定命令：`bun test packages/agent-server/src/core/fork.test.ts`（idle tip without native coordinate）。
- 修复：只有精确原生坐标才走原生 fork，其他边界播种冻结快照；定向 core 25 pass。
- 全量 TUI 首次复跑 121 pass / 1 fail：旧 PTY 断言空 thread 必走 native fork；改为验证空播种、null lineage 和独立 engine ID，保留原会话未关闭断言。原失败日志：同契约 out/agent-tui-tests-before-tip-assertion.log。

### midfork：播种分支恢复覆盖 spawning 状态（resolved）

- 症状：关闭后首次恢复 seeded Claude 报 `invalid thread transition closed -> idle`。
- 可证伪假设：清空未持久化 engineThreadId 时，把旧 closed 对象写回覆盖了 spawning。
- 判定命令：`bun test packages/agent-server/src/core/fork.test.ts`。
- 修复：先清空身份，再转换 spawning；复跑 8 pass，关闭前后 prefix 与后续 native resume 均验证。

### observe 集成：旧 PTY 契约与统一租约测试接口不匹配（resolved）

- 症状：首轮全量 112 pass / 4 fail；观测 PTY 等待完整 thread id 超时，提示文案不匹配；随后发现部分帧到达就断言导致 unknown_future 缺失。定向单测还暴露 session 假 client 缺少租约回调、原审批竞态在持锁后无法发生。
- 可证伪假设：第一步短 id / 命令补全 / 多行布局与 observe 原测试前提不同；主控裁决后的统一租约禁止获锁后让另一端抢答，需要在 acquire 前制造竞态。
- 判定命令：`cd apps/agent-tui && bun test`；原始失败见 fj-as-integrate2b-ff47/out/tui-tests-first.log、integration-fixed.log。
- 修复：PTY 等待短 id、首帧及必要的完整帧末尾；无参命令加空格遵循补全规则；补齐假 client 的租约回调和审批确认；竞态移到 acquire 前且保留不误切模式断言。产品漏合的审批确认 footer 恢复，普通输入与 Ctrl-C 不等待在途审批。完整普通与 clean-env 均 116 pass / 0 fail，未减少用例或降低断言、性能阈值。

### D3：Herdr 标题被误判为 TUI 输入就绪（resolved）

- 症状：`apps/agent-tui/src/daemon-pty.test.ts` 偶发 `prompt reached engine` 超时；修前完整测试第 3 次复跑 exit 1（86 pass / 1 fail）。日志先出现 OSC thread id 和终端回显，后出现首帧，输入最终多出换行而未发送。
- 可证伪假设：测试匹配的 thread id 来自 `startHerdr` 提前输出的 OSC 标题，早于 `runTerminal` 设置 raw 模式。此时 CR 被 PTY 转成 LF，TerminalInput 按预期把 LF 解释为 Ctrl-J 换行。
- 判定命令：`cd apps/agent-tui && bun test src/daemon-pty.test.ts`；修前完整证据 `/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-as-integrate2-02a2/out/d3-recheck-3.log`。
- 修复：只改测试等待真实首帧（CSI H）和完整输入行；不再把 OSC 标题当作就绪信号。产品语义和原有用例/断言保留。定向连续 10 次 exit 0，typecheck exit 0；完整复跑见同契约 result.md。
