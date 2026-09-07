# AS Protocol v1（agent-server 线协议）

> 客户端 ↔ agent-server 的唯一契约。命名与 payload 形状**刻意取 codex app-server
> v2 的子集**，差异逐条列在 §10。本文档是规范，不是实现记录 —— 与 codex 的对齐
> 校验点写在 §10.3。
>
> 参考基线：本机 `codex app-server generate-json-schema --out /tmp/codex-app-server-schema`
> 导出的 v2 schema（99 个 client request / 81 个 server notification / 10 个
> server request）。

---

## 1. 版本与协商

- 协议标识：`as/1`。语义化：**新增**方法 / 通知 / item 字段是兼容变更；**删除或
  改变已有字段语义**必须提 `as/2`。
- 每个连接的第一条消息必须是 `initialize` 请求，服务端回应能力集；客户端随后发
  `initialized` 通知，之后才允许发其它方法。未握手就发别的 → `-32002 not_initialized`。
- 能力协商是**双向声明式**的：客户端声明自己**能处理哪些反向请求**，服务端据此
  决定往哪些连接广播。不能处理审批的客户端（例如只读大屏）不会收到审批请求，
  也不参与竞答。

```jsonc
// → client
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"as/1",
  "token":"…bearer…",                       // WebSocket 走这里；unix socket 亦校验
  "client":{"name":"trellis-web","version":"0.9.0","kind":"web","label":"MacBook Safari"},
  "capabilities":{
    "serverRequests":[                        // 我能渲染并回答的反向请求
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput"
    ],
    "notifications":{"optOut":["item/reasoning/textDelta"]}  // 退订降噪
  }
}}

// ← server
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"as/1",
  "server":{"name":"agent-server","version":"0.1.0"},
  "clientId":"c_01J…",
  "capabilities":{
    "backends":["claude","codex","external"],
    "steer":true, "fork":true, "leases":true, "externalProviders":true,
    "maxQueuedTurns":8
  }
}}
```

`protocolVersion` 不匹配时服务端**不降级**，直接 `-32003 unsupported_protocol_version`
并断开 —— 静默降级是最难查的一类 bug。

## 2. 信封

JSON-RPC 2.0，一条消息一行 NDJSON（`\n` 结尾，消息内不得含裸换行）。
WebSocket 下一条消息 = 一个 text frame，不额外加换行。

四种帧：

| 帧 | 形状 | 方向 |
|---|---|---|
| Request | `{"jsonrpc":"2.0","id":<number\|string>,"method":…,"params":…}` | 双向 |
| Response | `{"jsonrpc":"2.0","id":…,"result":…}` | 双向 |
| Error | `{"jsonrpc":"2.0","id":…,"error":{"code":…,"message":…,"data":…}}` | 双向 |
| Notification | `{"jsonrpc":"2.0","method":…,"params":…}` | 双向（客户端只发 `initialized`） |

- `id` 由发起方分配，两个方向各自独立命名空间。
- 所有 thread 相关的 params 与 notification params **必带 `threadId`**；turn 级的
  必带 `turnId`；item 级的必带 `itemId`。这条冗余是故意的：客户端可以只按
  `threadId` 路由而不维护请求上下文。
- 时间戳一律 `…AtMs`（Unix 毫秒，int64）。

## 3. 方法（client → server）

### 3.1 thread 族

