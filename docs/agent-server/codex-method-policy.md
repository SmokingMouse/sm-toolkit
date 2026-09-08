# Codex 0.153.4 客户端方法治理表

来源：`codex app-server generate-json-schema --experimental` 的 [ClientRequest.json](codex-schema/0.153.4/ClientRequest.json)，完整 155 个方法；不沿用旧 spike 的计数。
执行表：[method-policy.ts](../../packages/agent-server/src/ingress/codex/method-policy.ts)。新增未知方法一律拒绝。
单测要求 schema 与执行表键集合完全相等，并逐项验证 D 桶在 readonly/default/full 下拒绝、无引擎副作用、有持久审计。

| 官方方法 | 处理 |
|---|---|
| `initialize` | 握手：AS 鉴权 + 版本告警 |
| `server/diagnostics` | 拒绝：所有权限均 -32601 |
| `thread/start` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/resume` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/fork` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/archive` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/delete` | 拒绝：所有权限均 -32601 |
| `thread/unsubscribe` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/increment_elicitation` | 拒绝：所有权限均 -32601 |
| `thread/decrement_elicitation` | 拒绝：所有权限均 -32601 |
| `thread/name/set` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/goal/set` | 拒绝：所有权限均 -32601 |
| `thread/goal/get` | 拒绝：所有权限均 -32601 |
| `thread/goal/clear` | 拒绝：所有权限均 -32601 |
| `thread/queue/add` | 拒绝：所有权限均 -32601 |
| `thread/queue/list` | 拒绝：所有权限均 -32601 |
| `thread/queue/update` | 拒绝：所有权限均 -32601 |
| `thread/queue/delete` | 拒绝：所有权限均 -32601 |
| `thread/queue/reorder` | 拒绝：所有权限均 -32601 |
| `thread/queue/start` | 拒绝：所有权限均 -32601 |
| `thread/metadata/update` | 拒绝：所有权限均 -32601 |
| `thread/section/move` | 拒绝：所有权限均 -32601 |
| `thread/settings/update` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/memoryMode/set` | 拒绝：所有权限均 -32601 |
| `memory/reset` | 拒绝：所有权限均 -32601 |
| `thread/unarchive` | 拒绝：所有权限均 -32601 |
| `thread/compact/start` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/shellCommand` | 拒绝：所有权限均 -32601 |
| `thread/approveGuardianDeniedAction` | 拒绝：所有权限均 -32601 |
| `thread/backgroundTerminals/clean` | 拒绝：所有权限均 -32601 |
| `thread/backgroundTerminals/list` | 拒绝：所有权限均 -32601 |
| `thread/backgroundTerminals/terminate` | 拒绝：所有权限均 -32601 |
| `thread/rollback` | 拒绝：所有权限均 -32601 |
| `thread/revert` | 拒绝：所有权限均 -32601 |
| `thread/list` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `project/list` | 拒绝：所有权限均 -32601 |
| `project/read` | 拒绝：所有权限均 -32601 |
| `project/create` | 拒绝：所有权限均 -32601 |
| `project/import` | 拒绝：所有权限均 -32601 |
| `project/update` | 拒绝：所有权限均 -32601 |
| `project/move` | 拒绝：所有权限均 -32601 |
| `project/delete` | 拒绝：所有权限均 -32601 |
| `threadSection/list` | 拒绝：所有权限均 -32601 |
| `threadSection/create` | 拒绝：所有权限均 -32601 |
| `threadSection/update` | 拒绝：所有权限均 -32601 |
| `threadSection/delete` | 拒绝：所有权限均 -32601 |
| `thread/search` | 拒绝：所有权限均 -32601 |
| `thread/searchOccurrences` | 拒绝：所有权限均 -32601 |
| `thread/loaded/list` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/read` | 按策略：所属引擎历史；先检查线程路径与后端 |
| `thread/turns/list` | 按策略：所属引擎历史；先检查线程路径与后端 |
| `thread/items/list` | 按策略：所属引擎历史；先检查线程路径与后端 |
| `thread/inject_items` | 拒绝：所有权限均 -32601 |
| `skills/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `skills/extraRoots/set` | 拒绝：所有权限均 -32601 |
| `hooks/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `marketplace/add` | 拒绝：所有权限均 -32601 |
| `marketplace/remove` | 拒绝：所有权限均 -32601 |
| `marketplace/upgrade` | 拒绝：所有权限均 -32601 |
| `plugin/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `plugin/search` | 拒绝：所有权限均 -32601 |
| `plugin/installed` | 拒绝：所有权限均 -32601 |
| `plugin/reconcile` | 拒绝：所有权限均 -32601 |
| `plugin/read` | 拒绝：所有权限均 -32601 |
| `plugin/skill/read` | 拒绝：所有权限均 -32601 |
| `plugin/share/save` | 拒绝：所有权限均 -32601 |
| `plugin/share/updateTargets` | 拒绝：所有权限均 -32601 |
| `plugin/share/list` | 拒绝：所有权限均 -32601 |
| `plugin/share/checkout` | 拒绝：所有权限均 -32601 |
| `plugin/share/delete` | 拒绝：所有权限均 -32601 |
| `app/read` | 拒绝：所有权限均 -32601 |
| `app/list` | 拒绝：所有权限均 -32601 |
| `app/installed` | 拒绝：所有权限均 -32601 |
| `fs/readFile` | 拒绝：所有权限均 -32601 |
| `fs/writeFile` | 拒绝：所有权限均 -32601 |
| `fs/createDirectory` | 拒绝：所有权限均 -32601 |
| `fs/getMetadata` | 拒绝：所有权限均 -32601 |
| `fs/readDirectory` | 拒绝：所有权限均 -32601 |
| `fs/remove` | 拒绝：所有权限均 -32601 |
| `fs/copy` | 拒绝：所有权限均 -32601 |
| `fs/watch` | 拒绝：所有权限均 -32601 |
| `fs/unwatch` | 拒绝：所有权限均 -32601 |
| `skills/config/write` | 拒绝：所有权限均 -32601 |
| `plugin/install` | 拒绝：所有权限均 -32601 |
| `plugin/uninstall` | 拒绝：所有权限均 -32601 |
| `turn/start` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `turn/settings/update` | 拒绝：所有权限均 -32601 |
| `turn/steer` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `turn/interrupt` | 按策略：AS 生命周期/租约/模型/权限/审批检查 |
| `thread/realtime/start` | 拒绝：所有权限均 -32601 |
| `thread/realtime/appendAudio` | 拒绝：所有权限均 -32601 |
| `thread/realtime/appendText` | 拒绝：所有权限均 -32601 |
| `thread/realtime/appendSpeech` | 拒绝：所有权限均 -32601 |
| `thread/realtime/stop` | 拒绝：所有权限均 -32601 |
| `thread/timeline/list` | 拒绝：所有权限均 -32601 |
| `thread/realtime/listVoices` | 拒绝：所有权限均 -32601 |
| `review/start` | 拒绝：所有权限均 -32601 |
| `model/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `modelProvider/capabilities/read` | 拒绝：所有权限均 -32601 |
| `experimentalFeature/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `permissionProfile/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `experimentalFeature/enablement/set` | 拒绝：所有权限均 -32601 |
| `remoteControl/enable` | 拒绝：所有权限均 -32601 |
| `remoteControl/disable` | 拒绝：所有权限均 -32601 |
| `remoteControl/status/read` | 拒绝：所有权限均 -32601 |
| `remoteControl/pairing/start` | 拒绝：所有权限均 -32601 |
| `remoteControl/pairing/status` | 拒绝：所有权限均 -32601 |
| `remoteControl/client/list` | 拒绝：所有权限均 -32601 |
| `remoteControl/client/revoke` | 拒绝：所有权限均 -32601 |
| `collaborationMode/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `mock/experimentalMethod` | 拒绝：所有权限均 -32601 |
| `environment/add` | 拒绝：所有权限均 -32601 |
| `environment/info` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `environment/status` | 拒绝：所有权限均 -32601 |
| `mcpServer/oauth/login` | 拒绝：所有权限均 -32601 |
| `config/mcpServer/reload` | 拒绝：所有权限均 -32601 |
| `mcpServerStatus/list` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `mcpServer/resource/read` | 拒绝：所有权限均 -32601 |
| `mcpServer/event/stream/start` | 拒绝：所有权限均 -32601 |
| `mcpServer/event/stream/stop` | 拒绝：所有权限均 -32601 |
| `mcpServer/tool/call` | 拒绝：所有权限均 -32601 |
| `windowsSandbox/setupStart` | 拒绝：所有权限均 -32601 |
| `windowsSandbox/readiness` | 拒绝：所有权限均 -32601 |
| `account/login/start` | 拒绝：所有权限均 -32601 |
| `account/bedrock/discover` | 拒绝：所有权限均 -32601 |
| `account/bedrock/setup` | 拒绝：所有权限均 -32601 |
| `account/login/cancel` | 拒绝：所有权限均 -32601 |
| `account/logout` | 拒绝：所有权限均 -32601 |
| `account/rateLimits/read` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `account/rateLimitResetCredit/consume` | 拒绝：所有权限均 -32601 |
| `account/usage/read` | 拒绝：所有权限均 -32601 |
| `account/workspaceMessages/read` | 拒绝：所有权限均 -32601 |
| `account/sendAddCreditsNudgeEmail` | 拒绝：所有权限均 -32601 |
| `feedback/upload` | 拒绝：所有权限均 -32601 |
| `command/exec` | 拒绝：所有权限均 -32601 |
| `command/exec/write` | 拒绝：所有权限均 -32601 |
| `command/exec/terminate` | 拒绝：所有权限均 -32601 |
| `command/exec/resize` | 拒绝：所有权限均 -32601 |
| `process/spawn` | 拒绝：所有权限均 -32601 |
| `process/writeStdin` | 拒绝：所有权限均 -32601 |
| `process/kill` | 拒绝：所有权限均 -32601 |
| `process/resizePty` | 拒绝：所有权限均 -32601 |
| `config/read` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `externalAgentConfig/detect` | 拒绝：所有权限均 -32601 |
| `externalAgentConfig/import` | 拒绝：所有权限均 -32601 |
| `externalAgentConfig/import/recordHistory` | 拒绝：所有权限均 -32601 |
| `externalAgentConfig/import/readHistories` | 拒绝：所有权限均 -32601 |
| `config/value/write` | 拒绝：所有权限均 -32601 |
| `config/batchWrite` | 拒绝：所有权限均 -32601 |
| `configRequirements/read` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `account/read` | 放行：control 只读；路径、账户刷新、模型策略检查 |
| `fuzzyFileSearch` | 拒绝：所有权限均 -32601 |
| `fuzzyFileSearch/sessionStart` | 拒绝：所有权限均 -32601 |
| `fuzzyFileSearch/sessionUpdate` | 拒绝：所有权限均 -32601 |
| `fuzzyFileSearch/sessionStop` | 拒绝：所有权限均 -32601 |

