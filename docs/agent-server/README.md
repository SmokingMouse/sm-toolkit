# agent-server 设计（总览）

> 本机 daemon：独占每个 thread 的引擎子进程，把引擎事件落成持久化的 item 日志，
> 让任意数量的薄前端（网页 / 手机 / 飞书 / TUI）attach 同一份会话。
>
> 状态：AS v1 已实现，代码位于 `packages/agent-server`（协议、引擎、服务、client）+
> `apps/agent-tui`（TUI 客户端）；复用 `packages/agent` 的模型路由。
> 协议以 [protocol.md](protocol.md) 为准，运行说明见 [包 README](../../packages/agent-server/README.md)。
> 相关历史决策见 `progress/decisions.md`（2026-08-04 推迟 app-server、2026-08-18 解除推迟）。

---

fj dogfood：受限 fjContext、显式启动模型/权限、agent-tui ready/首轮交接已接入；部署模板见 [LaunchAgent](../../scripts/agent-server/README.md)。真实坐席试点与 Trellis 集成仍由各自主控推进。

## 1. 目标

**一句话**：把「谁来启动和读写 CLI 引擎进程」这件事从每个前端手里收回到一个本机
daemon，前端退化成同一份会话日志的渲染器。

具体要达成的：

1. **引擎进程的唯一所有者**。`claude` / `codex` 子进程只由 agent-server 启动，
   只有它读 stdout、写 stdin。任何前端都不再自己 spawn。
2. **多轮不重启**。Claude 走 Agent SDK 的双向 stream-json（stdin 常开、control
   protocol 握手），一个 thread 一个进程跑完整个会话；Codex 走 app-server 协议
   （`thread/start` + 多次 `turn/start`），同一进程复用。冷启动、prompt cache
   重建、`--resume` 重放历史的成本从「每轮一次」降到「每 thread 一次」。
3. **第二个 resume 变 attach**。服务维护 `threadId → 活进程` 登记表；对一个已在
   跑的 thread 再发 `thread/resume`，返回的是同一个 thread 的句柄 + 快照，而不是
   第二个进程。这是今天 Trellis 「同一会话别在 CLI 和 trellis 同时聊」这条物理
   约束的正解。
4. **事件即日志**。引擎事件归一成 **item**（userMessage / agentMessage /
   reasoning / commandExecution / fileChange / mcpToolCall / subAgent / …），
   带单调 `seq` 落 sqlite。客户端 attach 时先拿快照，再收增量通知；断线重连按
   `sinceSeq` 重放，不丢不重。
5. **多前端同时在场**。同一 thread 可以同时被网页、手机、飞书群、TUI 打开，
   各自渲染同一份 item 日志。谁都能发起下一轮，谁都能看到别人发起的轮次。
6. **审批与提问是广播 + 竞答**。工具审批 / AskUserQuestion 是服务发给**所有**
   已 attach 客户端的反向请求；先答的生效，其余客户端收到 `serverRequest/resolved`
   自动撤卡。可选的输入租约（input lease）用于「我先接管这个 thread」的场景。
7. **协议向 codex app-server v2 对齐**。方法名、通知名、item 形状尽量取
   codex app-server v2 的**子集**，差异逐条标注（见 `protocol.md` §10）。目的是：
   未来要么把 codex 的原生协议直接透出，要么把自己的客户端指向 codex 官方
   app-server，两个方向的迁移成本都最小。

## 2. 非目标

明确**不做**的事，避免设计发散：

- **不做跨机 / 公网**。只监听本机 unix socket 与 loopback。远端接入是 Trellis 的
  多租户网关（`tenancy/`）与 Harbor 的事，不在这一层。
- **不做多用户与权限模型**。单机单人，鉴权只是「防止本机其它进程乱连」的
  bearer token，不是租户隔离。
- **不替代 Herdr**。Herdr 管的是终端 pane 与人在终端里的交互；agent-server 管的是
  headless 引擎进程。两者的交集只有一个方向：Herdr 里跑着的会话可以作为
  **外部提供者**被 ingest 成只读 item 日志（§8.1）。
