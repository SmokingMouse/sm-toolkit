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
    "pendingRequests":true,                   // 只读请求状态，不授予答复能力
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
    "maxQueuedTurns":8, "pendingRequests":true, "midThreadFork":true
  }
}}
```

`protocolVersion` 不匹配时服务端**不降级**，直接 `-32003 unsupported_protocol_version`
并断开 —— 静默降级是最难查的一类 bug。

| 能力字段 | 方向 | 类型 / 含义 |
|---|---|---|
| `capabilities.engineEvents` | initialize 请求 | 可选 boolean；true 才订阅 thread/engineEvent，新库默认 true |
| `capabilities.bashInput` | initialize 请求 | 可选 boolean；true 接收 bash 输入变体，否则 item 通知/历史投影为文本，新库默认 true |
| `capabilities.pendingRequests` | initialize 请求 / 结果 | 可选 boolean；客户端 true 才订阅 thread/pendingRequests，新库默认 true；服务端 true 表示支持只读状态增量与快照 state |
| `capabilities.midThreadFork` | initialize 结果 | 可选 boolean；true 表示 Claude / Codex 支持任意 `fromItemId`（含尾）分叉；缺省表示服务端未声明支持。旧客户端无需声明新能力 |
| `capabilities.engine.engineEvents` | initialize 结果 | 可选 boolean；原生事件通道支持 |
| `capabilities.engine.engineControl` | initialize 结果 | 可选 boolean；Claude 控制直通 |
| `capabilities.engine.permissionSet` | initialize 结果 | 可选 boolean；Claude 权限热切 |
| `capabilities.engine.effortSet` | initialize 结果 | 可选 boolean；Claude thinking token 预算 |
| `capabilities.engine.subAgentText` | initialize 结果 | 可选 boolean；Claude 子 agent 正文 |
| `capabilities.engine.bashInput` | initialize 结果 | 可选 boolean；Claude bash 输入 |
| `capabilities.engine.compact` | initialize 结果 | 可选 boolean；Claude 主动 compact |

结果的 engine 对象可选；本服务始终提供，除 engineEvents=true 外，其余标记由启用后端是否包含 Claude 决定。

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
| `thread/start` | `{backend, cwd?, model?, effort?, permission?, serviceTier?, fjContext?, autocompact?, sandbox?, systemPrompt?, tools?, meta?, clientThreadId?}` | `{thread: Thread, deduplicated?: true}` | 新建 thread 并 spawn 引擎；`deduplicated` 见 §8.1 |
| `thread/resume` | `{threadId?, engineThreadId?, backend?, cwd?, …同 start 的覆盖字段}` | `{thread: Thread, attached: boolean}` | **命中活进程即 attach**（`attached:true`，不 spawn）；否则按 `engineThreadId` 重启引擎并续接 |
| `thread/attach` | `{threadId, sinceSeq?}` | `{thread, items: Item[], nextSeq, queue: QueuedTurn[], pendingRequests: PendingServerRequest[]}` | 拿全量后缀快照并开始收该 thread 的通知；翻历史分页用 thread/items/list |
| `thread/detach` | `{threadId}` | `{}` | 只退订，不影响 thread |
| `thread/items/list` | `{threadId, cursor?, limit?, turnId?, direction?}` | `{items, nextCursor}` | 翻历史（快照之外的旧日志） |
| `thread/list` | `{status?, backend?, cwd?, limit?, cursor?}` | `{threads, nextCursor}` | 列 thread |
| `thread/read` | `{threadId}` | `{thread: Thread}` | 只读元信息 |
| `thread/fork` | `{threadId, fromItemId?, clientThreadId?}` | `{thread: Thread, deduplicated?: true}` | 新 thread 复制源日志至指定 item（含）；缺省取调用时末尾；返回 `forkedFrom`。精确原生坐标用原生 fork，其余播种历史；非法 itemId 报 `-32602` |
| `thread/close` | `{threadId, reason?}` | `{}` | 回收引擎进程，**保留日志** |
| `thread/interrupt` | `{threadId}` | `{interruptedTurnId \| null}` | `turn/interrupt` 的 thread 级糖 |
| `thread/lease/acquire` | `{threadId, ttlMs?}` | `{lease: Lease}` | 可选：独占输入权 |
| `thread/lease/release` | `{threadId}` | `{}` | 释放 |
| `thread/engineControl` | `{threadId, subtype: string, params: JsonObject}` | `JsonObject`（完整原生 control_response） | Claude 白名单控制；原生错误保留在 response.subtype |
| `thread/permission/set` | `{threadId, permission: Permission}` | `{thread: Thread}`\* | Claude 热切；提升类请求必须持 lease |
| `thread/effort/set` | `{threadId, maxThinkingTokens: number\|null, thinkingDisplay?: "summarized"\|"omitted"\|null}` | `JsonObject`（完整原生 control_response） | 非负整数预算，null 重置 |
| `thread/compact` | `{threadId, instructions?: string, clientTurnId?: string}` | `{turn: Turn, deduplicated?: true}` | 入正常 turn 队列发送 /compact |

\* `thread/permission/set` 复用了 `thread/start` 共用的 result 类型（zod 层面允许可选
`deduplicated`），但该方法没有幂等键，`deduplicated` 字段对它恒为 `undefined`，不代表协议赋予了幂等语义。

`thread/start` / `thread/resume` 不接受 `env`（未知字段返回 `-32602`）。

**执行模型守卫（Claude / Codex）**：`model?` 在 wire schema 中保留可选，是为了支持
daemon `config.toml` 的显式 `default_model`，不允许使用引擎/环境的隐式默认模型。
默认不配置 `default_model`，所以 `thread/start` 与导入未知 engineThreadId 的 resume
必须传非空 model。已知线程重启按「请求覆盖 → 持久化模型 → 配置默认」取值；fork
继承源线程持久化模型（旧数据缺失时可用配置默认）。每次新建/重启均在 spawn 前校验。
无法得到明确模型（含空白、无配置的 `"default"`）返回 `-32602`，
`data.reason = "model_required"`、`data.detail.hint` 提示传 model 或配置 default_model。
新建被拒时不写线程记录、不 spawn、不触发 thread/started。

`denied_models` 默认 `["fable", "claude-fable*"]`；忽略大小写，去掉首尾空白，
无通配符条目按前缀匹配，`*` 匹配任意长度、`?` 匹配单字符（通配模式匹配全名）。
自定义数组整体替换默认名单，`[]` 关闭名单；`default_model` 本身也受名单约束。
Claude 同时检查输入名及解析后的模型名，避免模型别名绕过。
命中返回 `-32602`、`data.reason = "model_denied"`，detail 包含
`backend/model/resolvedModel/pattern/hint`；同时发 `thread/engineEvent`，
subtype=`model_denied`，payload 为该 detail。通知遵守 engineEvents 能力协商及 optOut。
已有线程通知订阅者和未订阅的请求连接；新建被拒只通知请求连接，
`data.threadId` 和事件 threadId 是同一个尝试 ID，并无对应持久化线程。事件实时发送，不重放。
`set_model`、显式 resume.model（包括活进程 attach 请求）及 `turn/start.model`
同样检查名单，拒绝不会改变线程模型、恢复选项或 turn 队列。

`serviceTier?: "default"` 仅用于 Codex，持久化并传入引擎的 start/resume 与后续 turn；缺省仍选择 default 普通档。Claude start/resume 显式传该参数会返回 unsupported_capability，不能静默忽略。
`fjContext?: {root: absolutePath, cid: string, seat?: string}` 是受限坐席身份，禁止任意键。
cid 匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`，seat 另允许点号。root 经 realpath 与 allowed_roots 校验。
携带 fjContext 时 model 同样经守卫解析为明确模型（默认拒绝 fable），并必须显式 permission；Codex 必须 gpt-6-astra + serviceTier default。
上下文随 thread options 持久化，resume 使用原值，禁止覆盖 fjContext。引擎环境清除继承的 HERDR_* 与 FENJUE_*，仅映射 FENJUE_ROOT、FENJUE_CID、可选 FENJUE_SEAT；不改变 permission 或凭证路由。
thread.meta.fjContext 返回规范化后的身份（覆盖调用方同名 meta 键），供显示与身份核对。thread/close 尊重输入 lease，他端持有时返回 lease_held。
`thread/attach` 永远返回完整后缀，不接受 `limit`（`-32602`）；有界历史读取用 `thread/items/list`。
`thread/resume` 导入未知 engineThreadId 时必须显式传 cwd（缺失返回 `-32602`）；
恢复已知 thread 可以省略 cwd，沿用已保存的工作目录。
引擎启动环境只来自 daemon 的进程环境与服务端模型路由配置；客户端不能覆盖 PATH、凭证或加载器变量。
client 库与 TUI 共用这些参数类型，TUI 不提供环境覆盖选项。