| 方法 | params | result | 说明 |
|---|---|---|---|
| `initialize` | 见 §1 | 见 §1 | 握手 |
| `thread/start` | `{backend, cwd?, model?, permission?, sandbox?, systemPrompt?, tools?, meta?, clientThreadId?}` | `{thread: Thread}` | 新建 thread 并 spawn 引擎 |
| `thread/resume` | `{threadId?, engineThreadId?, backend?, cwd?, …同 start 的覆盖字段}` | `{thread: Thread, attached: boolean}` | **命中活进程即 attach**（`attached:true`，不 spawn）；否则按 `engineThreadId` 重启引擎并续接 |
| `thread/attach` | `{threadId, sinceSeq?}` | `{thread, items: Item[], nextSeq, queue: QueuedTurn[], pendingRequests: PendingServerRequest[]}` | 拿全量后缀快照并开始收该 thread 的通知；翻历史分页用 thread/items/list |
| `thread/detach` | `{threadId}` | `{}` | 只退订，不影响 thread |
| `thread/items/list` | `{threadId, cursor?, limit?, turnId?, direction?}` | `{items, nextCursor}` | 翻历史（快照之外的旧日志） |
| `thread/list` | `{status?, backend?, cwd?, limit?, cursor?}` | `{threads, nextCursor}` | 列 thread |
| `thread/read` | `{threadId}` | `{thread: Thread}` | 只读元信息 |
| `thread/fork` | `{threadId, fromItemId?, clientThreadId?}` | `{thread: Thread}` | 从某条 item 之后分叉出新 thread（codex 原生 `thread/fork`；claude 走 `--fork-session` / 前缀 jsonl） |
| `thread/close` | `{threadId, reason?}` | `{}` | 回收引擎进程，**保留日志** |
| `thread/interrupt` | `{threadId}` | `{interruptedTurnId \| null}` | `turn/interrupt` 的 thread 级糖 |
| `thread/lease/acquire` | `{threadId, ttlMs?}` | `{lease: Lease}` | 可选：独占输入权 |
| `thread/lease/release` | `{threadId}` | `{}` | 释放 |

`thread/start` / `thread/resume` 不接受 `env`（未知字段返回 `-32602`）。
`thread/attach` 永远返回完整后缀，不接受 `limit`（`-32602`）；有界历史读取用 `thread/items/list`。
`thread/resume` 导入未知 engineThreadId 时必须显式传 cwd（缺失返回 `-32602`）；
恢复已知 thread 可以省略 cwd，沿用已保存的工作目录。
引擎启动环境只来自 daemon 的进程环境与服务端模型路由配置；客户端不能覆盖 PATH、凭证或加载器变量。
client 库与 TUI 共用这些参数类型，TUI 不提供环境覆盖选项。

### 3.2 turn 族

| 方法 | params | result | 说明 |
|---|---|---|---|
| `turn/start` | `{threadId, input: UserInput[], clientTurnId?, model?, effort?, cwd?, permission?, sandbox?}` | `{turn: Turn}` | 入队；thread idle 时立即变 running |
| `turn/steer` | `{threadId, expectedTurnId, input: UserInput[], clientTurnId?}` | `{}` | 向**正在跑的** turn 插话；`expectedTurnId` 不匹配 → `-32011` |
| `turn/interrupt` | `{threadId, turnId?}` | `{}` | 中断当前轮；省略 `turnId` = 当前轮 |
| `turn/cancel` | `{threadId, turnId}` | `{}` | 取消**排队中**的轮（running 的用 interrupt） |
| `thread/queue/read` | `{threadId}` | `{queue: QueuedTurn[]}` | 读队列（通知之外的兜底） |

### 3.3 其它

| 方法 | 说明 |
|---|---|
| `server/health` | `{}` → `{uptimeMs, threads:{running,idle,closed}, engines:[…]}` |
| `server/config/read` | 只读 daemon 配置（`allowed_roots` 等），不含 token |

## 4. 通知（server → client）

只发给已 `thread/attach` 该 thread 的连接（除 `server/*` 与无 threadId 的服务级 `error`，
后者发给所有已完成握手且未 optOut error 的连接）。

### 4.1 thread 级

| 通知 | params | 何时 |
|---|---|---|
| `thread/started` | `{thread}` | 新 thread 建立（含别的客户端建的） |
| `thread/status/changed` | `{threadId, status: ThreadStatus}` | `spawning/idle/running/interrupted/systemError/closed` 迁移 |
| `thread/queue/changed` | `{threadId, queue: QueuedTurn[]}` | 入队 / 出队 / 取消。**带全量队列**（codex 只带 `threadId` 要客户端回查，见 §10.2） |
| `thread/closed` | `{threadId, reason}` | 进程回收 |
| `thread/tokenUsage/updated` | `{threadId, usage: Usage}` | 用量刷新 |
| `thread/metadata/updated` | `{threadId, title?, meta?}` | 元信息改动 |

### 4.2 turn 级

