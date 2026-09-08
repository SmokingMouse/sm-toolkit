# Trellis → agent-server 迁移

> 把 Trellis 从「引擎的启动者」改造成「协议的客户端」。
> 前置阅读：`README.md`（架构与阶段）、`protocol.md`（AS Protocol v1）。
>
> 立场：**Trellis 不重写**。它的产品价值在树形画布、workspace/project 层级、
> 自定义 agent、自动化任务、飞书入口；这些一行不动。要下沉的只有
> 「谁 spawn 引擎、谁维护 run 生命周期、谁把事件落库」这三件事。

---

## 1. 现状盘点

Trellis 今天有**三个**独立的引擎启动点，都直接调 `startRun`：

| 入口 | 文件 | 触发 |
|---|---|---|
| 网页 / 手机 | `app/api/chat/route.ts:762` | 用户提问 / 分叉 / 重试 |
| 自动化任务 | `lib/server/tasks.ts:647` | cron / 文件变更 / git push / session_done 触发器 |
| 飞书 | `lib/server/lark/handler.ts:344` | 群里 @bot 或 DM |

三条链路共用 `lib/server/run-bus.ts`（1032 行）：AbortController、
committedText/committedToolCalls 镜像、catchup 快照、审批 dispatcher、
finalize + 一串 post-done 对账钩子。

引擎接入在 `lib/llm/{claude,codex}.ts` → `lib/llm/sdk-adapter.ts` →
`@smokingmouse/agent` 的 `Backend.run()`：**每轮一个进程**，靠
`--resume` / `thread/resume` 把历史接回来。

## 2. 映射表：现有机制 → 协议的哪一部分

### 2.1 run-bus

| run-bus 里的东西 | 映射到 | 备注 |
|---|---|---|
| `startRun({nodeId, factory, …})` | `turn/start`（thread 由 nodeId→threadId 映射解析） | Trellis 侧退化成「解析 threadId + 发一个 RPC」 |
| `RunState.controller` / `abortRun` | `turn/interrupt` | 不再由 Trellis 持有进程句柄 |
| `subscribe(nodeId, sub)` + `CatchupEvent` | `thread/attach{sinceSeq}` 的 result | 快照语义完全一致，`catchup.response` ↔ 聚合 `agentMessage` item |
| `committedText` / `appendNodeResponse` | `item/agentMessage/delta` + `item/completed` | Trellis 仍写 `nodes.response`（见 §3.1 双写） |
| `committedToolCalls` / `tool_calls_json` | `item/started` + `item/completed`（`commandExecution` / `fileChange` / `toolCall` / `mcpToolCall`） | `ToolCall.status/durationMs` 由 item 的 `status/completedAtMs` 推出 |
| `committedThinking`（内存、不落库） | `reasoning` item + `item/reasoning/textDelta` | 协议里 reasoning 是**一等 item**，Trellis 可以选择仍不落库 |
| `pendingAgentPatches` / `tool_call_update` / `TaskMeta` | `subAgent` item + `item/subAgent/progress` | 「慢 Bash 被当成子 agent」的老坑在协议里由 `payload.kind` 显式区分 |
| `finalStart` / `pendingBreak` 段落状态机 | **可以整个删掉** | 有了 item 边界，「最终答复 = 最后一个 `agentMessage` item」天然成立（`protocol.md` §12） |
| `interaction_required` / `interaction_resolved` / `PendingInteraction` | 反向请求 `item/tool/requestUserInput`（AskUserQuestion / ExitPlanMode）+ 三个 `requestApproval` | Trellis 从「持有 resolver」变成「转发决策」 |
| `INTERACTIVE_TOOLS` / `READONLY_AUTO_ALLOW` / `approvedTools` | Approval Broker 的免审名单 + `acceptForSession` | **策略下沉到 daemon**：免审名单是「哪些工具不值得打扰人」，与 UI 无关 |
| `resolveInteraction(nodeId, toolUseId, answer)` | 对反向请求的 JSON-RPC response | `no_run/no_pending/mismatch` 三态 → `-32001 / -32014 / -32014` |
| `finalizeNode` + usage | `turn/completed`（`turn.usage`） | |
| `onSettled` / `topicLabel` / `sessionTitle` / `reconcileAttachedTurn` / `backfillNativeTurnUuid` / `backfillCodexTurnOrdinal` / `onNodeSettled` | **留在 Trellis**，改挂在 `turn/completed` 通知的处理里 | 这些全是 Trellis 产品逻辑，不进协议 |
| `CLEANUP_GRACE_MS` 30s 内存窗 | **删掉** | 日志持久化后没有"grace window"概念，`sinceSeq` 永远可用 |
| `getActiveRuns()` | `thread/list{status:"running"}` | 管家页数据源 |