`thread/fork` 的前缀按 item.seq 排序，包含 `fromItemId`；缺省为调用时最后一项。
源日志、队列、审批和引擎不变。新 thread 在 `thread/started` 前原子写入前缀，
继承 item ID、payload、时间戳、status、seq、completedSeq；turnId 重映射为新 ID，
继承 turn 作为已结束的历史容器，不入队、不携带 clientTurnId、usage 或审批。
允许运行中 fork：运行中 item 的 payload 是调用时冻结快照，不接收源后续 delta；
复制到分支的 `inProgress` item 状态改为 `failed`（该工作未在分支完成），播种历史也使用此状态。
源 item 不变；不伪造完成时间或完成事件，既有时间戳与游标保持原值。
新 thread 的 nextSeq = 前缀所有 seq/completedSeq 最大值 + 1（空前缀为 1），允许空洞，
之后只在新 thread 内递增。`thread/attach` / `thread/items/list` 可读完整继承历史，
不重新广播历史 item 事件。原 thread 后续增加的 item 不进入分支。

```ts
type ForkThreadParams = { threadId: string; fromItemId?: string; clientThreadId?: string };
type ForkedFrom = { threadId: string; itemId: string | null }; // 空源日志为 null
type Thread = {
  id: string; backend: "claude" | "codex" | "external"; engineThreadId: string | null;
  status: { type: "spawning" | "idle" | "running" | "interrupted" | "systemError" | "closed"; error?: RpcError };
  cwd: string; model?: string; title?: string; meta?: JsonObject; permission?: Permission;
  createdAtMs: number; closedAtMs?: number; clientThreadId?: string;
  forkedFrom?: ForkedFrom; // 新增可选字段，普通 thread 不变
};
// AgentClient.fork(params: ForkThreadParams): Promise<{ thread: Thread; deduplicated?: true }>
```

恢复路径（本机 bundle / schema 核验；真实引擎续聊复验另单）：

| 引擎 | 原生路径 | 任意 item 的播种路径 |
|---|---|---|
| Claude | 成功 turn 的末项记录末个非 tool-use assistant UUID；`--resume <session> --fork-session --resume-session-at <uuid>` 含尾截断；缺省 item 也使用捕获的精确坐标 | 新进程依序接收 stream-json 用户消息（`shouldQuery:false, client_composed:true`）与助手消息；每条用户等待无推理 result 后再继续。未续聊关闭的分支恢复时重播种 |
| Codex | `thread/fork {threadId,lastTurnId}` 截至已完成 turn（含）；缺省 item 也使用捕获的精确坐标 | `thread/start` 的 developerInstructions 携带角色标注的 JSON 历史数据；没有消息 history 导入参数。不会生成额外 AS 用户 item 或提前发起 turn |

缺少精确原生坐标时（包括空日志、旧会话和运行中边界）使用播种；不对可并发追加的源会话做无坐标 tip fork，避免原生加载时混入快照之后的新消息。
原生分支继承前缀内的原生坐标，支持再次原生分叉；播种分支不继承旧 session 坐标。
播种回退会在新分支的 `thread/started` 后发送 `thread/engineEvent`，subtype 为 `fork/seeded`，
payload 为 `{reason:"native_checkpoint_unavailable", sourceThreadId, itemId}`（包括尚未成功续聊落盘的 Claude 播种来源）；按 engineEvents 能力及 optOut 过滤。