| 通知 | params |
|---|---|
| `turn/started` | `{threadId, turn: Turn}` |
| `turn/completed` | `{threadId, turn: Turn}`（`turn.status` ∈ `completed/interrupted/failed`，`usage` / `error` 在里面） |
| `turn/plan/updated` | `{threadId, turnId, plan}` |
| `turn/diff/updated` | `{threadId, turnId, diffStat}` |

### 4.3 item 级

| 通知 | params | 落库 |
|---|---|---|
| `item/started` | `{threadId, turnId, item: Item, seq, startedAtMs}` | 是 |
| `item/completed` | `{threadId, turnId, item: Item, seq, completedAtMs}` | 是 |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` | 否 |
| `item/reasoning/textDelta` | `{threadId, turnId, itemId, delta}` | 否 |
| `item/reasoning/summaryTextDelta` | `{threadId, turnId, itemId, delta}` | 否 |
| `item/commandExecution/outputDelta` | `{threadId, turnId, itemId, chunk, stream:"stdout"\|"stderr"}` | 否 |
| `item/fileChange/patchUpdated` | `{threadId, turnId, itemId, changes}` | 是（覆盖 payload） |
| `item/subAgent/progress` | `{threadId, turnId, itemId, phase, progress?}` | 是（合并 payload） |

### 4.4 反向请求生命周期

| 通知 | params | 何时 |
|---|---|---|
| `serverRequest/resolved` | `{threadId, requestId, decidedBy:{clientId,label}, outcome}` | 某个客户端先答了，**其余客户端据此撤卡** |
| `serverRequest/expired` | `{threadId, requestId, reason}` | 超时 / 引擎消失 / thread 关闭 |

### 4.5 服务级

| 通知 | params |
|---|---|
| `error` | `{threadId?, turnId?, error: {code,message,data?}, willRetry}` |
| `server/shuttingDown` | `{reason, graceMs}` |

## 5. 反向请求（server → client）

服务端向**所有声明了对应 capability 且已 attach 该 thread**的客户端发同一个
逻辑请求；每个连接看到自己的 `id`，但 params 里带同一个 `requestId`。

| 方法 | params 关键字段 | response |
|---|---|---|
| `item/commandExecution/requestApproval` | `{requestId, threadId, turnId, itemId, command, cwd, reason?, startedAtMs}` | `{decision: "accept" \| "acceptForSession" \| "reject" \| "abort"}` |
| `item/fileChange/requestApproval` | `{requestId, threadId, turnId, itemId, changes, grantRoot?, reason?, startedAtMs}` | `{decision: 同上}` |
| `item/permissions/requestApproval` | `{requestId, threadId, turnId, itemId, cwd, permissions, reason?, startedAtMs}` | `{permissions: GrantedPermissions, scope:"turn"\|"thread"\|"session"}` |
| `item/tool/requestUserInput` | `{requestId, threadId, turnId, itemId, questions, isBlocking}` | `{answers: {[questionId]: Answer}}` |

**竞答规则（规范性）**：

1. 服务端为每个逻辑请求建一条 `approvals` 行，状态 `pending`。
2. 第一个**合法**回答（`requestId` 匹配、连接仍 attach、若有 lease 则持锁者）落
   `decided`，写 `decided_by`，转发给引擎。
3. 其余连接：服务端主动向它们发 **cancel**（对 JSON-RPC 而言即：服务端不再等它们
   的 response，收到迟到的 response 直接丢弃并回 `-32014 already_resolved`），
   同时广播 `serverRequest/resolved`。客户端 UI 据此把卡片改成「已由 X 处理」。
4. 超时（默认 `isBlocking ? ∞ : 120s`）→ `serverRequest/expired`，按引擎语义
   取默认决策（审批默认 `reject`，`requestUserInput` 默认空答案）。
5. 无任何客户端在场时：不立即拒绝，先挂起并广播（新 attach 的客户端在
   `thread/attach` 的 `pendingRequests` 里拿到）；超过 `orphanTimeoutMs`
   （默认 30 min）才走默认决策。这是「人不在电脑前，回来还能批」的关键。

**输入租约（可选）**：持有 `thread/lease/acquire` 的客户端在租约期内是唯一
可以 `turn/start` / `turn/steer` / 回答反向请求的连接；其余得到
`-32012 lease_held`（`data.holder` 带持锁者 label）。租约 TTL 默认 5 min，
心跳续期，断线即释放。默认**不启用**，是给「飞书群里七嘴八舌」准备的旋钮。

## 6. item 种类与字段

`Item` 的公共信封：

```ts
interface Item {
  id: string;                 // 引擎给的 item id；引擎不给时服务端生成 "it_…"
  type: ItemType;
  status?: "inProgress" | "completed" | "failed" | "rejected";
  seq: number;                // 服务端分配，thread 内单调递增，永不复用
  completedSeq?: number;       // 完成时从同一个 thread 序列分配，seq 保留用于展示排序
  turnId: string;
  startedAtMs: number;
  completedAtMs?: number;
  payload: …;                 // 按 type 而定，见下表
}
```

| `type` | payload 关键字段 | claude 来源 | codex 来源 |
|---|---|---|---|
| `userMessage` | `content: UserInput[]`、`clientTurnId?` | 服务端自记（stdin 写入时） | `userMessage` item |
| `agentMessage` | `text`、`phase?` | `text_chunk` 聚合 + `result` | `agentMessage` item |
| `reasoning` | `summary?`、`text?` | `thinking` 聚合 | `reasoning` item |
| `commandExecution` | `command`、`cwd`、`exitCode?`、`aggregatedOutput?`、`durationMs?` | `tool_call(Bash)` + `tool_call_done` | `commandExecution` item |
| `fileChange` | `changes: [{path, kind, diff?}]`、`status` | `tool_call(Write/Edit/MultiEdit)` / `file_change` | `fileChange` item |
| `toolCall` | `name`、`namespace?`、`input`、`output?`、`isError?` | 其余 `tool_call` / `tool_call_done` | `functionCallOutput` / `dynamicToolCall` |
| `mcpToolCall` | `server`、`tool`、`arguments`、`result?`、`error?` | `tool_call(mcp__*)` | `mcpToolCall` item |
| `subAgent` | `kind: "agent"\|"bash"\|"workflow"`、`parentItemId`、`phase`、`progress?`、`report?` | `task` 事件（`data.taskType` 区分） | `subAgentActivity` / `collabAgentToolCall` |
| `webSearch` | `query`、`results?` | `tool_call(WebSearch)` | `webSearch` item |
| `imageOutput` | `paths: string[]` | `image_output` | `imageGeneration` item |
| `plan` | `text` / `steps` | `ExitPlanMode` 入参 | `plan` item |
| `contextCompaction` | `{}` | claude compact | `contextCompaction` item |
| `error` | `message`、`code?`、`retryable` | `error` 事件 | `error` 通知 |

`UserInput`：

```ts
type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; path: string; mime: string }      // 本机绝对路径（见 §10.2）
  | { type: "file"; path: string; mime?: string; name?: string };
