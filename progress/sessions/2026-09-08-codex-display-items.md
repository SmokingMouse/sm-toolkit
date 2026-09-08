# Codex 显示项映射补齐

- 契约：fj-codex-mapper-display-items-aa07。按 0.153.4 schema 补 sleep、imageView、hookPrompt、enteredReviewMode、exitedReviewMode 为现有 toolCall；保留未来未知类型 fallback，未改 AS 协议或 ingress。
- 测试：五类 started/completed 精确断言与 payload 校验；从版本指针递归抽取全部 19 类 ThreadItemType，两个生命周期全部映射。Codex 测试 70 pass；agent-server 1215 pass；typecheck 与标准 codex remote smoke exit 0，wire schema clean。
- 真实验证：隔离 daemon 使用本 worktree 与已有登录/token，显式 gpt-6-astra/full；原生 sleep started/completed 映射为 completed clock.sleep，后台 sleep 5 exit 0、最终 done、PTY 无 Unknown 红条；所有五个自建线程均 close。
- 验收限制：常驻 daemon 加载旧 dist 且契约禁止部署/重启；Codex ingress 透传原生项，官方 TUI 未显示 clock.sleep 名称。已上报主控，未扩范围修改 ingress。Sol 两次使用其他等待工具，无原生 sleep，未计作通过。
- 证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-codex-mapper-display-items-aa07/out/result.md`，真实 PTY 与事件在其 `real-run-27kbzyim/`。
- Next：主控裁定两项验证差异并独立验收；本分支不 push、不 PR、不部署、不重启 daemon。