- **不做模型路由 / endpoint 解析**。那是 `@smokingmouse/llm` + `ClaudeBackend` 内部
  已有的职责，agent-server 只透传 `model` 字符串。
- **不做 UI**。本仓只出协议、daemon、TUI 参考客户端。网页 / 手机 / 飞书渲染
  仍在 Trellis。
- **不做 codex app-server 的全量协议**。99 个 client request、81 个 server
  notification 里绝大多数（marketplace / plugin / fs / account / realtime…）不进
  子集，只取 thread/turn/item 三族 + 必要的反向请求。
- **不做会话内容的语义加工**（自动命名、topic label、摘要）。那是上层产品逻辑，
  留在 Trellis / 客户端侧。

## 3. 架构

```
        ┌── Trellis web ──┐   ┌── 手机 (PWA) ──┐   ┌── 飞书 bot ──┐   ┌── TUI (apps/agent-tui) ──┐
        │  React + SSE 桥  │   │   WebSocket    │   │  长连或轮询   │   │   NDJSON / unix socket   │
        └────────┬────────┘   └───────┬────────┘   └──────┬───────┘   └────────────┬─────────────┘
                 │                    │                   │                        │
                 └────────────────────┴───────┬───────────┴────────────────────────┘
                                              │  AS Protocol v1
                                              │  (NDJSON over unix socket | WebSocket + bearer token)
                     ┌────────────────────────┴─────────────────────────────┐
                     │                    agent-server                       │
                     │                                                       │
                     │  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
                     │  │  Transport   │  │  Session      │  │  Item Log   │  │
                     │  │  (socket/WS  │──│  Registry     │──│  (sqlite)   │  │
                     │  │   + auth)    │  │ threadId→proc │  │ seq 单调     │  │
                     │  └─────────────┘  └───────┬──────┘  └─────────────┘  │
                     │  ┌─────────────┐          │          ┌─────────────┐  │
                     │  │  Approval    │          │          │  Turn Queue │  │
                     │  │  Broker      │──────────┼──────────│ 一 thread   │  │
                     │  │ (广播/竞答)   │          │          │  一轮 + steer│  │
                     │  └─────────────┘          │          └─────────────┘  │
                     └───────────────────────────┼─────────────────────────────┘
                                                 │  EngineSession 抽象
                    ┌────────────────────────────┼──────────────────────────────┐
                    │                            │                              │
          ┌─────────┴──────────┐      ┌──────────┴─────────┐        ┌───────────┴──────────┐
          │ ClaudeSession       │      │ CodexSession        │        │ ExternalSession       │
          │ claude CLI          │      │ codex app-server    │        │ (Herdr pane / CLI     │
          │ stream-json 双向     │      │ JSON-RPC v2 stdio   │        │  jsonl 尾随，只读)     │
          │ stdin 常开、多轮      │      │ thread/* + turn/*   │        │                       │
          └────────────────────┘      └────────────────────┘        └──────────────────────┘
```

### 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| **Transport** | unix socket + WebSocket 监听、bearer token 校验、NDJSON 分帧、每连接一个 `clientId` | 业务语义 |
| **Session Registry** | `threadId → EngineSession` 的唯一登记表；`thread/start` 建、`thread/resume` 命中即 attach；进程死亡时标记 `systemError` 并广播 | 决定引擎参数 |
| **EngineSession**（接口） | `open()` / `startTurn()` / `steer()` / `interrupt()` / `close()`；把后端原生事件归一成 item 生命周期回调 | 持久化、广播 |
| **Item Log** | sqlite 落 `threads / turns / items / approvals`；分配单调 `seq`；提供快照与 `sinceSeq` 重放 | 渲染 |
| **Turn Queue** | 一 thread 一个 in-flight turn，其余排队；`thread/queue/changed` 通知；`turn/steer` 插话到当前轮 | 引擎细节 |
| **Approval Broker** | 引擎的审批 / 提问 → 广播给所有 client 的反向请求；先答生效；其余 `serverRequest/resolved` 撤卡；超时 / 全体断线的兜底策略 | 决策本身 |