```

**归一原则**：`packages/agent` 的 `EventType`（`text_chunk` / `tool_call` /
`task` / `file_change` / …）是**引擎侧**契约，item 是**服务侧**契约。
两者不合并 —— `AgentEvent` 是流，item 是有身份、有状态、可持久化的实体。

## 7. 错误码

复用 JSON-RPC 保留段（`-32700 parse` / `-32600 invalid request` /
`-32601 method not found` / `-32602 invalid params` / `-32603 internal`），
业务错误占 `-32000 … -32099`：

| 码 | 名 | 含义 | 客户端应该怎么做 |
|---|---|---|---|
| `-32001` | `thread_not_found` | threadId 不存在 | 刷新列表 |
| `-32002` | `not_initialized` | 未握手就发方法 | 修客户端 |
| `-32003` | `unsupported_protocol_version` | 版本不匹配 | 升级，不降级 |
| `-32004` | `engine_unavailable` | spawn / 握手失败（`data.stderr` 带尾部） | 展示原因，允许重试 |
| `-32005` | `unauthorized` | token 错 / cwd 不在 `allowed_roots` | 不重试 |
| `-32006` | `thread_busy` | 队列满（`maxQueuedTurns`） | 退避重试 |
| `-32007` | `thread_closed` | thread 已关 | 先 `thread/resume` |
| `-32008` | `unsupported_capability` | 例如对 external thread 发 `turn/start` | 灰掉入口 |
| `-32009` | `cursor_expired` | `sinceSeq` 早于日志保留窗 | 退化为全量快照 |
| `-32010` | `turn_not_found` | turnId 不存在 | 刷新 |
| `-32011` | `turn_not_active` | `expectedTurnId` 与当前轮不符（steer 竞态） | 重读队列再决定 |
| `-32012` | `lease_held` | 别人持有输入租约 | 展示持有者，提供抢占入口 |
| `-32013` | `duplicate_client_id` | `clientTurnId` / `clientThreadId` 冲突且 payload 不同 | 换 id |
| `-32014` | `already_resolved` | 反向请求已被别人答了 | 撤卡 |
| `-32015` | `engine_protocol_error` | 引擎回了不认识的东西（`data.raw` 截断） | 报错，建议看 trace |

`error.data` 约定：`{threadId?, turnId?, itemId?, retryable: boolean, detail?}`。

## 8. 幂等与重放

### 8.1 幂等键

- `thread/start` 的 `clientThreadId`、`turn/start` 的 `clientTurnId` 是**客户端
  生成的幂等键**（建议 uuidv7）。服务端唯一索引；重复提交同一个键：
  - payload 等价 → 返回**原来那个** thread/turn，`result` 加 `deduplicated: true`；
  - payload 不同 → `-32013 duplicate_client_id`。
- 这解决的是真实场景：手机网络抖动，客户端不知道 `turn/start` 到底有没有到，
  重发一次不该跑两轮、不该多烧一次钱。
- 反向请求的回答按 `requestId` 幂等：重复回答返回 `-32014`，不改变已定的决策。

### 8.2 重放

- 每条 item 开始时分配 `seq`，完成（含失败）时从同一个 thread 序列分配新的
  `completedSeq`；正文、完成游标与 nextSeq 在同一事务提交后才广播。
  `item/started.params.seq = item.seq`；`item/completed.params.seq = item.completedSeq`。
  `thread/attach{sinceSeq:N}` 返回 `max(seq, completedSeq ?? 0) > N` 的全部 item，
  加上所有 `inProgress` item 与当前 `nextSeq`。快照按 item.seq 排序，客户端按 id upsert。
  客户端记录已见通知的最大 params.seq，快照后推进到 nextSeq - 1；无需回退游标。
  item.seq 保持不变，供展示和 items/list 分页；两种游标不能混用。
- delta **不重放**。断线期间的 delta 由重连后的 `item/completed`（带全量文本）
  补齐；仍在 `inProgress` 的 item 在快照里带**已聚合的 partial 文本**
  （服务端在内存里维护，落库只在 completed）。
- 保留窗：默认永久（sqlite 里躺着）。`-32009 cursor_expired` 是为将来的
  归档 / 裁剪预留的，v1 实现里不会触发。
- 客户端重连的标准动作：`initialize` → `thread/attach{threadId, sinceSeq}`
  →（可选）`thread/queue/read`。快照里已带 `pendingRequests`，所以「离线期间
  弹出的审批卡」重连即见 —— 这是今天 Trellis `catchup.pendingInteraction`
  的推广版。

### 8.3 顺序保证

- 同一 thread 的通知按 `seq` 严格有序投递给同一连接。
- **先落库、再广播**：`item/started` 的 seq 分配与落库发生在广播之前，所以
  「快照里没有 + 通知也没收到」不可能同时成立。
- 跨 thread 无序保证。

## 9. 队列语义

```
turn/start ──► [ queued(0) ] ──► running ──► completed
                    ▲   │
                    │   └── turn/cancel ──► cancelled（不进 items）
                    │
