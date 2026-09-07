# 请求状态增量通知

- 契约 fj-as-pending-notify-b2c5，基线 7c2f379：增加 thread/pendingRequests 与 initialize.capabilities.pendingRequests；attach.pendingRequests 保持原有结构，新增可选 state；AgentClient 增加 onPendingRequests 和 pendingRequestStates，原答复句柄 API 不变。
- 证据：core/approval-broker.ts 发布创建、解决与撤回状态；engines/codex.test.ts 的 pendingRequests 用 fake child 验证四类请求、只读观察、decidedBy、超时、原生撤回和旧客户端；transport/integration.test.ts 在 unix/ws 验证快照、重连、退订、detach 与 attach 边界顺序；protocol/documentation.test.ts 校验通知表、能力与类型字段。
- 验证：bun run typecheck exit 0；packages/agent-server bun test 273 pass / 0 fail；apps/agent-tui bun test 122 pass / 0 fail / 4 snapshots；packages/agent-server bun scripts/check-codex-alignment.ts exit 0（Codex 0.153.4，32 contracts）。未改 TUI 界面，未启动真实引擎，未 push。
- 过程失败已解决：新测试误用了 connect 名称，按现有 helper 改为 connectInProcess；Bun 匹配器影响后续时间戳断言，改为先比较数值并精确比较对象；通知表机器闸发现行放在 serverRequest 分组，已移到 thread 分组。均由后续全量测试覆盖通过。
- Next：交主控独立验收；Trellis 迁移 Goal 保持原状态，消费方确认服务端能力后可删除审批状态全量轮询。
