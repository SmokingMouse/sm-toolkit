# Mew Prompt Workflows

## Current Focus

Mew 式 `session context + event trigger` Prompt pipeline 已实现并验证，等待 review / merge。

## Log

- 2026-07-17：只读实测 Mew Prompts 页面与线上 bundle，确认 8 个可见 block：Issue context/assigned/mentioned/message、Chat context/message、Automation schedule/manual；另有 UI 隐藏的 webhook block。
- 2026-07-17：领域拆分为 Prompt block、Run prompt event、Run purpose；开始实现 SQLite v9、两段式 renderer 与旧 wrapper 兼容迁移。
- 2026-07-17：完成 8-block Settings、dispatch 时 context + event 组合、Automation `run now` 与 trigger ref 持久化；旧 wrapper 迁移保持原语义。
- 2026-07-17：Harbor server 19/19 测试、根 TypeScript build、Web production build 通过；真实浏览器完成桌面与 390px Settings 验收。

## Decisions

- `Run purpose` 表示执行意图（implementation/review/triage），`promptEvent` 表示触发原因；二者正交并持久化。
- Issue/Chat 组合 context + event；Automation 只有 schedule/manual event。event block 被禁用时透传原始请求，永不丢 prompt。
- 旧 issue/chat 自定义 wrapper 迁到 context；只要仍含 request 变量就按旧合并模板单独渲染，reset 后自然切到新 pipeline。
- `triggerRef` 落在 Run 上，避免 append-mode Automation 复用旧 Conversation 时丢失当前 Automation ID。

## Next

- Review 后合并 `codex/mew-prompt-workflows`；如要继续追 Mew，可再单独研究其隐藏 webhook trigger 与附件变量。
