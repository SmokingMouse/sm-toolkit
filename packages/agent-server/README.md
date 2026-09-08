# agent-server

AS v1 的本机会话服务、unix/WS 传输与 TypeScript 客户端。协议见
[protocol.md](../../docs/agent-server/protocol.md)。运行环境为 Bun。

用户级 LaunchAgent 模板与安装/卸载工具见 [scripts/agent-server](../../scripts/agent-server/README.md)。fj 执行席通过受限 fjContext 传入 root/cid/seat，显式 model、permission 与普通档 serviceTier；不开放任意子进程 env。

Claude 原生能力可通过 `thread/engineEvent` 观察（完整 system 帧、hook、未知子类型与速率限制），通过 `thread/engineControl` 调用白名单控制指令。旧事件照常保留，版本仍为 as/1；新库默认协商 engineEvents 和 bashInput，旧客户端收到兼容的文本输入记录。
engineEvent 与 pendingRequests 需能力协商；permission/changed 仍发给已订阅线程的旧连接，由旧库静默忽略未知通知。

Trellis 迁移：确认 `initializeResult.capabilities.pendingRequests` 后，删掉每 2 秒的 `thread/attach` 全量轮询，首次 attach / 重连用 `pendingRequests[].state` 快照重建，再通过 `onPendingRequests` 与 `pendingRequestStates` 更新审批状态；此只读能力由新 AgentClient 默认协商，不要求答复权限。

```ts
const { thread } = await client.request("thread/start", {
  backend: "claude", permission: "plan", effort: "high", autocompact: "auto",
});
client.onNotification("thread/engineEvent", event => observe(event.subtype, event.payload));
await client.setPermission({ threadId: thread.id, permission: "acceptEdits" });
await client.setEffort({ threadId: thread.id, maxThinkingTokens: 8192 });
const status = await client.engineControl({ threadId: thread.id, subtype: "mcp_status", params: {} });
await client.request("turn/start", { threadId: thread.id, input: [{ type: "bash", command: "pwd" }] });
await client.compact({ threadId: thread.id, instructions: "保留决策" });
```

`initializeResult.capabilities.engine` 提供 engineEvents / engineControl / permissionSet / effortSet / subAgentText / bashInput / compact 标记。除事件通道外，这些新增能力目前只适用于 Claude，Codex 调用返回 `backend_unsupported`。effort 启动档位与热切思考 token 预算语义不同；控制响应原样返回，调用方检查 `response.subtype`。子 agent 正文通过现有 subAgent item 与 progress 通知呈现，无需新 item 类型。控制白名单、readonly 启动限制和 bash 完成帧细节见协议。

Claude 权限启动映射：

| permission | 原生模式 | settings 与审批 |
| --- | --- | --- |
| default | default（manual 兼容名） | 仅此模式注入 `permissions.ask:["*"]`，强制经纪人审批 |
| acceptEdits / auto-edit | acceptEdits | 不注入 settings，编辑由 CLI 自动允许，其余原生询问转审批 |
| plan / readonly | plan | 不注入 settings，原生只读规划模式；readonly 是启动别名，热切用 plan |
| bypassPermissions / full | bypassPermissions | 不注入 ask/settings；意外 `can_use_tool` 自动 allow，零新增 pendingRequests |
| dontAsk | dontAsk | 不注入 settings；原生未授权操作拒绝，意外 `can_use_tool` 自动 deny |

所有模式保留 `--permission-prompt-tool stdio`。bypass 启动另加 `--allow-dangerously-skip-permissions` 支持以后重新进入该模式；无需重复 `--dangerously-skip-permissions`。自动答复通过 `thread/engineEvent` 的 `permission_auto_response` 留痕（需协商 engineEvents），不经过审批队列。readonly/plan 是 CLI 权限模式，不是 OS 沙箱。热切保留启动 settings：从 default 热切后仍可能出现 ask 规则审批，但 bypass/dontAsk 会自动处理；需要原生 acceptEdits/plan 行为请直接以该模式新建线程。完整语义与 lease 要求见 [协议](../../docs/agent-server/protocol.md)。