AS 桶仅放开当前已实现的具体后端方法；不支持的后端仍明确拒绝。控制进程绝不接收 thread/start 或副作用方法。
`fs/readFile` 没有原生 threadId，无法可靠归属到某个线程，当前整体拒绝；`fs/*`、`command/exec*` 不存在绕过 allowed_roots 的放行入口。
`workspace/*` 和 `userVerification/verify` 未出现在本版本生成表，作为未知方法拒绝并审计，不编造官方方法。

readonly 追加 deny 表（方法表 D 桶已对所有权限拒绝）：

| 入口 | 额外拒绝 |
|---|---|
| thread/resume | permission 提权；workspace-write / danger-full-access sandbox |
| thread/settings/update | permission 提权；workspace-write / danger-full-access sandbox |
| turn/start | permission 提权；workspaceWrite / dangerFullAccess sandboxPolicy |
| 所有客户端请求 | approvalsReviewer 非 user（含 auto_review） |

普通 readonly turn 保留，最终引擎只能使用只读沙箱/Claude readonly 治理；不能用 native overrides 改权限。
拒绝记录写入 SQLite `ingress_audit`（created_at、client_id、method、thread_id、code、reason），不保存任意请求参数、token 或工具内容。

反向请求：四类权限/用户输入仍经 AS broker。`item/tool/call` 仅 namespace=codex_tui 且 threadId/turnId 属于活动引擎时直通单个已附着 TUI；
请求 ID 按连接重映射，回答校验所有者，显示端断开只释放所有权并允许重新接手，不中断 turn。其他反向请求（包括 MCP elicitation）明确拒绝。

