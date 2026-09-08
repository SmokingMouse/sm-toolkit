# Failures

## 待查

无。

## 已结案

### codex-ingress：真实 TUI 冷启动、恢复与审批时序（resolved）

- 症状：初版 PTY 未提交文本、审批快捷键落入输入框；native 默认 collaborationMode 被拒，恢复缺少原生 thread/items/list。
- 可证伪假设：快速文本后立刻 CR 被视为粘贴；官方审批有一秒输入静默延迟；当前 TUI 的默认模式和分页属于真实生命周期依赖。
- 判定命令：`python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex --expect thread_started,turn_completed,approval_roundtrip,resume_ok,interrupt_ok`。
- 修复：bracketed paste 后独立 Enter，审批前等两秒；default collaboration model/effort 经 AS 校验，历史分页只读转 owning 进程。五项全过，证据 fj-tui-ingress-slice1-9065/out/result.md。
- 额外实测：0.153.4 配置文件已拒绝 approval_policy=untrusted，冒烟改用 on-request + 显式 require_escalated；TUI 自动 thread/name/set / thread/goal/get 属于明确不支持的可选操作，保留错误，不伪成功。

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