### EngineSession 与现有 `Backend` 的关系

`packages/agent` 今天的契约是 `Backend.run(prompt, RunOptions) → AsyncGenerator<AgentEvent>`
——**一次 run 一个进程、一轮结束进程退出**（`claude.ts` 在 result 后关 stdin；
`codex-app-server.ts` 是 per-run spawn）。agent-server 需要的是长活会话，所以要在
`packages/agent` 里新增一层，而不是把 `Backend` 改坏：

```ts
export interface EngineSession {
  readonly threadId: string;
  readonly backend: "claude" | "codex" | "external";
  open(opts: SessionOptions): Promise<void>;          // spawn + 握手（+ resume）
  startTurn(input: UserInput[], o?: TurnOptions): Promise<{ turnId: string }>;
  steer(turnId: string, input: UserInput[]): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  close(reason: string): Promise<void>;
  readonly events: AsyncIterable<ItemEvent>;          // item 生命周期 + delta
  onApprovalRequest(h: ApprovalHandler): void;        // 反向请求出口
}
```

- `ClaudeSession`：复用 `ClaudeBackend` 已有的 stream-json 输入、control protocol
  initialize 握手、`can_use_tool` 回调三件套（`backends/claude.ts` 已全部具备），
  改动是 **turn 结束不关 stdin**，而是等下一条 user message；`AgentEvent` →
  item 的映射在 server 侧做。
- `CodexSession`：复用 `codex-app-server.ts` 的 JSON-RPC 客户端与审批映射，
  把 per-run spawn 提升为常驻，`thread/resume` + 多次 `turn/start`。codex 的
  item 模型天然就是目标模型，映射近乎恒等。
- `ExternalSession`：不 spawn 任何东西，尾随外部产生的 transcript（Claude 的
  `~/.claude/projects/**.jsonl`、codex 的 `~/.codex/sessions/**.jsonl`），把它
  解析成同一套 item（详见 §8.1）。

`Backend.run()` **保留不动** —— 一次性任务（Trellis 的自动命名、topic label、
Harbor 的批处理）继续用它，不该为了长会话把简单场景也拖进 daemon。

## 4. 生命周期

### 4.1 thread

```
  thread/start ──► spawning ──► idle ◄──────────────┐
                      │           │                 │
                      │           ├─ turn/start ──► running ──► turn/completed ─┘
                      │           │                 │
                      │           │                 └─ turn/interrupt ──► interrupted ─┘
                      ▼           ▼
                 systemError   thread/close ──► closed
```

- **spawning**：进程起来 + 握手（claude 的 control initialize / codex 的
  `initialize` + `initialized`）。握手失败 → `systemError`，thread 行仍留在库里。
- **idle**：进程活着，没有 in-flight turn。这是可以 attach、可以排队的稳态。
- **running**：有一个 in-flight turn。新的 `turn/start` 进队列；`turn/steer` 直接
  插给当前轮。
- **closed**：显式 `thread/close`、或空闲超时（默认 30 min，可配）回收进程。
  **item 日志不删** —— 下次 `thread/resume` 重新 spawn 并把日志接上。
- **进程意外死亡**：Registry 收到 exit → 未完成的 turn 标 `failed`、所有 pending
  审批以 `engine_gone` 拒答、广播 `thread/status/changed{status:systemError}`。
  客户端可以再发 `thread/resume` 重启（历史由引擎自己的 resume 机制承接）。

### 4.2 turn

`queued → running → (completed | interrupted | failed)`。

- 一个 thread 同时只有一个 `running` turn。这是引擎的物理约束（两条 prompt 同时
  写进一个 stdin 会互相踩），不是策略选择。