播种只恢复 AS 可见内容：文字保留，工具调用/结果、reasoning 等序列化为历史文本，
不执行工具；图片/文件只保留路径与元数据，不重新读取原始字节。隐藏思考、原生压缩状态、
缓存、子进程/工具运行态和文件系统快照不恢复。Codex 的角色是文本标签，不能等价替代原生消息角色；
历史文本通过 developerInstructions 承载，明示为数据而非新指令，其优先级与压缩行为仍有差异。
播种本身不请求模型；后续请求会把前缀重新计入输入上下文，成本约随历史长度增长，
原生 prompt cache 命中不保证；过长历史可能触及模型窗口或引擎输入限制，不自动删减。
因此 `midThreadFork` 声明的是 AS 日志含尾快照与可续聊能力，不保证原生隐藏状态无损。

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

### 3.4 Backend-specific 逃生门语义

`thread/compact` `{threadId,instructions?,clientTurnId?}` → `{turn,deduplicated?}`，按正常 turn 队列发送用户文本 `/compact`（附 instructions）。本机 2.1.258 print.ts 的 control_request 子类型全集未发现 compact；因此这是 slash command 转发，不是虚构控制指令。沿用 turn 的排队、去重、lease 与完成事件，以及已有 compact_boundary → contextCompaction item。Codex 返回 backend_unsupported。
thread/start 与 resume 新增 autocompact：`"auto"` 或 100000–1000000 整数 token 数，透传 `--autocompact <auto|tokens>`（bundle CLI option 描述 100k–1M）；省略时保留原生默认值。
AS 有意只收明确 token 整数，不接受 CLI 的 `"500k"`、`"200"` 等缩写或数值 200/999；客户端须先转换为 500000/200000/999000。缩写、越界、小数均返回 -32602。此处是 AS 收窄的输入契约，不声称覆盖 CLI 所有字面写法。

UserInput 新增 `{type:"bash",command}`，仅支持 Claude 独立 turn/start（不混排、不 steer）。2.1.258 print.ts 分支 `if(d.type==="bash_command")` 调用 runHeadlessBashCommand；发 `{type:"bash_command",command,cwd,uuid}`，uuid 为原生 UUID。CLI 不发 result，而是 isReplay user 文本：bash-input 回显，以及 bash-stdout / bash-stderr / bash-exit-code 标签输出；daemon 聚合 commandExecution item 并结束 turn。非零退出标记 command item failed，turn 仍表示命令已执行完成；中断等待回放后结束。cwd 固定为 thread cwd。bash 是显式用户 shell 操作，不经过模型的 can_use_tool 审批。
客户端 initialize.capabilities.bashInput=true 声明可读此输入变体，新库默认声明；旧连接收到的 userMessage（含历史快照）降级为 `!command` 文本，落库仍保留原始 bash 变体。Codex 在入队前返回 backend_unsupported。

Claude 启动包含 `--forward-subagent-text`（2.1.258 flag 描述：转发带 parent_tool_use_id 的 assistant/user 帧）。正文和 thinking 按 parent_tool_use_id 聚合到现有 subAgent item 的可选 text/thinking 字段，同时放入 item/subAgent/progress 的 progress，支持快照恢复。各子 agent 与主线程的 partial 去重独立；正文先于 task_started 到达也保持同一 item 身份。

`thread/start` 的 effort 字符串透传 Claude `--effort <level>`。`thread/effort/set` `{threadId,maxThinkingTokens:整数|null,thinkingDisplay?:"summarized"|"omitted"|null}` → 原生 control_response，映射 `set_max_thinking_tokens {max_thinking_tokens,thinking_display?}`（2.1.258 print.ts 分派验证整数/null 与显示枚举）。这控制思考 token 预算，**不等价于** --effort 的模型推理档位；没有捏造 low/high 到 token 的换算。热切也可用 engineControl；turn/start 上不同 effort 标签会提示使用专用方法。热预算为当前 CLI 进程设置，不跨恢复持久化。
Claude effort 仅允许 low/medium/high/xhigh/max，非法值在 start/resume/turn 返回 -32602；合法但不同的 turn 标签仍返回 -32008。Codex 使用自身 effort 校验，不套 Claude 枚举。

`thread/permission/set`：`{threadId, permission}` → `{thread}`。Claude 原生模式 default / acceptEdits / plan / bypassPermissions / dontAsk 映射 --permission-mode，热切发送 set_permission_mode 的 mode 字段；CLI 成功确认后更新 thread.permission、持久化恢复选项，并发送 `thread/permission/changed` `{threadId,permission}`。turn/start.permission 也在发送用户帧前热切。原生拒绝不更新状态，返回 unsupported_capability。CLI 或组织策略仍可拒绝 bypass。
热切成功的返回 thread.permission、恢复选项和 permission/changed 均使用原生规范值：auto-edit → acceptEdits，full → bypassPermissions；不是请求别名的原样回显。启动状态仍保留调用方请求值，首次成功热切后归一化。
Claude 启动权限映射（本机 CLI 2.1.258）：所有模式保留 `--permission-prompt-tool stdio`，用于审批与原生模式热切。

| permission | `--permission-mode` | 注入 settings / disallowedTools | daemon 收到 `can_use_tool` |
| --- | --- | --- | --- |
| default（省略时同） | default（原生 manual 兼容名） | `{"permissions":{"ask":["*"]}}`，显式要求经纪人审批，覆盖本机 allow 规则 | 创建审批（只读 Bash 命令按 readonly_auto_allow 名单自动放行，见下） |
| acceptEdits / auto-edit | acceptEdits | 无；由原生模式允许编辑 | 创建审批（只读 Bash 命令按 readonly_auto_allow 名单自动放行，见下） |
| readonly | **default**（不是 plan，见下） | `{"permissions":{"ask":["*"]}}` + `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` | Write/Edit/MultiEdit/NotebookEdit 直接 reject 并留痕（见下）；Bash 走 readonly_auto_allow 名单，未命中则创建审批 |
| plan | plan（原生只读规划模式） | `{"permissions":{"ask":["*"]}}` + `--disallowedTools Edit,Write,MultiEdit,NotebookEdit` | 模型自主发起的 Bash 工具调用通常创建审批（只读命令按 readonly_auto_allow 名单自动放行），但原生 plan 对"看起来明显只读"的 Bash 调用有时会跳过 can_use_tool 直接执行，这一路径 agent-server 管不到（见下的"plan 已知限制"） |
| bypassPermissions / full | bypassPermissions | 无，尤其不注入 ask | 自动 allow，保留原始 input；不创建审批 |
| dontAsk | dontAsk | 无；原生允许已授权工具，拒绝需要询问的操作 | 自动 deny；不创建审批 |