turn/start ──► [ queued(1) ] …

turn/steer(expectedTurnId=running) ──► 插进当前轮，不进队列
```

规范：

1. **一 thread 一 running turn**，这是引擎的物理约束（两条 prompt 同时写一个
   stdin 会互相踩），不是可配策略。
2. 队列 FIFO，容量 `maxQueuedTurns`（默认 8）；满则 `-32006 thread_busy`。
3. 每次入队 / 出队 / 取消 / 状态迁移都广播 `thread/queue/changed`，params 带
   **全量队列**（`[{turnId, clientTurnId?, position, enqueuedAtMs, preview}]`）。
4. `turn/steer` 只对 `running` 生效，且必须带 `expectedTurnId`。thread 处于
   `idle` 时 steer → `-32011 turn_not_active`（客户端应该改发 `turn/start`）。
5. `turn/interrupt` 中断 running turn，**不清空队列**；要清空得逐个
   `turn/cancel`。这是刻意的：中断当前回答 ≠ 放弃后面排的问题。
6. running turn 因引擎死亡而失败时，队列**冻结**（thread → `systemError`），
   等待 `thread/resume`；resume 成功后队列继续消费。

## 10. 与 codex app-server v2 的关系

### 10.1 直接取用（同名；字段差异见 §10.2）

`initialize` / `initialized`、`thread/start` / `thread/resume` / `thread/fork` /
`thread/list` / `thread/read` / `thread/items/list`、
`turn/start` / `turn/steer` / `turn/interrupt`、
`thread/started` / `thread/status/changed` / `thread/queue/changed` /
`thread/tokenUsage/updated`、`turn/started` / `turn/completed` /
`turn/plan/updated` / `turn/diff/updated`、
`item/started` / `item/completed` / `item/agentMessage/delta` /
`item/reasoning/textDelta` / `item/reasoning/summaryTextDelta` /
`item/commandExecution/outputDelta` / `item/fileChange/patchUpdated`、
`serverRequest/resolved`、`error`，
以及四个反向请求 `item/commandExecution/requestApproval` /
`item/fileChange/requestApproval` / `item/permissions/requestApproval` /
`item/tool/requestUserInput`。

item 的 `type` 取值取 codex `ThreadItem` 的子集，字段名一致（`aggregatedOutput`、
`exitCode`、`changes`、`durationMs` …）。

### 10.2 有意的差异（逐条给理由）

| # | 差异 | codex v2 | AS v1 | 为什么 |
|---|---|---|---|---|
| D1 | 多客户端 | 一个 app-server 连接基本等于一个前端 | `thread/attach` / `thread/detach` + `clientId` + 广播 | 本设计的核心诉求就是多前端同看一份日志 |
| D2 | 快照与重放 | `thread/items/list` 分页游标 | `thread/attach{sinceSeq}` + thread 内单调 `seq` / `completedSeq` | 游标是「翻历史」，完成游标是「补断线」；按 id upsert 让「不丢不重」可机械验证 |
| D3 | 队列通知 | `thread/queue/changed` 只带 `threadId`，客户端要回查 | 带**全量队列** | 薄前端不该为一个通知再发一次 RPC；队列很小，带上不贵 |
| D4 | 竞答 | 单客户端，无竞答概念 | `requestId` + 先答生效 + `serverRequest/resolved` 撤卡 + 可选 lease | 手机 / 飞书 / 网页可能同时弹卡 |
| D5 | 幂等 | `clientUserMessageId` 仅作回显 | `clientTurnId` / `clientThreadId` 是**去重键**，带唯一索引 | 移动网络下重发是常态 |
| D6 | resume 语义 | `thread/resume` 命中 running thread 时"rejoin" | 同义，但显式在 result 里返回 `attached: true` | 客户端要据此决定「是我起的」还是「我接管了别人的」 |
| D7 | 附件 | codex 用 `input_image` 等内联 content | `UserInput.image/file` 用**本机绝对路径** | 引擎（claude `--image` / codex `--image`）本来就吃路径；base64 过 socket 白烧内存。上传落盘由客户端或 Trellis blobs 负责 |
| D8 | 协议面 | 99 methods / 81 notifications | ~20 methods / ~20 notifications | 只做会话，marketplace / plugin / fs / account / realtime 全部不进 |
| D9 | 错误码 | 大量场景走 `error` 通知 | 请求级错误一律走 JSON-RPC error（§7 表），`error` 通知只用于**无对应请求**的引擎侧故障 | 客户端能用「这次调用失败了」而不是「稍后可能收到一个通知」写代码 |
| D10 | 后端 | 只有 codex | `backend: "claude" \| "codex" \| "external"` | 本设计的另一半 |
| D11 | 审批决策 | `CommandExecutionApprovalDecision` 含 `acceptWithExecpolicy…` 等 codex 专属变体 | 只留 `accept / acceptForSession / reject / abort` | 跨后端可表达的最小集；codex 专属变体经 `data.raw` 透传但不进类型 |
| D12 | 租约 | 无 | `thread/lease/*` | 多客户端下的「我先接管」 |

| D13 | 关闭 | 0.153.4 无 thread/close | AS thread/close 回收独占引擎并保留日志 | daemon 拥有进程生命周期 |
| D14 | 参数投影 | 原生必填字段见下表 | 增加关联 ID、重放游标、竞答身份；压平输出与 usage | 跨后端共享信封，映射层负责转换；同名不代表原样转发 |

必填字段差异（机械检查读取此表；未列方法必须完全一致）。`thread/resume` 的 AS
必填集合取 union 各分支交集，身份二选一仍由 zod 校验。其它差异的理由：握手和 backend
由 AS 自有路由处理；省略 turnId 表示当前轮；服务级 error 无 thread；delta 的分片索引
在引擎内合并，输出增加 stream；diff 转成 diffStat；审批从已知 item 补齐命令和 changes。

<!-- codex-required-differences -->
| 方法 | 仅 AS 必填 | 仅 Codex 必填 |
|---|---|---|
| `initialize` | client, protocolVersion | clientInfo |
| `thread/start` | backend | — |
| `thread/resume` | — | threadId |
| `turn/interrupt` | — | turnId |
| `error` | — | threadId, turnId |
| `thread/started` | threadId | — |
| `thread/queue/changed` | queue | — |
| `thread/tokenUsage/updated` | usage | tokenUsage, turnId |
| `turn/started` | turnId | — |
| `turn/completed` | turnId | — |
| `turn/diff/updated` | diffStat | diff |
| `item/started` | itemId, seq | — |
| `item/completed` | itemId, seq | — |
| `item/commandExecution/outputDelta` | chunk, stream | delta |
| `serverRequest/resolved` | decidedBy, outcome | — |
| `item/reasoning/summaryTextDelta` | — | summaryIndex |
| `item/reasoning/textDelta` | — | contentIndex |
| `item/commandExecution/requestApproval` | command, cwd, requestId | — |
| `item/fileChange/requestApproval` | changes, requestId | — |
| `item/tool/requestUserInput` | requestId | — |
| `item/permissions/requestApproval` | requestId | — |
<!-- /codex-required-differences -->

### 10.3 对齐校验点（实现期的机械检查）

1. `packages/agent-server/scripts/check-codex-alignment.ts`：读 schema 根目录的
   ClientRequest / ClientNotification / ServerNotification / ServerRequest（这些枚举引用 v2 参数定义）。
   对 §10.1 每个名字检查所属方向与存在性，再对 params 必填集合做双向差集比较；
   仅允许 §10.2 明列的字段差异。新增、移除或过时例外均让 CI 红。
2. codex schema 由 `codex app-server generate-json-schema --out <dir>` 生成，
   版本号锁进仓（`docs/agent-server/codex-schema-version.txt`）。脚本核对本机 CLI 版本；
   默认复用带匹配版本标记的 `/tmp/codex-app-server-schema`，否则在临时目录生成并清理。
   `--schema-dir <dir>` 可检查带 `codex-schema-version.txt` 的离线 schema。
   引擎在 initialize 响应里核对 userAgent；不匹配发 -32015 error，保持 thread 可用。
3. `CodexSession` 的映射层禁止出现「猜」：收到未知 item type / 未知 server
   request → 发 `error` 通知 + `-32015 engine_protocol_error`，不静默丢弃、不拆 thread。
   未知 item 映射成 error item；未知反向请求还要回复对应原生 RPC 的 -32015。

## 11. 示例：一轮完整交互

```jsonc
// ── 1. 握手（略，见 §1）

// ── 2. 开 thread
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{
  "backend":"claude","cwd":"/Users/me/code/proj","model":"opus",
  "permission":"default","clientThreadId":"018f…a1"}}
{"jsonrpc":"2.0","id":2,"result":{"thread":{
  "id":"th_018f…","backend":"claude","engineThreadId":null,
  "status":{"type":"spawning"},"cwd":"/Users/me/code/proj","createdAtMs":1757000000000}}}

{"jsonrpc":"2.0","method":"thread/status/changed","params":{"threadId":"th_018f…","status":{"type":"idle"}}}
// engineThreadId 在引擎报出 session id 后补
{"jsonrpc":"2.0","method":"thread/metadata/updated","params":{"threadId":"th_018f…","engineThreadId":"9c1e…"}}

// ── 3. 发一轮
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
  "threadId":"th_018f…","clientTurnId":"018f…b2",
  "input":[{"type":"text","text":"把 run-bus 的审批路径讲清楚"}]}}
{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"tn_018f…","threadId":"th_018f…","status":"inProgress","ordinal":1}}}

{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th_018f…","turn":{"id":"tn_018f…","status":"inProgress"}}}
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":1,
  "startedAtMs":1757000001000,
  "item":{"id":"it_1","type":"userMessage","payload":{"content":[{"type":"text","text":"把 run-bus …"}]}}}}
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":2,
  "startedAtMs":1757000001200,
  "item":{"id":"it_2","type":"reasoning","status":"inProgress","payload":{}}}}
{"jsonrpc":"2.0","method":"item/reasoning/textDelta","params":{"threadId":"th_018f…","turnId":"tn_018f…","itemId":"it_2","delta":"先看 startRun…"}}

// ── 4. 工具审批（反向请求，广播给所有能答的客户端）
{"jsonrpc":"2.0","id":101,"method":"item/commandExecution/requestApproval","params":{
  "requestId":"ar_7","threadId":"th_018f…","turnId":"tn_018f…","itemId":"it_3",
  "command":"rg -n startRun lib/server","cwd":"/Users/me/code/proj","startedAtMs":1757000002000}}
// 手机先答：
{"jsonrpc":"2.0","id":101,"result":{"decision":"accept"}}
// 其余客户端收到：
{"jsonrpc":"2.0","method":"serverRequest/resolved","params":{
  "threadId":"th_018f…","requestId":"ar_7",
  "decidedBy":{"clientId":"c_02","label":"iPhone"},"outcome":"accept"}}

// ── 5. 正文流 + 收尾
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":4,
  "startedAtMs":1757000004000,"item":{"id":"it_4","type":"agentMessage","status":"inProgress","payload":{"text":""}}}}
{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"th_018f…","turnId":"tn_018f…","itemId":"it_4","delta":"审批路径分三段："}}
{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":4,
  "completedAtMs":1757000009000,
  "item":{"id":"it_4","type":"agentMessage","status":"completed","payload":{"text":"审批路径分三段：…"}}}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th_018f…","turn":{
  "id":"tn_018f…","status":"completed","durationMs":8100,
  "usage":{"inputTokens":12043,"outputTokens":866,"cachedTokens":11200,"cacheCreation":0,"contextTokens":13210}}}}
{"jsonrpc":"2.0","method":"thread/status/changed","params":{"threadId":"th_018f…","status":{"type":"idle"}}}

// ── 6. 另一个客户端中途 attach（拿快照）
{"jsonrpc":"2.0","id":9,"method":"thread/attach","params":{"threadId":"th_018f…","sinceSeq":0}}
{"jsonrpc":"2.0","id":9,"result":{
  "thread":{"id":"th_018f…","status":{"type":"idle"},"backend":"claude"},
  "items":[/* seq 1..4 */],"nextSeq":5,"queue":[],"pendingRequests":[]}}
```

## 12. 未定项（v1 冻结前要拍板）

- `thread/fork` 对 claude 的实现选型：原生 `--fork-session`（要求 resume 在场）
  vs Trellis 已在用的前缀 jsonl 截断。前者简单但语义是「从 tip 分叉」，后者
  支持「从任意 item 分叉」。倾向：协议保留 `fromItemId`，claude 后端在
  `fromItemId` 缺省时走原生 fork，给定时走前缀 jsonl。
- `agentMessage` 的**分层偏移**（Trellis 的 `finalStart`）要不要进协议。倾向
  不进：那是渲染策略，客户端可以按 item 边界自己算（有了 item 模型，
  「最终答复 = 最后一个 agentMessage item」天然成立，`finalStart` 这个补丁可以整个消失）。
- 用量字段是否直接复用 `packages/agent` 的 `Cost`（`usd/inputTokens/outputTokens/
  cachedTokens/cacheCreation/estimated/contextTokens`）。倾向复用，只把 `usd`
  标为可空。