- 队列是 FIFO；`thread/queue/changed` 在入队 / 出队 / 取消时广播。
- `turn/steer` 不排队：它把内容插进**当前正在跑的** turn（claude 走 stdin 追加
  user message，codex 走原生 `turn/steer`），带 `expectedTurnId` 前置条件防止
  插错轮。

### 4.3 item

`item/started → (delta…) → item/completed`。

- `started` 时 item 已经落库（带 `seq`），保证「先落库再广播」——任何 attach 的
  快照要么包含它，要么随后收到它的通知，不会两头都漏。这条纪律直接抄 Trellis
  run-bus 里已经验证过的 commit-before-broadcast。
- delta 通知（`item/agentMessage/delta`、`item/reasoning/textDelta`、
  `item/commandExecution/outputDelta`）**默认不落库**，只广播；`item/completed`
  带全量文本落库。这样断线重连拿快照即可，不必重放 delta 流。

### 4.4 client

`connect → initialize(协商 + 鉴权) → thread/attach* → …ded`。

一个连接可以 attach 多个 thread；断开时自动 detach，但**不影响 thread 生死**
（这正是 Trellis Stage 17 durable stream 想解决的问题，在这里是天然属性）。

## 5. 持久化

sqlite 单库，默认 `~/.agent-server/agent-server.db`（WAL）。

| 表 | 关键列 | 说明 |
|---|---|---|
| `threads` | `id` PK、`backend`、`engine_thread_id`、`cwd`、`status`、`created_at`、`client_thread_id`、`request_json`、`options_json`、`data_json`、`next_seq` | model/title/meta 等存在 data_json；engine_thread_id 是 resume 的钥匙 |
| `turns` | `id` PK、`thread_id`、`ordinal`、`status`、`client_turn_id`、`request_json`、`data_json` | client_turn_id 唯一索引用于幂等；usage/时间/error 在 data_json |
| `items` | `(thread_id, id)` PK、`seq`、`completed_seq`、`turn_id`、`type`、`status`、`payload_json`、`started_at`、`completed_at` | seq 与 completed_seq 共用 thread 内单调序列；UNIQUE(thread_id, seq)，正文完成游标用于断线补齐 |
| `approvals` | `id` PK、`thread_id`、`turn_id`、`item_id`、`kind`、`params_json`、`status`、`decided_by`、`decision_json`、`created_at`、`decided_at` | 竞答的仲裁点；重启后 pending 一律标 `expired` |
| `queue` | `turn_id` PK、`thread_id`、`ordinal`、`enqueued_at`、`preview` | 持久化 FIFO，重启后保留排队轮次 |

clients 与 leases 只在内存中维护，不建 sqlite 表；连接退出释放租约。

**不存**：delta 流水、引擎原始 stdout（要排查用 `--trace-dir` 单独落文件，默认关）。

**引擎自己的落盘仍是真源之一**：claude 的 jsonl、codex 的 rollout 依然存在，
agent-server 的 item 日志是**渲染用的镜像**。冲突时以引擎侧为准 —— 这条纪律
让「用户直接在终端里 `claude --resume` 同一个 session」不会把库写坏（会被
ExternalSession 的尾随同步补上）。

## 6. 安全

- **监听面**：默认只有 unix socket `~/.sm-toolkit/agent-server.sock`（mode 0600）。
  `AGENT_SERVER_SOCKET_PATH` 可覆盖；否则优先使用 XDG_RUNTIME_DIR / XDG_STATE_HOME
  下的 `sm-toolkit/agent-server.sock`。WebSocket 监听 `127.0.0.1:<port>`，
  endpoint 写进 `<socket>.endpoint.json`（0600）。数据库及 WAL/SHM 也是 0600。
  不绑 `0.0.0.0`，没有 TLS —— 要走公网请套 Trellis 的网关。
- **鉴权**：单个 bearer token，随机 32 字节，落 `~/.agent-server/token`（0600），
  daemon 首次启动生成。WebSocket 在 `initialize` 的 params 里带（浏览器不能设
  自定义 header 走 WS 握手），unix socket 也校验（防同机其它用户）。
  token 轮换 = 删文件重启 daemon。