**readonly 不再是 plan 的启动别名**（P0-1 修复，见 out/diagnosis.md）：诊断发现原生 plan 模式对 Bash 的 `can_use_tool` 询问由 CLI 内部启发式决定、agent-server 无法控制，且这一空当与 permission-mode 无关——`turn/start` 的独立 bash 输入（`{type:"bash"}`，映射为原生 `bash_command` 控制消息）在 default/plan 下都从不触发 `can_use_tool`。因此 readonly 现在启动时用 `--permission-mode default`（可靠触发 can_use_tool）叠加 `--disallowedTools Edit,Write,MultiEdit,NotebookEdit`（纵深防御：模型拿不到写工具）；readonly 线程收到 Write/Edit/MultiEdit/NotebookEdit 的 can_use_tool 请求时（万一原生仍转发）经纪人直接 reject 并发 `thread/engineEvent` subtype=`readonly_denied`（payload 含 requestId/toolUseId/toolName/permission/behavior=deny/reason=`readonly_write_tool`），同时写入 `approvals` 表一行（`kind='readonly_denied'`，`status='auto_denied'`），供事后审计。readonly 仍只接受 thread/start，不支持热切进入；热切请使用 plan。

**P1-1：`readonly_denied` 在真机通常不会出现，这不是回归**。`--disallowedTools` 在 CLI 侧把 Edit/Write/MultiEdit/NotebookEdit 从模型可见的工具 schema 里整个移除，模型根本不知道这些工具存在，所以 CLI 从不为它们发出 `can_use_tool`——上一段的 reject+`readonly_denied` 审计代码是纵深防御的第二层，只有在 CLI 未来某个版本仍把这类请求转发过来时才会执行。真机可观测的、每次都会发生的是**两层语义中更早的一层**：`ClaudeEngine.spawn` 在 readonly 线程启动时发一条 `thread/engineEvent`，subtype=`readonly_tools_disabled`，payload `{requestId,toolNames:["Write","Edit","MultiEdit","NotebookEdit"],reason:"disallowed_tools_flag"}`，记录的是"这个线程的写工具在 CLI 层已被整体禁用"这一结构性事实，而不是某一次具体尝试。它只在 spawn 时发一次（不按 turn/按尝试计数），此时还没有任何 turn 存在，因此写入 `approvals` 表一行时 `turn_id` 为 `NULL`（`kind='readonly_tools_disabled'`，`status='auto_denied'`，`item_id` 固定为 `'spawn'` 这个占位值，不对应真实工具调用）——`approvals.turn_id` 的 `NOT NULL` 约束已在 daemon 启动时的一次性表重建迁移中放宽为可空（旧库自动迁移，不丢历史数据），供事后（包括 spawn 之后才 `thread/attach` 的客户端，通过 `ItemLog.readonlyToolsDisabled(threadId)` 查询）审计。因此事后审计能回答"这个 readonly 线程的写工具从一开始就不可用"，但回答不了"模型是否真的尝试过写文件"——`--disallowedTools` 从模型的工具 schema 里就移除了它们，模型不会生成这类调用，daemon 也就没有"一次尝试"可记。plan 线程虽然也传了同样的 `--disallowedTools`，但只有 readonly 发 `readonly_tools_disabled`（plan 的已知限制单独记录在下文，两者不合并）。

**独立 bash turn 的门禁**（`ClaudeEngine.sendTurn` 新增 `gateStandaloneBash`）：`turn/start` 的 `input:[{type:"bash"}]` 从不经过原生 `can_use_tool`（见上），因此**所有**模式的独立 bash turn 都在写入子进程之前先过 `gateStandaloneBash`，而不是只有 readonly/plan（P0-2 修复前的实现只覆盖了这两种，default/acceptEdits 的独立 bash turn 曾经无门直接执行）：
- readonly / plan / default / acceptEdits：由 agent-server 自己对该命令跑一遍 `classifyReadonlyCommand`——命中只读名单直接放行并发 `readonly_auto_allow`（与 can_use_tool 路径相同的留痕：engineEvent + `approvals` 表一行）；未命中则创建 `item/commandExecution/requestApproval`，从不把命令写给子进程，被拒时该 turn 以 commandExecution 失败收尾。
- bypassPermissions / dontAsk：原生模式已经决定了结果（bypass 允许、dontAsk 拒绝），不创建审批、不占 pendingRequests，但发 `thread/engineEvent` subtype=`permission_auto_response`（payload 同下文 can_use_tool 路径的自动答复留痕），与 can_use_tool 途径的自动答复对称；两条路径的 `permission_auto_response` 都额外写入 `approvals` 表一行（`kind='permission_auto_response'`，`status` 按 behavior 取 `auto_allowed`/`auto_denied`，`decision_json` 含 toolName/permission/behavior），事后可查（P2-1）。

`readonly_auto_allow` 开关（daemon `config.toml`，见下）只决定「名单命中的命令是否可以免审」，从不决定「是否设门」（P0-1 修复：曾经关闭这个开关会连带让 readonly/plan 的独立 bash turn 完全不设门、命令直接执行）。关闭后，readonly/plan/default/acceptEdits 下的独立 bash turn 一律创建审批，即使命令本身只读；bypassPermissions/dontAsk 的自动答复语义不受这个开关影响。

五种模式下独立 bash turn（`input:[{type:"bash"}]`）的完整行为：

| permission | `readonly_auto_allow=true` 且命令命中名单 | `readonly_auto_allow=true` 但未命中 / `readonly_auto_allow=false` |
| --- | --- | --- |
| readonly | 直接放行，发 `readonly_auto_allow`（engineEvent + `approvals` 表一行） | 创建 `item/commandExecution/requestApproval`，命令不写给子进程 |
| plan | 同上 | 同上 |
| default | 同上 | 同上 |
| acceptEdits / auto-edit | 同上 | 同上 |
| bypassPermissions / full | 不查名单，直接放行，发 `permission_auto_response`（仅 engineEvent，不占 pendingRequests） | 同左（名单与开关都不影响这两种模式） |
| dontAsk | 不查名单，直接拒绝，发 `permission_auto_response`（仅 engineEvent，不占 pendingRequests） | 同左 |

