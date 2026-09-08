# codex ingress slice 3 再审修复

- 契约：fj-tui-ingress-slice3-fix2-5f7f；修复 review2 的 P1-1/V7，未改变线程后端绑定。
- 已有线程的跨后端 model override 沿用当前模型，官方 warning 带 threadId 和保留模型；turn/start 直接归一化实际传入的 options，避免修改临时副本后仍下发错误模型。同后端模型/权限守卫保留。
- Claude 工具权限卡补 isBlocking=true；冒烟恢复 TUI `--model sonnet` / `--model gpt-5.6-sol`。新增 cross_backend_model_override_tolerated（含真实 PTY 提示）与固定 wire_schema_clean。
- 新 schema 门禁覆盖 v1/v2 response、error、notification、serverRequest；未知映射和孤立响应失败。首次探针发现 InitializeResponse 位于 v1、account/read 与 thread/name/set 响应名不遵循方法拼接，补映射后逐帧复验通过。
- 验证：`cd packages/agent-server && bun test` = 524 pass / 0 fail / 3275 expect / 26 files；`bun run typecheck` = exit 0。新增官方 schema 负向测试覆盖权限卡缺必填、非法响应/通知、孤立响应、未知方法与连接间同 ID。
- 双后端完整冒烟各三轮 exit 0：Claude 90.61/88.65/88.23 秒，Codex 62.27/74.34/64.14 秒；12 个契约判据与 external_client_reply_while_attached_ok 全真。六轮实际 TUI 提示均可见，5564 条出站帧 schema 零失败。
- 证据：主控仓 `.fenjue/tasks/fj-tui-ingress-slice3-fix2-5f7f/out/result.md`、`smoke-proof.json`、双后端各三份 summary 与 wire-schema 报告；原始 wire/PTY 路径见 summary 的 artifact_dir。
- Next：主控独立复跑验收；无 push。
