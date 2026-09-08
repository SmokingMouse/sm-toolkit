# codex-ingress slice 4

- 新增 CODEX_HOME 独立命名空间的 Unix WebSocket，endpoint.json 双端点公布；socket 0600、父目录 0700。
- 钉官方 0.153.4 experimental schema（416 文件、155 客户端方法）；方法白名单/readonly 追加拒绝、持久拒绝审计与 codex_tui 本地工具单所有者直通。
- 引擎死亡清理 activeTurn；interrupt ack 无终态 5 秒后退役引擎；显示端断开不终止 turn。SQLite engine UUID 查询补索引。
- slice 2 P2：通用 Read 审批判据命名明确为 tool_permission_question；记录多选逗号与缺答边界。
- 合并前验证：523 tests / 0 fail、typecheck 通过；官方 TUI Codex unix 六判据和 SIGKILL 显示端后完成 turn 通过，Claude ws 同判据通过。schema Draft7 全文件校验及差异/非法 schema 反例通过。
- 已合并 slice 3 `97d3391`（含租约修复与混合后端返工），冲突同时保留分页/断线恢复、Unix trace、动态工具与拒绝审计。合并后 530 tests / 0 fail，typecheck 通过。
- Next：两后端两传输各三次全部判据升级回归，并通过契约信箱交付。