**plan 的已知限制**：plan 面向需要原生"先出计划再执行"交互体验的用户，保留 `--permission-mode plan`。对独立 bash turn，agent-server 的门禁与 readonly 一致、完全兜底。但对模型在聊天中自主发起的 Bash 工具调用，原生 plan 模式有时会判定"这条命令明显只读"后直接执行、完全不发 `can_use_tool`（非确定性，由 CLI 内部启发式决定，agent-server 不可见也不可配置）——这条路径下 plan **不是** fail-closed 的。需要对聊天驱动的 Bash 调用也做到 fail-closed 时，请使用 readonly 而不是 plan。

旧值 full / auto-edit 分别映射 bypassPermissions / acceptEdits。只有启动 permission 显式为 full/bypassPermissions 才添加 `--allow-dangerously-skip-permissions`，允许之后重新进入 bypass；`--permission-mode bypassPermissions` 已选择绕过模式，不需要重复传 `--dangerously-skip-permissions`。其他会话不预先开放 bypass，CLI/组织策略仍可拒绝切换。

自动答复发生在 Claude adapter 将请求交给审批经纪人之前，因此 bypass/dontAsk 的意外原生请求不会写入 pendingRequests，也不会发审批通知；发送 `thread/engineEvent`，subtype=`permission_auto_response`，payload 含 requestId、toolUseId、toolName、permission（规范值）、behavior（allow/deny）、reason=`permission_mode`，可按现有 engineEvents 协商查看，同时写入 `approvals` 表一行（`kind='permission_auto_response'`，见上，与独立 bash turn 那条路径共用同一持久化，P2-1），进程重启后仍可查询。权限模式热切会清除 daemon 会话审批缓存，自动答复使用当前已确认的模式。启动注入的 settings 属于进程配置，热切不移除它；从 default 热切到 acceptEdits/plan 仍可能因 ask 规则要求审批，需要纯原生设置时新建相应模式线程。bypass 自动放行和 dontAsk 自动拒绝不受遗留 ask 规则影响。Codex 保持旧 permission 别名语义，新增 Claude 模式返回 backend_unsupported。

readonly-auto-allow 名单同样发生在这一步，且只对 readonly/default/plan/acceptEdits 生效（bypass/dontAsk 已经在上一段自动应答，不会再走到这里；`fileChange`/`item/permissions/requestApproval` 类请求不受影响，仍走原有审批路径，readonly 线程下 Write/Edit/MultiEdit/NotebookEdit 见上一段的直接拒绝）。独立 bash turn（`turn/start` 的 `input:[{type:"bash"}]`）不经过 can_use_tool，**所有**模式都改由 `gateStandaloneBash` 在写子进程之前跑同一个分类器，见上（P0-2 修复前只覆盖 readonly/plan，default/acceptEdits 的独立 bash turn 曾经无门直接执行）。判定器是 fail-closed 的白名单解析器（`readonly-commands.ts`），不是字符扫描式黑名单：命令先按一套刻意收紧的语法解析，**解析失败即判非只读**，而不是尝试识别已知的危险构造再放行其余部分。解析规则：反引号和 `$` 一律判非只读——无论是否在引号内（含单引号），覆盖命令替换 `$(...)` 与反引号形式、参数展开 `${...}`、算术展开 `$((...))`；未加引号的 `<`、`>`、`(`、`)` 一律判非只读（覆盖重定向、`2>/dev/null`、heredoc、子 shell、进程替换 `<(...)`/`>(...)`），同样字符出现在引号内则是普通字面量，不触发判定（如 `echo "a | b"` 仍判只读）；允许的连接符仅 `&&`、`||`、`|`、`;`、换行 `\n`/`\r`，单个 `&`（后台）与 `|&` 一律判非只读，不再当作"分隔正常段落"处理。解析成功后，每一段简单命令的 `argv[0]` 必须同时满足：不含 `/`（防止 `/bin/ls`、`./ls` 等路径冒用同名可执行文件）；不属于硬编码的包装命令黑名单 `env command exec xargs source . eval sudo doas time nice nohup sh bash zsh script expect`（这条独立于 `allow` 名单生效，即使自定义 `readonly_commands` 显式包含 `env` 之类的名字也一样拒绝，因为这些命令的本质就是把 argv 转交给另一个程序执行）；在默认名单 `ls cat head tail wc find grep rg pwd echo stat file which git` 内；且经真实 PATH 查找能解析到一个可执行文件，其所在目录属于配置的系统目录白名单（默认 `/bin /sbin /usr/bin /usr/sbin /usr/local/bin /usr/local/sbin /opt/homebrew/bin /opt/homebrew/sbin`）——这一步堵住"攻击者把恶意目录塞进 PATH 前部、让裸命令名解析到攻击者放的同名二进制"的路数；`env` 因为在硬编码黑名单里已不再出现在默认名单中。命中名单后按各命令的参数白/黑名单继续校验：`git` 不允许任何全局 flag（`argv[0]` 之后紧跟的第一个参数必须就是子命令本身，不能以 `-` 开头，这一条本身就堵死了 `--exec-path`/`--config-env`/`--git-dir`/`--work-tree`/`-C`/`-c` 等所有全局项），只认 `status/log/diff/show/rev-parse/branch` 子命令，其中 `log/diff/show` 额外拒绝 `--output`/`--output=<file>`，`branch` 仅纯列出形式判只读（无位置参数，且全部 flag ∈ `-a/-l/-r/--list/--show-current/-v`）；`find` 拒绝 `-delete`、`-fls`、`-fprint`/`-fprint0`/`-fprintf`、`-exec*`（含 `-execdir`）、`-ok*`（含 `-okdir`）等写标志（按前缀族匹配）；`rg`/`grep` 拒绝 `--pre`、`--pre-glob`、`--hostname-bin`（`=` 与空格两种写法），这三个是 ripgrep 对每个匹配文件执行外部命令的开关；`file` 拒绝 `-C`（编译 magic 文件到 `<path>.mgc`）或 `-m`（选择该可写 magic 路径）；`ls/cat/head/tail/wc/pwd/echo/stat/which` 没有已知的写盘/执行开关，不做额外参数校验（重定向已经在解析阶段被排除）。命中时直接 allow 并回填原始 input，发 `thread/engineEvent`，subtype=`readonly_auto_allow`，payload 含 requestId、toolUseId、toolName、permission、behavior=`allow`、reason=`readonly_command`、command、matchedRules（命中的子命令列表，如 `["git status","ls"]`），同样不创建 pendingRequests、不占审批队列；但会额外写入 `approvals` 表一行（`status='auto_allowed'`，`kind='readonly_auto_allow'`，`decided_at=created_at`，`decision_json` 含 command/matchedRules），使这条放行决策在进程重启后仍可查询「当时是哪条规则放的行」，不止是活跃连接上的一次性广播。daemon `config.toml` 可配 `readonly_auto_allow`（布尔，默认 true，关闭后全部回退正常审批）与 `readonly_commands`（字符串数组，整体替换默认名单，不是追加；`env` 等硬编码包装命令即使写进这个数组也仍会被拒绝）。系统目录白名单与 PATH 搜索目录目前只是 `classifyReadonlyCommand` 的函数级可选参数（供测试与未来按需接入 daemon 配置），尚未在 `config.toml` 中开放。