```sh
bun run typecheck
packages/agent-server/bin/agent-server run --ws-port 0 --grace-ms 1000
packages/agent-server/bin/agent-server daemon start
packages/agent-server/bin/agent-server daemon status
packages/agent-server/bin/agent-server daemon stop
```

`run` 前台运行，`daemon start` 脱离终端。WS 默认关闭；指定 `--ws-port 0`
可由系统分配 loopback 端口，实际 URL 写入 endpoint 文件。`status` 输出
`server/health` JSON，无 daemon 时输出明确错误并返回非零。

socket 路径依次选用 `AGENT_SERVER_SOCKET_PATH`、
`$XDG_RUNTIME_DIR/sm-toolkit/agent-server.sock`、
`$XDG_STATE_HOME/sm-toolkit/agent-server.sock`、
`~/.sm-toolkit/agent-server.sock`；相对 XDG 目录忽略。
pid 与 endpoint 文件分别为 `<socket>.pid`、`<socket>.endpoint.json`。
pid 文件保存 pid、进程启动时间、socket 与 graceMs，关闭前核对进程身份。

数据目录为 `$XDG_STATE_HOME/sm-toolkit/agent-server`，未设置时为 `~/.agent-server`。
其中包含 `agent-server.db`、`token`、`agent-server.log` 和可选的 `config.toml`。
token 首次生成 32 字节随机值，之后复用；token、socket、pid、endpoint 和日志均为 0600。
启动日志记录解析后的路径及来源，绝不记录 token 内容。

`config.toml` 支持 `allowed_roots`、`maxQueuedTurns`、`orphanTimeoutMs`、
`idleTimeoutMs`。默认只允许 HOME 内的 cwd。
SIGTERM / SIGINT 先广播 `server/shuttingDown`，等待 graceMs，再关闭引擎与连接并移除 pid/socket。

```ts
import { connectUnix } from "@smokingmouse/agent-server/client";

const client = await connectUnix({
  path: socketPath, token,
  capabilities: { serverRequests: ["item/commandExecution/requestApproval"] },
});
client.onNotification("item/completed", ({ threadId, item }) => render(threadId, item));
client.onServerRequest("item/commandExecution/requestApproval", request => {
  showApproval(request.params, decision => request.respond({ decision }));
});
client.onNotification("serverRequest/resolved", ({ requestId }) => dismiss(requestId));
client.onError((error, wireId) => report(error, wireId));
client.onSnapshot(snapshot => upsertItems(snapshot.thread.id, snapshot.items));
await client.request("thread/attach", { threadId });
```

WS 对应 `connectWebSocket({ url, token, ... })`，其余 API 相同。连接函数完成
`initialize` 与 `initialized` 后返回；`initializeResult` 提供服务端能力与 clientId。
构造 `new AgentClient(endpoint, options)` 后可先注册回调再调用 `connect()`。

WS 默认拒绝带 Origin 的浏览器握手。浏览器前端需在 daemon config.toml 配置
`ws_allowed_origins = ["https://app.example"]`（完整 origin 精确匹配）；包内传输可传
`allowedOrigins`。无 Origin 的原生客户端可以握手，所有连接仍必须通过 token 验证。

自动重连默认开启，可设置 `reconnect: false`。重连先握手，再按最高已见事件游标 sinceSeq
重新 attach；服务端为完成分配 completedSeq，补回离线时完成的正文，无需客户端回退。
`onSnapshot` 包含补回的 item、队列与 pendingRequests；item 以 id 覆盖，delta 只实时发送。
审批快照的逻辑 requestId 与本次连接的反向请求 id 关联，旧连接的回答句柄拒绝发送。
`respond()` 仅表示响应已发送，成功由 `serverRequest/resolved` 确认；迟到答复的
`-32014` 通过 `onError` 给出。未确认的普通 RPC 在断线时拒绝，不自动重发，
调用方可使用 clientTurnId/clientThreadId 安全重试。

```sh
cd packages/agent-server
bun test
```

测试仅使用 MockEngine 或假的引擎子进程，不启动真实 Claude/Codex。