### 2.2 sessions / nodes 表

| Trellis 列 | 映射 | 处理 |
|---|---|---|
| `nodes.claude_session_id` / `codex_session_id` | `threads.engine_thread_id` | Trellis 侧改存 `as_thread_id`，engine id 由 daemon 管；旧列保留只读用于回填 |
| `sessions.model` / `system_prompt` / `workspace_path` / `require_approval` / `lineage_isolation` | `thread/start` 的 params | 语义不变，只是从 `RunOptions` 变成 RPC params |
| `nodes.response` / `tool_calls_json` / `token_*` / `final_start` / `duration_ms` | item 日志的投影 | 迁移期双写（§3.1），稳定后可降为缓存 |
| `nodes.pending_interaction_json` | daemon 的 `approvals` 表 | Trellis 侧可删；重连拿 `thread/attach.pendingRequests` |
| `cli_lineages` / `cli_turn_uuid` / `codex_turn_ordinal` | 分叉坐标，**留在 Trellis** | 协议只认 `thread/fork{fromItemId}`；Trellis 负责把「节点」翻译成 `fromItemId` |
| `sessions.origin='cli-import'` + `cli_sync_*` | `backend:"external"` 的 thread | `ExternalSession` 接管 jsonl 尾随，Trellis 的 watcher 可退役 |

**新增一张映射表**（Trellis 侧）：

