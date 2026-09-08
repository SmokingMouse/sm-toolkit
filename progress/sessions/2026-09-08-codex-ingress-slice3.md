# codex-ingress slice 3

- 契约 fj-tui-ingress-slice3-d89c，分支 feat/codex-ingress-s3，基于 af3e07a。
- AS 全库列表分页、loaded UUID 分页；Codex 原生元数据在 engine metadata 事件中持久化，覆盖 as/1 创建的线程。
- 双后端 fork 走 AS；Codex turn 中间边界保留有界 seed 与原生展示前缀。历史默认值、摘要、反向锚点、excludeTurns 与 0.153.4 对齐。
- 同 token 接管断开订阅；AS 负责 pending 重发和租约释放，离线已决请求补 resolved。显式 detach 不恢复，不关线程进程。
- 验证：agent-server 517 pass / 0 fail，typecheck exit 0；双后端各连续三次九判据全过。Codex 每次 223 项、双向 28 页、中间 fork 及新 turn 通过；六轮 wire 共 774 条响应通过官方 0.153.4 schema 校验。证据见契约 out/result.md。
- 协议：docs/agent-server/protocol.md §13.3；实现：packages/agent-server/src/ingress/codex/；复跑：scripts/codex-remote-smoke.py。
- 交付前已执行 git merge feat/codex-ingress，基线仍为 af3e07a，Already up to date。
- Next：主控独立复跑验收；本分支不 push。
