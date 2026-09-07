# 2026-09-08 · fj-as-integrate2-02a2 整合验证

- 从 `6b0f179` 依次 merge `feat/as-foundation`（`1b168c9`）、`feat/tui-sessions`（`484edf2`）、`feat/tui-input`（`8be0cc1`）、`feat/tui-modes`（`834d2a0`），保留全部分支历史；未合 observe。
- 整合控制器、终端分帧、会话选择器、多行/附件布局、模式栏与命令补全。补全普通 Tab/Enter 优先，空闲 Tab effort、Shift-Tab 权限、Ctrl-R reasoning。会话 RPC 不阻塞按键保护；本端启动资格及租约显示按 thread 隔离，断线清所有租约显示。
- 验证：typecheck exit 0；server 263 pass；TUI 普通和指定 env -i 均 87 pass、0 fail、4 snapshots；Codex 0.153.4 对齐 32 项。跨特性回归覆盖权限资格/租约隔离、Tab 优先级、多行附件下会话滚动。
- 真实引擎：Sonnet 显式 sonnet（原生 claude-sonnet-5），同一 thread 3 turn，plan → 持 lease 切 acceptEdits，hook engineEvent；gpt-6-astra 同一 thread 1 turn，原生 thread/start 与 turn/start 均 default tier，收到 engineEvent。
- 失败与修复：首轮测试仍断言完整 id、隐藏 permission、旧命令直接 Enter，按合并后的短 id、foundation 权限和补全行为调整；串行终端队列曾延迟本应丢弃的会话操作按键，已修。首次图片 fixture 被原生处理器移除，不能凭 completed 判通过；同一 AS/native thread 第 3 turn 换有效 RGB PNG 返回 Red。帧验收命令：`bun /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-as-integrate2-02a2/out/verify-smoke.ts`。
- 证据：契约 out/result.md、smoke-proof.json、*-frames.jsonl、*-native.jsonl、测试日志；MockEngine 保持原分支测试实现，生产默认工厂仍只创建 Claude/Codex。
- Next：主控独立验收本分支；不 push、不动 main。observe 另单，Trellis 迁移与发布待用户决定。