- **审批不是装饰**：`permission` 策略、`askTools` 的注入语义原样沿用
  `RunOptions`。已验证的坑必须在文档里钉死（`progress/facts.md`）：
  设备全局 `~/.claude/settings.json` 的 `permissions.allow` 会让 `can_use_tool`
  永不触发，所以要真审批必须注 `permissions.ask:["*"]`；「哪些工具免审」的判断
  留在 server 的 Approval Broker（对应 Trellis 今天的 `READONLY_AUTO_ALLOW`）。
- **危险面收口**：`thread/start` 的 `cwd`、`sandbox`、`permission` 由客户端给，
  但 daemon 有一份 `~/.agent-server/config.toml` 的允许列表（`allowed_roots`）；
  不在列表内的 cwd 直接 `-32005 unauthorized`。默认允许 `$HOME` 下、拒绝 `/`。
- **审批决策要留痕**：`approvals.decided_by` 记 clientId + label，飞书 / 手机上
  谁点的批准，事后可查。

## 7. 客户端（薄前端）

| 客户端 | 传输 | 特点 |
|---|---|---|
| **Trellis 网页** | 服务端 Next.js 进程作为 agent-server 的客户端，浏览器仍走现有 SSE | 迁移成本最低：`run-bus` 从「跑引擎」降级为「转发 item 通知」 |
| **手机** | WebSocket 直连（同一 token，经 Trellis 网关反代） | 断线重连靠 `sinceSeq`，不需要专门的 catchup 端点 |
| **飞书 bot** | 服务端长连；审批卡即反向请求的渲染 | 撤卡 = 收到 `serverRequest/resolved` 后 update 卡片为「已由 X 处理」 |
| **TUI**（`apps/agent-tui`） | unix socket + NDJSON | 在 Herdr 内运行时用 `pane.report_agent_session` 报告自己代理的会话，并按 Herdr 约定报状态（busy / waiting-input / idle），让 Herdr 的 pane 状态与 thread 状态一致 |

TUI 是**参考实现**：协议的每个方法都要有它能打的路径，否则说明协议有洞。

## 8. 与 Herdr / Trellis / 飞书的关系

### 8.1 Herdr —— 外部提供者

Herdr 的 pane 里跑着的是**人在终端里手起的** `claude` / `codex`，agent-server
既不能也不该抢过来。所以它们以「外部提供者」的身份进同一套模型：

- `ExternalSession` 尾随 transcript 文件（claude jsonl / codex rollout），解析成
  item，写进同一份日志，`threads.backend = "external"`。
- 这类 thread **只读**：`turn/start` 返回 `-32008 unsupported_capability`。
- 审批仍可用：Herdr 桥可以把 pane 里的审批 prompt 通过 herdr CLI 探针转成
  `item/permissions/requestApproval` 反向请求，用户在手机 / 飞书上批完，桥再把
  按键写回 pane。这样「人不在电脑前，pane 卡在审批上」有解。
- 反过来，agent-server 起的 thread 可以被 Herdr 看见：TUI 客户端在 pane 里跑时
  `pane.report_agent_session`，Herdr 的编队视图就能把 daemon 里的 thread 当成
  一个正常坐席显示。

### 8.2 Trellis —— 第一个真实消费者

Trellis 今天自己 spawn 引擎（`lib/llm/claude.ts` / `codex.ts` → `Backend.run`），
自己维护 run 生命周期（`lib/server/run-bus.ts`），自己落库（`nodes.response` +
`tool_calls_json`）。迁移后这三件事都下沉到 agent-server，Trellis 只保留
**树形结构 / 分叉 / 工作区 / 任务 / 飞书**这些产品语义。详见 `trellis-migration.md`。

一条边界要先说清：**Trellis 的「树」不进协议**。分叉是 Trellis 的产品概念，
在协议里表达为「用 `thread/fork` 从某个 item 开一条新 thread」，节点 ↔ thread
的映射表留在 Trellis 侧。agent-server 只认线性 thread + item 日志。