```sql
CREATE TABLE as_threads (
  node_id    TEXT PRIMARY KEY,     -- 或 root_node_id，取决于 mode
  thread_id  TEXT NOT NULL,        -- agent-server threadId
  backend    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

project 模式一棵树（或一条 lineage）一个 thread；chat B-fork 每个节点一个
thread —— 与今天 `sessionIdTarget: "root" | "node"` 的语义一一对应。

### 2.3 SSE

今天：`app/api/chat/route.ts` 与 `app/api/nodes/[id]/stream/route.ts` 各自把
`RunEvent | CatchupEvent` 编成 `data: {...}\n\n` 发给浏览器；客户端在
`stores/sessionStore.ts` + `components/{LinearThreadView,ChatNode,TurnCard}.tsx` 消费。

迁移后：**浏览器侧协议不变**。Next.js 服务端从「run-bus 的订阅者」变成
「agent-server 的客户端」，在 `lib/server/as-client.ts`（新增）里把
AS 通知翻译成现有的 `RunEvent` 形状再发 SSE。

这条决定是整个迁移可行的关键：**前端零改动**。等三步走完、行为稳定，再决定
要不要让浏览器直连 WebSocket（那时删的是翻译层，不是重写 UI）。

### 2.4 审批

| 今天 | 迁移后 |
|---|---|
| `sdk-adapter.ts` 注 `askTools:"all"` | `thread/start{permission:"default", askTools:"all"}` 由 daemon 注入 |
| `run-bus` 的 dispatcher 判免审 | daemon 的 Approval Broker 判免审 |
| `POST /api/nodes/[id]/respond` | 转发成对反向请求的 response |
| 单客户端弹卡 | 广播竞答 + `serverRequest/resolved` 撤卡（`protocol.md` §5） |
| `alwaysAllowTool`（本轮内） | `decision:"acceptForSession"` |

**注意保留的既有事实**（`progress/facts.md`）：设备全局
`~/.claude/settings.json` 的 `permissions.allow` 会让 `can_use_tool` 永不触发，
所以 `permissions.ask:["*"]` 的注入不能在下沉过程中丢掉；e2e 测审批必须隔离
`CLAUDE_CONFIG_DIR`。这条纪律随代码一起搬到 daemon 侧的测试里。

### 2.5 附件

`app/api/uploads` + `lib/server/blobs.ts`（内容寻址 blob + per-node staging）
**留在 Trellis**。协议的 `UserInput.image/file` 收本机绝对路径
（`protocol.md` §10.2 D7），Trellis 把 staging 后的路径填进去即可 —— 今天
`RunOptions.attachments` 就是这个形状，等于零改动。

限制：daemon 与 Trellis 必须同机（本设计的前提），否则路径失效。跨机时
需要给协议加内容上传，属 v2 议题。

### 2.6 分叉

| 今天 | 迁移后 |
|---|---|
| claude 原生 `--fork-session`（chat B-fork） | `thread/fork{threadId}`（不带 `fromItemId`） |
| `cli-fork.ts` 前缀 jsonl 截断（project per-lineage 隔离） | 显式 fork：最新节点（tip）→ `thread/fork{threadId}`（不带 `fromItemId`）；非 tip 节点 → 上游暂不支持带 `fromItemId` 的分叉，明确拒绝，保留旧节点数据与绑定 |
| project 模式非 tip 节点的**普通续聊**（非显式分叉） | 用祖先历史播种（seed）一个新 thread，不经协议原生 `fromItemId` 分叉 |
| `codex-fork.ts` rollout copy | codex 原生 `thread/fork`（2026-08-18 决策已认定原生 fork 上位） |
| `backfillNativeTurnUuid` / `backfillCodexTurnOrdinal` | **可以删** —— 「下刀坐标」在协议里就是 `itemId`，不需要事后回填 |

**实测收窄**（Trellis `feat-agent-server-step2` 分支）：协议设计上 `thread/fork` 支持任意
`fromItemId`（见 `protocol.md` §3.1），但落地时上游对非 tip 节点的 `fromItemId` 分叉
明确拒绝；因此 Trellis 侧把「任意 item 分叉」收窄为「tip 显式分叉（不带 fromItemId）+
非 tip 普通续聊走播种回退」，任意 item 原生分叉留作上游 backlog、不阻塞迁移。

这是迁移收益最大的一块：两套后端特有的分叉 hack 收敛成一个方法。

### 2.7 任务

`lib/server/tasks.ts` 的调度、槽位去重（`task_runs_slot` 部分唯一索引）、
超时、重试、通知、boot reap 全部**留在 Trellis**。改的只有一处：
`startRun(...)` → `asClient.startTurn(...)`，以及 `onSettled` 从 run-bus
回调改成对 `turn/completed` 通知的处理。

一个必须保住的不变量：`sqlite.ts` 的 boot reap 与 `onSettled` **成对存在**
（进程被 SIGKILL 时 `onSettled` 一次都不跑）。迁移后 Trellis 进程重启的
reap 逻辑不变，**另加**一条：启动时对每个 `running` 的 task_run 去
`thread/read` 核对真实状态 —— daemon 活着而 Trellis 重启，是迁移后新出现
的组合，也是迁移带来的**新能力**（任务不再因为 Trellis 重启而丢）。

### 2.8 飞书

`lib/server/lark/handler.ts` 的入站解析、地址路由（`im/policy.ts`）、
@slug 提取、话题即树、semaphore、outbox 留档全部不动。改两处：
`startRun` → `turn/start`；新增对反向请求的处理 —— 今天飞书链路**没有**
审批能力（`RunContext.onCanUseTool` 只给 claude 系的网页 run），迁移后
它天然获得（`packages/agent/src/channel.ts` 里 `Content.tool_approval`
这个卡片类型已经定义好，是 Harbor 时代留下的现成渲染）。

## 3. 三步迁移

### 第一步：影子模式（daemon 起来，Trellis 只读）

**做什么**

1. 起 daemon，只接一个后端（codex，见 `README.md` §9 P1 的理由）。
2. Trellis 新增 `lib/server/as-client.ts`：连 daemon、`initialize`、
   `thread/list`、`thread/attach`。
3. 新增只读页面 `/console/threads`（或并进现有管家页）：列 daemon 里的
   thread、attach 后实时渲染 item 日志。
4. **不改任何现有链路**。`app/api/chat/route.ts` 照旧 `startRun`。

**兼容策略**：零风险 —— 新代码全在新文件、新路由后面。

**验收**：TUI（`apps/agent-tui`）起一个 codex thread，Trellis 页面能实时
看到同一份日志；断开 Trellis 再连，`sinceSeq` 补齐无缺无重。

**风险**：低。最坏是白写一个页面。

**Trellis 侧改哪些文件**
- 新增 `lib/server/as-client.ts`、`app/api/as/threads/route.ts`、
  `app/api/as/threads/[id]/stream/route.ts`、`components/ThreadLogView.tsx`
- 改 `instrumentation.ts`（boot 时建连接，失败只 warn 不阻断启动）

---

### 第二步：project 模式切流（一个模式、一个后端）

**做什么**

1. daemon 补齐 `ClaudeSession`（`README.md` §9 P2），审批接进 Approval Broker。
2. `app/api/chat/route.ts` 加一个开关 `TRELLIS_AS_PROJECT=on`（`off`/`on`，见
   Trellis 分支 `.env.example`；`TRELLIS_AS=off` 时整条 AS 路径关闭，覆盖
   `TRELLIS_AS_PROJECT`；`TRELLIS_AS_SOCKET`/`TRELLIS_AS_TOKEN_PATH` 指向
   daemon 的 socket 与 token 文件）：project 模式的
   `startRun` 改走 `asClient`；**chat / enhanced chat 保持原路**。
3. `lib/server/as-client.ts` 把 AS 通知翻译成现有 `RunEvent` 形状，直接喂
   给现有 SSE 编码器 → **前端零改动**。
4. `POST /api/nodes/[id]/respond` 分流：AS thread 走转发，旧 run 走
   `resolveInteraction`。
5. 双写：item 通知照旧调 `appendNodeResponse` / `appendToolCallStart` /
   `markToolCallDone` / `finalizeNode`，DB 行保持可读、可搜索、可导出。

**兼容策略**
- 开关按 **session** 粒度（不是全局）：新建的 project session 走 AS，
  存量 session 继续走 `startRun`。这样回滚只需要停止给新 session 打标。
- run-bus **不删**。两条路并存整个第二步。
- 双写让「DB 行是真源」这个存量假设在整个迁移期继续成立，搜索
  （`fts-search`）、导出、`cli-import` 对账全部不受影响。

**验收**
- 同一个 project session 连发 N（≥3）轮，daemon 侧只有一个引擎进程（`ps` 核对）；
  实测记录（`mobile-as-project`）验证到三轮单引擎，未复测五轮。
- 网页 + 第二个 AS client（实测为网页刷新 + 第二端/mobile）同时 attach，两边
  看到同一份流；网页刷新后 catchup 正确。**TUI（`apps/agent-tui`）同时 attach
  这条路径当前未见实测证据，待补测**。
- 审批：两个 AS client 同时弹卡，一边点批准，另一边卡片变「已由 X 处理」
  （实测记录为网页 + 第二端，非网页 + TUI）。
- 中断（⏹）、重试、分叉、@提及 ephemeral、自定义 agent 五条老路径回归通过。
- DB 行内容与走旧路时逐字节可比（同一 prompt 的 `nodes.response` 结构一致）。

**风险**
| 风险 | 缓解 |
|---|---|
| claude 跨轮 stdin 常开未实测（`README.md` §10.1） | P2 开工前先做真机验证；失败则 `ClaudeSession` 退化为每轮 spawn，协议不变 |
| 双写导致 DB 与 item 日志漂移 | 双写发生在同一个通知处理函数里，顺序固定；加一条对账断言（`turn/completed` 时比对 `nodes.response.length` 与聚合 item 长度，不等只记 warn） |
| daemon 挂掉 = Trellis 的 project 模式全挂 | `as-client` 断线自动重连 + 指数退避；连不上时对新请求回退 `startRun`（保留一条降级路径直到第三步结束） |
| 审批策略下沉后行为漂移 | 免审名单（`READONLY_AUTO_ALLOW`）逐条搬进 daemon 并配单测；e2e 隔离 `CLAUDE_CONFIG_DIR` |

**Trellis 侧改哪些文件**
- `app/api/chat/route.ts`（切流分支 + `as_threads` 映射写入）
- `app/api/nodes/[id]/respond/route.ts`、`app/api/nodes/[id]/stream/route.ts`、
  `app/api/chat/[id]/abort/route.ts`（三态分流）
- `lib/server/as-client.ts`（翻译层：AS 通知 → `RunEvent`）
- `lib/server/repo.ts`（`as_threads` 读写）、`lib/server/sqlite.ts`（建表）
- `lib/llm/sdk-adapter.ts`（`modeToRunOptions` 的产物改为 `thread/start` params
  的构造器；`toStreamEvent` 在 AS 路径下不再需要）
- `lib/server/cli-fork.ts` / `codex-fork.ts`（AS 路径下走 `thread/fork`，
  旧函数保留给存量 session）

---

### 第三步：全量切流 + 拆掉 run-bus

**做什么**

1. chat / enhanced chat 切 AS（chat B-fork 用 `thread/fork`）。
2. `lib/server/tasks.ts`、`lib/server/lark/handler.ts` 的 `startRun` 换掉。
3. `ExternalSession` 上线，`cli-sync-watcher.ts` / `cli-import-db.ts` 的
   尾随部分退役（解析器 `cli-import.ts` 保留 —— daemon 会复用同一份解析逻辑，
   最好抽成 `packages/agent` 的导出）。
4. 删 run-bus 的引擎侧职责，只留（如果还需要的话）一个极薄的
   「SSE 广播器」；`finalStart`/`pendingBreak` 状态机整段删除。
5. 存量 session 一次性迁移或就地作废：给存量 project session 建 `as_threads`
   行（`engine_thread_id` = 旧的 `claude_session_id` / `codex_session_id`），
   下次续聊由 daemon `thread/resume` 接住。

**兼容策略**
- 存量 session 的 resume 靠 `engine_thread_id`，引擎侧的 jsonl / rollout
  一直都在，所以「历史丢了」不会发生 —— 最坏是要重新 resume 一次（冷启动）。
- 双写降级为单写（item 日志为主，`nodes.response` 变成投影 / 缓存）要单独
  评估：搜索与导出依赖 DB 列，建议**继续双写**直到搜索层也改造完。

**验收**
- 全仓 `grep -n "startRun" lib app` 只剩下 run-bus 自己（或零命中）。
- 飞书群里 @bot → 手机上收到审批卡 → 批准 → 群里出结果，全链路走一遍。
- Herdr pane 里手起的 codex 会话在 Trellis 上只读可见。
- Trellis 进程重启，跑着的自动化任务不中断（daemon 还活着）。

**风险**
| 风险 | 缓解 |
|---|---|
| 飞书是生产链路，切流即影响真人 | 按 bot 粒度切（`lark_bots` 加一列开关），先切一个测试 bot |
| 存量 session 迁移把 `as_threads` 写错 → 续聊接到别的会话 | 迁移脚本 dry-run + 逐条核对 `engine_thread_id` 在引擎侧存在（claude 走 `claudeSessionPath`，codex 走 rollout 路径）；不存在的不建行，让它下次 fresh |
| 删 run-bus 时误删产品逻辑（对账钩子那一串） | 删除按「先搬走再删」：每个钩子在 AS 路径下有对应实现且过一次真机，才允许删旧代码 |
| ExternalSession 与 Trellis watcher 双写同一 session | 切换时先 detach Trellis 的 watcher，再让 daemon 接管；两者不并存 |

## 4. 迁移后 Trellis 的形状

留在 Trellis：树 / 画布 / 分叉的产品语义、project·workspace 层级、
自定义 agent 与 pack 组装、自动化任务与触发器、飞书入口与地址路由、
搜索 / 笔记 / 书签 / 阅读态、附件上传与 staging、多租户网关。

下沉到 agent-server：引擎进程的生命周期、多轮不重启、审批与提问的分发与
竞答、事件到 item 的归一与持久化、断线重连的快照与重放、分叉的后端实现、
外部会话的接入。

一句话判据：**「这件事换成飞书 bot 也需要吗？」需要 → 下沉；不需要 → 留在 Trellis。**
