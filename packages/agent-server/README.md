# agent-server

AS v1 的本机会话服务、unix/WS 传输与 TypeScript 客户端。协议见
[protocol.md](../../docs/agent-server/protocol.md)。运行环境为 Bun。

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

自动重连默认开启，可设置 `reconnect: false`。重连先握手，再按保守的 sinceSeq
重新 attach；断线前仍在输出的 item 会被重新查询，以补回离线时完成的正文。
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
