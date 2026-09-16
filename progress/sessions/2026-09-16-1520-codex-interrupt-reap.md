# 2026-09-16 15:20 · Codex interrupt 命令子进程收割上线（由 trellis leader 编队，PR #19）

## 做了什么
- 根因：codex app-server 0.153.4 exec 走 `/bin/zsh -lc`，interrupt 只杀 zsh，孙进程重挂 PID 1 跑满；AS 侧 mapper 记账修不了（独立复核证伪两轮）。
- 修：interrupt 前快照 codex 后代 pid（减 turn 前 baseline），ack 后 SIGTERM→2s→SIGKILL；codex 子进程 detached 自成进程组，close / fail / 关停 `kill(-pgid)`；真进程树集成测试 `codex-interrupt-reap.test.ts` + 迟到 delta 回归。1227 测试绿，Sonnet 复核 pass（同源）。
- 常驻 daemon 重启（pid 33157，库备份 `~/.agent-server/backups/20260916T151624.db`）。

## 决定
- [decision] 不用 GPT 做真机验收（cpa codex 号池 503 auth_unavailable，用户裁决）；真机脚本留在 trellis `.fenjue/briefs/cxint-harness/`，网关恢复后补跑。

## Next
网关恢复后跑 `run.sh A|C|D` 补修后真机证据；Linux 环境补跑集成测试；`close()` 二次 killGroup 的 pid 复用窗口写进 docs。
