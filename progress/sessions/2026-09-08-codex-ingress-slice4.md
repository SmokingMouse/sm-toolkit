# codex-ingress slice 4

- 新增 CODEX_HOME 独立命名空间的 Unix WebSocket，endpoint.json 双端点公布；socket 0600、父目录 0700。
- 钉官方 0.153.4 experimental schema（416 文件、155 客户端方法）；方法白名单/readonly 追加拒绝、持久拒绝审计与 codex_tui 本地工具单所有者直通。
- 引擎死亡清理 activeTurn；interrupt ack 无终态 5 秒后退役引擎；显示端断开不终止 turn。SQLite engine UUID 查询补索引。
- slice 2 P2：通用 Read 审批判据命名明确为 tool_permission_question；记录多选逗号与缺答边界。
- 合并前验证：523 tests / 0 fail、typecheck 通过；官方 TUI Codex unix 六判据和 SIGKILL 显示端后完成 turn 通过，Claude ws 同判据通过。schema Draft7 全文件校验及差异/非法 schema 反例通过。
- 已合并 slice 3 `97d3391`（含租约修复与混合后端返工），冲突同时保留分页/断线恢复、Unix trace、动态工具与拒绝审计。合并后 530 tests / 0 fail，typecheck 通过。
- 最终验证：升级脚本 17/17 检查 exit 0，Codex/Claude × WS/Unix × 3 次全部判据通过（含混合后端、fork/分页、断线审批恢复和显示端 SIGKILL 后完成）；416 文件 schema 差异为零。独立 D1 530 pass / 0 fail，D2 typecheck、D3/D4 原六判据、D5 可执行检查均通过。
- 真实进程额外证据：Codex 和 Claude 引擎在 running 时 SIGKILL，activeTurn 清空、turn=failed、thread/close={} 且 thread=closed。产物见 `/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-tui-ingress-slice4-8704/out/result.md`。
- Next：交付待主控独立验收，不 push。
