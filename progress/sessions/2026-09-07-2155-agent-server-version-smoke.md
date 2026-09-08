# 2026-09-07 · Codex 版本识别与 Claude 文件审批复验

- `codex.ts` 将版本判定延后到 thread/start 或 thread/resume 响应，优先 `thread.cliVersion`，再解析任意客户端名的 userAgent。alignment 脚本使用独立的 `codex --version` 输出，不受影响。
- 版本矩阵在 start/resume 各覆盖 8 个场景；既有 mismatch fixture 改为权威 thread 版本不匹配。`bun run typecheck` exit 0；`cd packages/agent-server && bun test` 为 233 pass / 0 fail。
- 真 Claude 同一 thread 两轮，原生 init 确认 `claude-sonnet-5`；第二轮 fileChange accept 后在独立 `/tmp` cwd 创建文件，Bash ls 完成。探针首轮因读错完成状态字段退出，修正后 resume 同一原生 session，未增加 turn。路径守卫负例全部 reject。
- 证据：契约 `fj-as-fix3-f047` 的 `out/verified.json`、`claude-native.jsonl`、`claude-a.jsonl`、`typecheck.log`、`tests.log`（Trellis `.fenjue/tasks/`）。
- Next：交主控按契约独立验收；未 push，迁移与发布仍待用户决定。
