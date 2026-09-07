# Failures

## 待查

无。

## 已结案

### D3：Herdr 标题被误判为 TUI 输入就绪（resolved）

- 症状：`apps/agent-tui/src/daemon-pty.test.ts` 偶发 `prompt reached engine` 超时；修前完整测试第 3 次复跑 exit 1（86 pass / 1 fail）。日志先出现 OSC thread id 和终端回显，后出现首帧，输入最终多出换行而未发送。
- 可证伪假设：测试匹配的 thread id 来自 `startHerdr` 提前输出的 OSC 标题，早于 `runTerminal` 设置 raw 模式。此时 CR 被 PTY 转成 LF，TerminalInput 按预期把 LF 解释为 Ctrl-J 换行。
- 判定命令：`cd apps/agent-tui && bun test src/daemon-pty.test.ts`；修前完整证据 `/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-as-integrate2-02a2/out/d3-recheck-3.log`。
- 修复：只改测试等待真实首帧（CSI H）和完整输入行；不再把 OSC 标题当作就绪信号。产品语义和原有用例/断言保留。定向连续 10 次 exit 0，typecheck exit 0；完整复跑见同契约 result.md。