分词只按空格/制表符切分（不再用 JS 的 `\s`，避免把 bash 不当分隔符的 NBSP/U+2028/U+3000 等 Unicode 空白误判为分隔符，换行/CR 已单独处理），与真实 shell 的 IFS 语义对齐。`resolveExecutableDir` 的 PATH 查找按命令名在单次 `classifyReadonlyCommand` 调用内做了 memoize，避免长 `;` 链里同一个命令名重复 statSync（互不跨调用共享，因为不同调用可能传入不同的 `systemDirs`/`pathDirs`）。名单里的条目只有在真实解析到本机某个系统目录下的可执行文件时才会生效——例如没装 ripgrep 的机器上 `rg` 只是 shell 注入的函数，`resolveExecutableDir` 解析不到，会一直 fail-closed 落到审批而不是自动放行；`ClaudeEngine` 构造时对配置的名单跑一次 `unresolvableReadonlyCommands` 自检，把本机解析不到的条目打印一条 `console.warn`（进程级只打一次，不是每个 session 一次），提前暴露这类覆盖面缺口而不是等运营方从一堆意外审批请求里猜。

**已知限制**（不阻塞验收，记录在案）：
- shell 的名字解析顺序是函数 → 别名 → builtin → PATH，而 `resolveExecutableDir` 只验证 PATH 这一层；真正执行命令的 Bash 工具会 source 一份 shell snapshot，如果用户 rc 里对 `ls`/`cat`/`git` 等名单命令定义了同名函数或别名，分类器解析到系统目录下的真实二进制并放行，但实际跑的是那个函数/别名。利用它需要先能写用户的 rc 文件（链式放大器，不是一击绕过），不属于本次 fail-closed 承诺覆盖的威胁模型，但代码里 `resolveExecutableDir` 的注释不应被读成"端到端保证跑的就是这个二进制"。
- `find`/`rg`/`grep`/`file` 目前仍是黑名单（枚举已知写/exec 标志再拒绝），只有 `git branch` 是真正的白名单（任何非白名单 token 直接拒绝）。黑名单结构意味着这四个命令未来任何一个新增的、当前列表里没覆盖到的写/exec 标志都会被默认放行，风险模型上不如白名单稳固；这是结构性的技术债，未在本次一并重写（改动面与回归验证成本较高，且当前枚举已覆盖三轮渗透测试的全部已知向量），后续需要专门一轮把这四个命令的参数校验也改成"仅允许已知安全 flag，遇到未知 token 一律拒绝"。
对已有 thread，请求 full/bypassPermissions/dontAsk（或原生 ultraplan:true）必须由有效 lease 的持有者发起，覆盖 permission/set、engineControl.set_permission_mode、turn/start.permission 和 resume.permission；无 lease/已过期返回 unauthorized (-32005)，他人持有返回 lease_held (-32012)。持有 lease 不绕过原生 bypass availability/组织策略。普通输入和非提升模式继续使用可选 lease。

`thread/engineControl` 请求 `{threadId, subtype, params}`，向 Claude 发送 `{type:"control_request", request_id, request:{...params,subtype}}`，result 是完整原生 control_response 帧（包括原生 error response），不拆解 response；调用方必须检查 response.subtype。params 不得包含 subtype。该方法遵守输入 lease；Codex/external 返回 backend_unsupported，未知或不允许的子类型返回 unsupported_capability。传输超时仍为 RPC 错误。
set_model 成功时同步 thread.model 与持久化恢复选项，并发 thread/metadata/updated.model；失败不更新，resume 使用最后一次成功设置的模型。原生 2.1.258 Tf/Im 的省略/null 会重置引擎 default；AS 模型守卫拦截省略/null/`"default"`，仅在 daemon 配置 default_model 时替换成该明确模型再调用原生控制，无配置返回 `-32602`（model_required）。不会把隐式 `"default"` 持久化。

本机 Claude Code 2.1.258 `bin/claude.exe` 的 print.ts `d.request.subtype` 分派是白名单证据。允许：set_model、set_permission_mode、set_max_thinking_tokens、list_models、file_suggestions、read_file、get_workspace_diff、get_plan、get_context_usage、get_session_cost、get_usage、get_settings、get_binary_version、mcp_status、mcp_reconnect、mcp_toggle、interrupt、rewind_conversation、rewind_files、seed_read_state、background_tasks、stop_task、reload_plugins、reload_skills、side_question。参数语义由对应 Claude 版本定义；rewind_files 会修改工作区。interrupt 的 cancel_queued 只作用于 CLI 队列，AS 队列仍由 turn/cancel 管理。

其余一律明确拒绝，包括登录/OAuth、反馈、initialize、end_session、远程设备、MCP 凭证，以及会绕过 allowed_roots 或使 daemon 状态失配的 set_cwd、add_directory、settings 修改。此口是 backend-specific 能力，不承诺跨后端同义。