### 8.3 飞书 —— 只是一个客户端

今天飞书链路（`lib/server/lark/handler.ts`）自己调 `startRun`，等于第二个
引擎启动者。迁移后它变成一个普通客户端：收到消息 → `turn/start`；收到
`item/agentMessage/delta` → 攒够一段发消息；收到反向请求 → 发审批卡。

## 9. 分阶段路线

| 阶段 | 交付 | 完成判据 | 状态 |
|---|---|---|---|
| **P0 协议冻结** | `protocol.md` 的方法 / 通知 / item 表 + TypeScript 类型包 `@smokingmouse/agent-protocol` + JSON schema 导出 | 类型包能被 Trellis 与 TUI 同时 import；schema 与 codex v2 的差异表逐条有理由 | 已完成 |
| **P1 单后端 daemon** | Session Registry + Item Log + Turn Queue + unix socket 传输；只支持 `backend:"codex"`（app-server 协议映射最短） + TUI 客户端 | TUI 能开 thread、连发三轮不重启进程、断开重连补齐、`turn/interrupt` 生效 | 已完成 |
| **P2 Claude 长会话** | `ClaudeSession`：stdin 常开跨轮、control protocol 复用、`can_use_tool` 接进 Approval Broker | 同一进程跑完五轮；审批在两个客户端同时弹、先答生效另一个撤卡 | 已完成（`engines/claude.ts` 常驻单进程 + 测试覆盖） |
| **P3 WebSocket + 鉴权 + 多客户端** | WS 传输、token、`serverRequest/resolved`、可选 input lease | 手机 + TUI 同时 attach 同一 thread，双方看到同一份日志 | 已完成（`transport/websocket.ts` + `LeaseManager`/`ApprovalBroker` 已接线，见[包 README](../../packages/agent-server/README.md)） |
| **P4 Trellis 迁移第一步** | Trellis 的 project 模式改走 agent-server（chat 保持原路） | 见 `trellis-migration.md` 第一步验收 | 进行中（Trellis 分支实测，细节见 `trellis-migration.md`） |
| **P5 外部提供者** | `ExternalSession` + Herdr 桥审批回写 | pane 里的 codex 会话在手机上可读、可批 | 未开始 |
| **P6 飞书 / 手机客户端切换** | 飞书 handler 与手机 PWA 改走协议 | Trellis 侧不再有第二个 `startRun` 调用点 | 未开始 |

**顺序理由**：先 codex 不是因为它更重要，而是因为它的原生协议就是目标形状，
P1 能用最少的映射代码把 daemon 的骨架（登记表 / 日志 / 队列 / 重连）压出来；
Claude 的长会话改造是真正的新代码，放在骨架稳定之后。

## 10. 已知风险

1. ~~**Claude 跨轮 stdin 常开未实测**~~ **已解决**：`engines/claude.ts` 的
   `ClaudeEngine` 是常驻单进程架构，`spawn()` 只调用一次，`steer()` 与队列里的
   后续轮次都直接 `write()` 到同一个 `stdin`，`close()` 才 `stdin.end()`；该
   路径已随 fj dogfood（agent-tui ready/首轮交接）投入真机验证，不再是未验证假设。
2. **codex app-server 协议无兼容承诺**。锁 schema 版本 + check-codex-alignment
   检查协议名字和必填字段差异；启动时核对版本，未知 item/request 发 -32015 并保留 thread。
   当前没有 exec 路径自动兜底。
3. **两个真源**（item 日志 vs 引擎 jsonl/rollout）的漂移。缓解：日志只做镜像，
   任何「历史内容」的权威读取走引擎侧；ExternalSession 负责把外部写入补回来。
4. **审批广播的安全含义**：任何 attach 的客户端都能批准危险命令。缓解：
   `allowed_roots` 收口 + `decided_by` 留痕 + 可选 input lease 把审批权限
   收给持锁客户端。
