# agent-server 二审遗留收尾

- 契约 fj-as-polish2-b628：模式 P2-2～P2-6、输入 P2-1、打底 P2-1 分七次修复提交，基线 `7913839`。连按 Shift+Tab 丢弃计数单独显示；dontAsk 启动可回切；模型成功等待匹配 metadata 通知；非法 permission 简短提示；门禁使用可选 reason；审批粘贴保留主输入；codex permission/set 先报 backend_unsupported。
- 证据：`apps/agent-tui/src/modes-integration.test.ts` 的连续按键 PTY、dontAsk 与延迟/缺失 model 通知；`integration.test.ts` 的单字审批粘贴 PTY 和扫描期间粘贴；`options.test.ts` 的真实 bin 非法参数；`modes.test.ts` 的结构化字段反例；server `foundation.test.ts` 的后端优先级与门禁字段、`protocol.test.ts` 的新旧 error data 兼容。
- 验证：`bun run typecheck` exit 0；server 全量 265 pass / 0 fail；TUI 普通与 `env -i HOME=$HOME PATH=/usr/bin:/bin:$(dirname $(command -v bun))` 各 122 pass / 0 fail / 4 snapshots / 985 expect。
- 过程失败已解决：TUI 使用 server dist 导致新 reason 未加载，typecheck 构建后通过；审批粘贴 PTY 揭示渲染仍取 card.draft，改为仅问题卡取回答草稿；普通与并行启动的洁净环境首轮各一个旧审批输入快照失败，更新为展示主草稿后全量均通过。
- Next：交主控独立复跑验收；未 push，未启动真实 Claude/Codex。报告在契约 out/result.md，迁移 Goal 保持原状态。