## 4. 通知（server → client）

`thread/engineEvent`：`{threadId, turnId?, backend, subtype, payload}`，payload 保留原始原生帧全部字段。Claude 的全部 system 子类型（包括未知类型）及 rate_limit_event、Codex 的原生通知走此通道；已建模事件仍照常发送。无活动 turn 时省略 turnId。此通知是实时流，不落 item 历史。
Claude 未知顶层 type 同样通过 engineEvent 原样上抛并继续会话；缺少字符串 type 的帧只发 willRetry:false 的 error 通知。JSON 解析失败及真实引擎 error 仍按原有失败路径处理。
客户端在 initialize.capabilities 声明 `engineEvents: true` 才接收此流；服务端通过 capabilities.engine.engineEvents 声明支持，新 client 库默认声明。旧客户端继续使用原有事件，协议版本保持 as/1。
门禁仅针对 thread/engineEvent。thread/permission/changed 仍发送给所有已 attach 且未 optOut 的连接，不要求新增能力；旧 client 按 AS v1 未知通知规则静默忽略，不会断线或报错。不能把此行为描述成“所有新通知默认对旧连接关闭”。

initialize.capabilities.engine 还声明 engineControl / permissionSet / effortSet / subAgentText / bashInput / compact 布尔标记（服务端至少启用 Claude 才为 true）；engineEvents 适用于两种原生后端。请求新增字段与通知信封使用 strictObject，原有宽松响应保持前向兼容。

只发给已 `thread/attach` 该 thread 的连接（除 `server/*` 与无 threadId 的服务级 `error`，
后者发给所有已完成握手且未 optOut error 的连接）。

### 4.1 thread 级

| 通知 | params | 何时 |
|---|---|---|
| `thread/engineEvent` | `{threadId, turnId?, backend, subtype: string, payload: JsonObject}` | 原生帧；仅协商 engineEvents=true 的连接，实时不回放 |
| `thread/permission/changed` | `{threadId, permission: Permission}` | 原生权限切换成功，随持久化状态更新发出 |
| `thread/pendingRequests` | `PendingRequestState`（下见类型块） | 每次创建、解决或撤回一个请求时，向所有 attach 且声明 pendingRequests 能力的客户端推送一条状态；不要求 serverRequests 能力 |
| `thread/started` | `{thread}` | 新 thread 建立（含别的客户端建的） |
| `thread/status/changed` | `{threadId, status: ThreadStatus}` | `spawning/idle/running/interrupted/systemError/closed` 迁移 |
| `thread/queue/changed` | `{threadId, queue: QueuedTurn[]}` | 入队 / 出队 / 取消。**带全量队列**（codex 只带 `threadId` 要客户端回查，见 §10.2） |
| `thread/closed` | `{threadId, reason}` | 进程回收 |
| `thread/tokenUsage/updated` | `{threadId, usage: Usage}` | 用量刷新 |
| `thread/metadata/updated` | `{threadId, engineThreadId?, model?: string, title?, meta?}` | 元信息改动，包括成功的 set_model |

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

Claude 不支持的反向 control request 会保守拒绝或取消，并发 `error`（`willRetry:false`）；这条通知不终止会话或当前 turn。未知子类型回复原生 error response，`prompt_suggestion` 等纯提示帧静默忽略。

## 5. 反向请求（server → client）

服务端向**所有声明了对应 capability 且已 attach 该 thread**的客户端发同一个
逻辑请求；每个连接看到自己的 `id`，但 params 里带同一个 `requestId`。

| 方法 | params 关键字段 | response |
|---|---|---|
| `item/commandExecution/requestApproval` | `{requestId, threadId, turnId, itemId, command, cwd, reason?, startedAtMs, data?}` | `{decision: "accept" \| "acceptForSession" \| "reject" \| "abort"}` |
| `item/fileChange/requestApproval` | `{requestId, threadId, turnId, itemId, changes, grantRoot?, reason?, startedAtMs, data?}` | `{decision: 同上}` |
| `item/permissions/requestApproval` | `{requestId, threadId, turnId, itemId, cwd, permissions, reason?, startedAtMs, data?}` | `{permissions: GrantedPermissions, scope:"turn"\|"thread"\|"session"}` |
| `item/tool/requestUserInput` | `{requestId, threadId, turnId, itemId, questions, isBlocking, data?}` | `{answers: {[questionId]: Answer}}` |

`data?: {raw: any}` 是四个反向请求共用的可选字段，透传引擎原生请求的未建模原始 payload；当前无调用方读取，仅供排障/未来扩展。

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
心跳续期，断线即释放。普通输入默认**不启用**；权限提升操作必须先取得 lease，见 §3.4 的权限语义说明。

**只读请求状态（规范性）**：`thread/pendingRequests` 是单请求增量，不携带整个 thread 或审批正文，也不授予答复权限。创建时 status=pending、decidedBy=null；首个合法回答落库后 status=resolved、decidedBy 为答复者的 clientId 与 label。超时、原生撤回、引擎退出或 thread 关闭统一 status=expired、decidedBy=null，reason 保留原因（如 timeout / orphan_timeout / engine_gone）。时间戳为服务端 Unix 毫秒；createdAtMs 固定为请求创建时间，updatedAtMs 为本次状态变更时间。

```ts
type PendingRequestState = {
  threadId: string; turnId: string; requestId: string; itemId: string;
  kind: "commandExecution" | "fileChange" | "permissions" | "userInput";
  status: "pending" | "resolved" | "expired";
  decidedBy: { clientId: string; label: string } | null;
  createdAtMs: number; updatedAtMs: number; reason?: string;
};
// 保持原有 method + params；attach 列表里的每条请求新增可选字段。
type PendingServerRequest = {
  method: ServerRequestMethod; params: ServerRequestParams;
  state?: PendingRequestState;
};
```

`thread/attach.pendingRequests` 始终是该 thread 的**完整未决列表**，不受 sinceSeq 影响；当前服务端为每条提供 status=pending 的 state。收到快照时替换该 thread 的请求状态，随后按 requestId 应用有序增量。状态通知不走 item seq，也不回放；断线后重新 attach 即可重建当前状态，离线期间已解决的请求不会出现在快照中，不能据此恢复历史 decidedBy。旧客户端可忽略新增 state，不声明能力就不会收到新通知；notifications.optOut 仍可退订。

