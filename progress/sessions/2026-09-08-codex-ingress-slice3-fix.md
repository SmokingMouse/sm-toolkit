# codex-ingress slice 3 混合后端复核返工

- 契约 fj-tui-ingress-slice3-fix-65a8；先合并 feat/codex-ingress（含 129f581），保留 slice 3 attached/history 与新的短租约语义。
- 默认加入 list_contains_both_backends；两种入口都加载 Codex 与显式 sonnet 的 Claude。真实 TUI picker 后同主连接四轮交替，校验 list 元数据、loaded UUID、两端审批及双向中断后另一端继续输入；原始 wire/PTY/summary 已归档至契约 out/proofs。
- TUI --model 会覆盖后续 resume，混合场景改用配置默认模型；跨后端显式模型覆盖仍拒绝。补同连接双审批未决、错误 turnId 拒绝和双向中断隔离单测。合并后 fresh prepare 与旧租约断言同步修正。
- 验证：521 pass / 0 fail / 3252 expect，typecheck exit 0；指定十判据 Codex 三轮 60.30/70.19/62.13 秒，Claude 三轮 90.29/101.59/87.35 秒，六轮 exit 0。默认判据双后端预跑也通过。
- 协议：docs/agent-server/protocol.md §13.2–13.3；详细 proof：/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-tui-ingress-slice3-fix-65a8/out/result.md。
- Next：主控独立复跑验收；本分支提交，不 push。