未协商 pendingRequests 或通过 notifications.optOut 退订的连接，其 attach 快照保留完整未决请求，但不提供 state。
AgentClient 默认声明 pendingRequests，`onPendingRequests(state => ...)` 在更新 `pendingRequestStates` 只读表后触发（仅增量）；快照经 `onSnapshot` 触发时表已重建。表保留当前连接观察到的终态，直到该 thread 再 attach / detach，断线时清空；用 status=pending 筛出未决项。未协商能力（含旧服务端）或已 optOut 时此表保持为空。原 `pendingRequests` 表仍保存可答复的 ServerRequestHandle，签名不变。只读客户端不需要声明 serverRequests；初次 attach 和自动重连的快照均可建立状态。

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
| `subAgent` | `kind: "agent"\|"bash"\|"workflow"`、`parentItemId`、`phase`、`progress?`、`report?`、`text?: string`、`thinking?: string` | `task` 与带 parent_tool_use_id 的正文 | `subAgentActivity` / `collabAgentToolCall` |
| `webSearch` | `query`、`results?` | `tool_call(WebSearch)` | `webSearch` item |
| `imageOutput` | `paths: string[]` | `image_output` | `imageGeneration` item |
| `plan` | `text` / `steps` | `ExitPlanMode` 入参 | `plan` item |
| `contextCompaction` | `{}` | claude compact | `contextCompaction` item |
| `error` | `message`、`code?`、`retryable` | `error` 事件 | `error` 通知 |

`UserInput`：

```ts
type UserInput =
  | { type: "bash"; command: string }                // Claude 独立 turn/start
  | { type: "text"; text: string }
  | { type: "image"; path: string; mime: string }      // 本机绝对路径（见 §10.2）
  | { type: "file"; path: string; mime?: string; name?: string };

type Permission = "readonly" | "auto-edit" | "full" | "default"
  | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
type Autocompact = "auto" | number; // 整数 token 数，100000–1000000
// Thread.permission?: Permission；Thread.model?: string。
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
| `-32005` | `unauthorized` | token 错 / cwd 不在 `allowed_roots` / 提权未持有效 lease | 修认证或先获取 lease |
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
| `-32016` | `backend_unsupported` | 后端不支持所请求原生能力 | 检查 capabilities / backend |

`error.data` 约定：`{threadId?, turnId?, itemId?, retryable: boolean, detail?, reason?: string, stderr?: string, raw?: any, holder?: {clientId, label}}`。
提权缺少有效租约时 `reason` 为 `lease_required`；客户端按此字段区分其他 unauthorized 原因，不解析消息文案。该字段可选，旧客户端可忽略。
`stderr`/`raw`/`holder` 仅特定错误码使用：`-32004 engine_unavailable` 带 `stderr`（尾部日志），`-32015 engine_protocol_error` 带 `raw`（截断的原始帧），`-32012 lease_held` 带 `holder`（持锁者身份）。

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
- **进程崩溃边界**：服务端进程崩溃会丢失尚未完成 item 的内存 delta，
  重启后的失败 item 只含最后已持久化的 payload（可能是空正文）。恢复会把在途 turn/item
  标为 failed，并为 item 分配 completedSeq；这不是正常断线重连的补齐保证。
  当前不做 delta 检查点，也不会自动从引擎历史重建在途正文。
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
// 示例省略部分公共字段及 userMessage/reasoning/commandExecution 的完成通知；
// 它们仍分别消耗完成游标 2/4/6，item.seq 保留开始游标。
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{
  "threadId":"th_018f…","clientTurnId":"018f…b2",
  "input":[{"type":"text","text":"把 run-bus 的审批路径讲清楚"}]}}
{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"tn_018f…","threadId":"th_018f…","status":"inProgress","ordinal":1}}}

{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th_018f…","turn":{"id":"tn_018f…","status":"inProgress"}}}
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":1,
  "startedAtMs":1757000001000,
  "item":{"id":"it_1","type":"userMessage","payload":{"content":[{"type":"text","text":"把 run-bus …"}]}}}}
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":3,
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
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":7,
  "startedAtMs":1757000004000,"item":{"id":"it_4","seq":7,"type":"agentMessage","status":"inProgress","payload":{"text":""}}}}
{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"th_018f…","turnId":"tn_018f…","itemId":"it_4","delta":"审批路径分三段："}}
{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th_018f…","turnId":"tn_018f…","seq":8,
  "completedAtMs":1757000009000,
  "item":{"id":"it_4","seq":7,"completedSeq":8,"type":"agentMessage","status":"completed","payload":{"text":"审批路径分三段：…"}}}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th_018f…","turn":{
  "id":"tn_018f…","status":"completed","durationMs":8100,
  "usage":{"inputTokens":12043,"outputTokens":866,"cachedTokens":11200,"cacheCreation":0,"contextTokens":13210}}}}
{"jsonrpc":"2.0","method":"thread/status/changed","params":{"threadId":"th_018f…","status":{"type":"idle"}}}

// ── 6. 另一个客户端中途 attach（拿快照）
{"jsonrpc":"2.0","id":9,"method":"thread/attach","params":{"threadId":"th_018f…","sinceSeq":0}}
{"jsonrpc":"2.0","id":9,"result":{
  "thread":{"id":"th_018f…","status":{"type":"idle"},"backend":"claude"},
  "items":[/* item.seq = 1,3,5,7; completedSeq = 2,4,6,8 */],"nextSeq":9,"queue":[],"pendingRequests":[]}}
```

## 12. 未定项（v1 冻结前要拍板）

- `agentMessage` 的**分层偏移**（Trellis 的 `finalStart`）要不要进协议。倾向
  不进：那是渲染策略，客户端可以按 item 边界自己算（有了 item 模型，
  「最终答复 = 最后一个 agentMessage item」天然成立，`finalStart` 这个补丁可以整个消失）。
- 用量字段是否直接复用 `packages/agent` 的 `Cost`（`usd/inputTokens/outputTokens/
  cachedTokens/cacheCreation/estimated/contextTokens`）。倾向复用，只把 `usd`
  标为可空。
