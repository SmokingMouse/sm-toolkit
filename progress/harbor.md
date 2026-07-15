# Harbor — 个人多设备 Agent 调度平台（Mew 复刻）技术方案

> 2026-07-15 起草。定位：把 Mew 的「配置即 Agent + Chat/Issue 分流 + Daemon 本地桥接」
> 复刻为个人版，最大化组装 sm-toolkit 既有积木，新写面收缩到 server / daemon 壳 / Issue 状态机。

## 0. 已定决策（讨论收敛，含理由）

| 决策 | 理由 | 备选及拒绝原因 |
|---|---|---|
| BUILD thin，不基于 omnigent / vibe-kanban | 共性部分（daemon+spawn）sm-toolkit 已有，差异部分（Issue/cron/飞书）谁都没有 | omnigent：alpha 期 Python 重栈，绑死后仍要自建差异层；vibe-kanban：执行只在 server 本机 |
| 网关 = @sm/llm env 注入，不引入 claude-code-router | 零额外跳数、无 proxy 保活负担；env 路由优先级有实测背书（sm-toolkit Verified Facts） | ccr 的增量只有请求级中心 trace，个人场景 @sm/audit 的 runner 级用量已够 |
| 落在 `~/sdk/apps/harbor/`（单 package 三 bin） | 重度依赖 workspace:* 的 @sm/*；协议类型 server/daemon/CLI 三端共享，单包零复制 | 独立仓库：file: 依赖跨仓库摩擦（Fisher 踩过硬链接断链）；`~/python/ai/Harbor` 空目录废弃 |
| 服务对象：个人多设备 | 用户拍板 | 砍掉 SSO/RBAC/Workspace 多租户；数据模型不留多租户字段（真要团队化时再迁移，不为想象需求付复杂度税） |
| 入口三阶段：CLI/API → 飞书 Bot → Web | 用户拍板（三个都要）；地基先行 | — |
| self-agent 长期由 Harbor 飞书入口取代 | 不留双版本原则；Harbor 飞书入口是其超集 | Phase 2 完成搬迁后退役，Phase 1 期间两者并存互不干扰 |

## 1. 目标与非目标

**目标**：任意入口（CLI / 飞书 / Web）把任务派给任意一台自有设备上的任意配置好的 Agent；
任务以 Issue 形态留档、可多轮续、可定时触发；跑在自己机器上、直访本地代码。

**非目标**：多人协作 / 权限体系；请求级 HTTP trace（用量走 runner 级审计）；
云沙箱执行（设备都是自有机器，Tailscale 可达）；SeedCLI 等内部 CLI 支持。

## 2. 领域模型（glossary，单一真相源）

| 术语 | 定义 | 关键关系与边界 |
|---|---|---|
| **Device** | 一台注册过的自有机器，daemon 常驻其上 | 1 Device — N Agent。离线时其 Agent 的任务排队不丢 |
| **Agent** | 一条配置绑定记录：device + backend(claude/codex) + model + permission + workdir + isolation + instruction | 归属恰好 1 个 Device（v0 不做跨设备漂移）。软删除（archived_at），历史 Run 引用不悬空 |
| **Conversation** | 对话容器，`kind: chat \| issue` 二态。Chat=临时探索，Issue=留档任务 | 1 Conversation — 1 Agent（创建时绑定）— N Run。Chat 可一键升格为 Issue（改 kind + 补 title） |
| **Issue 状态机** | `backlog → doing → review → done / canceled` | doing=有 run 在跑（自动）；review=agent 完成待人验收（自动）；done/canceled=人工。允许任意回退，转换全记日志 |
| **Run** | 一次 CLI 进程调用（一条 prompt → 一个 result），Conversation 内靠 `claude_session_id` resume 串成多轮 | 状态 `queued → running → succeeded / failed / canceled`。daemon 崩溃恢复 = 新 Run 带 resume 重试。run succeeded → issue 进 review；failed/canceled → issue 回 backlog（没 run 在跑就不该停 doing，也没到 review）—— P1 实现时拍板 |
| **Automation** | cron 定时器，触发时对指定 Agent 发 prompt | v0 只做 cron；webhook（git 事件）进 Phase 3。产物模式：每次新开 Issue，或追加到固定 Conversation |
| **Approval** | permission=default 档下，daemon 上抛的工具授权请求 | 经 server 路由到发起入口（飞书卡片 / CLI / Web）等人批，回传 allow/deny |

命名注意：Harbor 的 **Agent** 与 Claude Code 的 subagent、@sm/agent 包名三者语义不同，
代码内 Harbor 实体统一用 `HarborAgent` 类型名规避碰撞；`claude_session_id` 全称存储，不简写 session。

## 3. 架构

```
┌─ 入口层 ────────────────────────────────────────────┐
│ harbor CLI(P1)   飞书 Bot(P2, @sm/channel-feishu)   Web(P3, Next.js) │
└───────────────┬─────────────────────────────────────┘
                │ REST (token auth, Tailscale 内网)
┌───────────────▼─────────────────────────────────────┐
│ harbor-server（bun + Hono，常开机器）                  │
│  · SQLite(bun:sqlite)：全部领域表                      │
│  · Run 队列与分发（按 device 路由，per-device 并发闸）   │
│  · Issue 状态机 / Approval 路由 / cron scheduler(croner)│
│  · 用量汇总（Run 落 Cost 字段，按 agent/model/日聚合）   │
└───────────────┬─────────────────────────────────────┘
                │ WebSocket 长连（daemon 主动外连，穿 NAT 免配置）
┌───────────────▼─────────────────────────────────────┐
│ harbord（每设备一个，bun 常驻）                         │
│  · 注册/心跳/能力上报（已装 CLI 版本 + endpoints.yaml 模型清单）│
│  · 收 run → @sm/agent ClaudeBackend/CodexBackend 执行  │
│  · 模型路由：本机 endpoints.yaml（@sm/llm，env 注入）    │
│  · AgentEvent 流式回传（批量 flush，200ms/20 条）        │
│  · worktree 生命周期管理（isolation=worktree 的 Issue）  │
│  · onCanUseTool → approval_request 上抛                │
└─────────────────────────────────────────────────────┘
```

**复用清单**：执行引擎 @sm/agent（RunOptions 已覆盖 workspace/cwd/systemPrompt/resume/
permission 四档/model 解析/env/onCanUseTool 双向审批，Harbor 直接消费，不改）；
路由 @sm/llm；飞书 @sm/channel-feishu（Channel + Content 卡片类型，approval_request 卡片现成）；
限流预算 @sm/guardrails（daemon 侧 CostGate/RateLimiter 可选接入）。
**@sm/store 不复用其表结构**（那是会话专用 schema），Harbor 自建领域表，仅沿用 bun:sqlite 用法。

## 4. 数据模型（SQLite，id 一律 text 防大整数精度坑）

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '{}',   -- {clis:{claude:"2.1.x"}, endpoints:[...]}
  last_seen_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
  device_id TEXT NOT NULL REFERENCES devices(id),
  backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  model TEXT,                                 -- endpoints.yaml 名 / 裸 tier / 透传
  permission TEXT NOT NULL DEFAULT 'auto-edit',  -- @sm/agent 四档
  workdir TEXT NOT NULL,                      -- device 上的绝对路径
  isolation TEXT NOT NULL DEFAULT 'none' CHECK (isolation IN ('none','worktree')),
  instruction TEXT,                           -- systemPrompt 注入
  created_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('chat','issue')),
  title TEXT, agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'backlog',     -- chat 恒为 open
  worktree_path TEXT,                         -- isolation=worktree 时 daemon 回填
  claude_session_id TEXT,                     -- 最新一轮，resume 用
  origin TEXT NOT NULL DEFAULT 'cli',         -- cli|feishu|web|automation，approval 回路由用
  origin_ref TEXT,                            -- 飞书 chat_id / automation_id 等
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id TEXT NOT NULL, device_id TEXT NOT NULL,   -- 快照，不 FK 约束（agent 可归档）
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claude_session_id TEXT, error TEXT,
  cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE run_events (                     -- 流水，7 天 prune；result 事件永久留 runs.error/cost
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TABLE automations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
  cron TEXT NOT NULL, prompt TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'new_issue' CHECK (mode IN ('new_issue','append')),
  target_conversation_id TEXT,                -- mode=append 时必填
  enabled INTEGER NOT NULL DEFAULT 1, last_fired_at INTEGER
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','allowed','denied','expired')),
  decided_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE status_log (                     -- issue 状态转换审计
  conversation_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, ts INTEGER NOT NULL    -- actor: human|system|agent
);
```

## 5. Daemon ↔ Server 协议（WS，JSON 行）

```
daemon → server
  hello        {deviceName, token, capabilities}          # 注册/重连，幂等 upsert
  heartbeat    {ts}                                       # 30s；server 90s 无心跳判离线
  run_event    {runId, seq, event: AgentEvent}            # 批量数组
  run_done     {runId, status, claudeSessionId, cost, error?}
  approval_req {runId, requestId, toolName, input}

server → daemon
  run_start    {runId, spec: {backend, model, prompt, workdir, worktree?, permission,
                systemPrompt, resume?, envOverrides?}}
  run_cancel   {runId}
  approval_res {requestId, behavior: allow|deny, updatedInput?, message?}
```

要点：
- **daemon 外连** server（不反向），家庭 NAT / 公司网免端口配置；断线指数退避重连，
  重连后带 `runningRunIds` 做状态对账——server 侧标记 running 但 daemon 不认的 run 判 failed。
- **failed run 的恢复路径**：Conversation 存有上一轮 `claude_session_id`，人工或自动重试
  = 新 Run 带 resume，上下文不丢（persistence=true 是 RunOptions 默认，天然支持）。
- **approval 超时**：pending 超 30min 标 expired，daemon 回调 resolve 为 deny（防进程无限挂）。
- seq 单调递增，server 按 (run_id, seq) 幂等插入，重连重发不重复。
- **对账口径（P1 实现时发现的坑）**：hello.runningRunIds 必须 = 执行中的 run ∪ outbox 里
  还有待补发消息的 run。若只报执行中的，断线期间刚完成的 run 会在重连对账时被误判 failed，
  随后补发的 run_done(succeeded) 因 run 已终态被忽略——成功被记成失败。
- **auth（P1 拍板）**：单 shared token（HARBOR_TOKEN / ~/.harbor.yaml），REST Bearer 与 WS hello
  共用；devices.token_hash 存 sha256 指纹，字段留给未来 per-device token，现在不为想象需求建发放流程。

## 6. Worktree 隔离（对齐 Mew「修复机器人」模式，本方案新增项）

- 粒度：**per-Issue**（不是 per-Run）——同一 Issue 的多轮迭代共享 worktree，续改不断档。
- 生命周期：Issue 首个 run 启动时 daemon 执行
  `git worktree add <workdir>/../harbor-worktrees/<issue-id> -b harbor/<issue-id>`，
  路径回填 `conversations.worktree_path`；RunOptions.workspace 指向 worktree，主仓库不入 workspace（只读保护靠不加 --add-dir 实现）。
- 收尾：Issue → done/canceled 时 daemon 收 `worktree_cleanup`，默认**保留分支删 worktree 目录**
  （成果在分支上，合并由人/后续 agent 决定；避免自动 merge 的风险面）。
- isolation=none 的 Agent 直接跑 workdir（适合巡检/播报类只读角色）。

## 7. 飞书入口设计（Phase 2）

- 形态：harbor-server 进程内挂 FeishuChannel（复用 self-agent 的「Channel 薄 / Orchestrator 厚」分层），
  一个 bot 服务全部 agents，`@bot <agent名> <指令>` 或话题群绑定默认 agent。
- 映射：飞书话题/群 ↔ Conversation（origin=feishu, origin_ref=chat_id）；
  approval_request 渲染成卡片（@sm/agent Content 类型现成），点按钮回 approval_res。
- **send-gate 边界**（写进 bot 实现，双保险）：bot 只在①被 @ 的消息②自己发起的卡片回调
  ③绑定白名单群的 automation 播报，三种场景下发消息；不主动私聊、不进非白名单群发言。
  白名单群清单存 server 配置，默认空。
- self-agent 退役：其 ACL/命令路由逻辑并入 Harbor Orchestrator 后停进程、归档 app 目录。

## 8. 已知坑规避（来自既有 Verified Facts / ADR）

| 坑 | 来源 | Harbor 对策 |
|---|---|---|
| claude CLI 首轮不等 MCP 握手（tools:[] + 自定义 MCP 竞态） | Fisher ADR 2026-07-14 | 不触发：Harbor 不用 tools:[]，不依赖自定义 MCP 首轮可见 |
| 代理端点认 AUTH_TOKEN 不认 API_KEY | sm-toolkit VF | @sm/agent 内部已双设，无需处理 |
| 19 位整数 JSON 精度丢失 | Fisher VF | 全部 id 用 text；协议层禁裸大整数 |
| `file:` 依赖断硬链接 | Fisher ADR | monorepo workspace:* 依赖，无此问题 |
| 长连过 sleep/换网断链 | 常识 | daemon 指数退避重连 + run 状态对账（§5） |
| endpoints.yaml 各机不一致 | 多设备现实 | 能力上报含本机可用 endpoint 清单，server 建 agent 时校验 model ∈ device 能力 |

## 9. 开发计划（5 期，每期独立可用，✅=可执行验收判据）

依赖线性：P1 → P2 → P3 → P4 → P5（P3/P4 可换序或并行）。每期结束都是一个日常可用的增量，
不存在「全做完才有价值」的悬空期。总验收标准：**做完后基础体验没问题**（判据见 P5 终验清单）。

### Phase 1 — 地基：跨设备执行闭环（server + daemon + CLI）✅ 2026-07-15 完成

> 落地 `apps/harbor/`（1.1–1.8 全部实现）；本机 server + 双 daemon 进程模拟双设备，
> e2e 验收判据全过（issue 派活/watch 流式/continue resume 连续/kill daemon 对账判 failed/
> 重启后恢复上下文/model 能力校验拒绝）。真双机跨设备（Tailscale）待用户环境验证。
> P1 范围裁剪：isolation=worktree 在 agent create 即拒（P2 实现生命周期，拒绝好过静默不隔离）；
> approval 消息类型已进 protocol.ts 但流转不实现（P2）；automations/approvals 表已随 v1 迁移建好。

| # | 任务 | 要点 |
|---|---|---|
| 1.1 | `apps/harbor/` 骨架 | 单 package 三 bin（harbor-server / harbord / harbor）；`src/protocol.ts` 三端共享消息与领域类型 |
| 1.2 | server 存储层 | §4 全部表 + 幂等迁移（`user_version` 版本化） |
| 1.3 | server REST | devices/agents/conversations/runs CRUD + `GET /runs/:id/events` SSE + token auth |
| 1.4 | server WS + 队列 | daemon 注册/心跳/90s 离线判定；run 按 device 路由，per-device 并发闸（默认 2，超出排队） |
| 1.5 | Issue 状态机 | run 启动→doing、run_done→review 自动流转 + status_log；chat 恒 open |
| 1.6 | daemon 执行 | hello/能力上报（CLI 版本 + endpoints 清单）；run_start → ClaudeBackend 流式执行 → run_event 批量回传 → run_done（含 cost/claude_session_id） |
| 1.7 | daemon 对账 | 指数退避重连；重连带 runningRunIds，server 清孤儿 run 判 failed |
| 1.8 | harbor CLI | `device ls` / `agent create·ls` / `chat` / `issue create·continue·ls` / `watch <run>`（SSE 渲染）；失败 run 显示 error 分类 |

✅ 验收（双机真跑）：Mac `harbor issue create` → 另一设备 agent 执行 → `watch` 流式输出 →
`issue continue` resume 二轮上下文连续 → 中途 kill daemon：run 判 failed，重启后 `issue continue`
恢复上下文 → `agent create` 时 model 不在设备能力清单内被拒。

### Phase 2 — 远程体验闭环（飞书入口 + 审批 + worktree）

| # | 任务 | 要点 |
|---|---|---|
| 2.1 | FeishuChannel 挂载 | `@bot <agent名> <指令>` 解析 + 话题群↔Conversation 映射（origin=feishu） |
| 2.2 | 审批链路 | onCanUseTool → approval_req → 飞书卡片 → 回批 → daemon resolve；30min 过期自动 deny；卡片重复点击幂等 |
| 2.3 | 结果回报 | run_done → 结果摘要回群 + issue 状态标注；failed → 告警消息（error 分类） |
| 2.4 | worktree 生命周期 | §6 全流程 + `harbor issue done` 收尾（保留分支删目录） |
| 2.5 | send-gate 白名单 | 三场景准入（被 @ / 卡片回调 / 白名单群播报），默认空清单 |
| 2.6 | self-agent 并入退役 | ACL/命令路由逻辑吸收进 Orchestrator，停进程归档目录 |

✅ 验收：飞书话题群派 issue → 高危工具卡片批准 → 完成通知回群；permission=default 的 agent
端到端可用；同 repo 两个 issue 并行 worktree 不互踩；非白名单群 bot 全程静默。

### Phase 3 — 无人值守闭环（automation + 用量 + skill 入口）

| # | 任务 | 要点 |
|---|---|---|
| 3.1 | croner 调度 | automation CRUD（CLI 管理）；server 停机期间错过的触发**跳过不补跑**，记 missed 日志 |
| 3.2 | 用量报表 | `harbor usage`：按 agent×model×日聚合；逐 run cost 可下钻 |
| 3.3 | run_events prune | 7 天滚动清理，result/cost 永久留 runs 表 |
| 3.4 | harbor skill | 薄 skill 包住 harbor CLI，让日常 Claude Code session 可直接派活/查状态（vibe-kanban MCP 入口的低成本等价物） |

✅ 验收：迁移 1 个现有 cron 类任务进 automation 连跑 3 天留档正确；usage 报表与逐 run
cost 抽查 3 笔一致；在日常 CC session 里通过 skill 建一个 issue 并收到飞书完成通知。

### Phase 4 — Web 看板（只读起步）

| # | 任务 | 要点 |
|---|---|---|
| 4.1 | Next.js 看板 | Issue kanban（状态列拖拽后置）+ run 详情（事件流回放）+ 用量图 |
| 4.2 | 只读边界 | 第一版纯只读，管理操作仍走 CLI/飞书；写操作按 dogfood 体感再加，不预做 |

✅ 验收：手机浏览器（Tailscale 内网）打开看板，完整查看一个 issue 的状态、run 流水与用量。

### Phase 5 — Dogfood 加固（「基础体验没问题」的兑现期）

| # | 任务 | 要点 |
|---|---|---|
| 5.1 | 真实负载迁移 | ≥2 条 automation + 日常派活跑满一周 |
| 5.2 | 边缘 case 清零 | 长输出（>1MB 事件流）截断策略；设备睡眠唤醒；server 重启恢复；飞书卡片过期态；时区 |
| 5.3 | 错误信息走查 | 每类失败原因（模型不可用/设备离线/权限拒绝/超时）人为触发一遍，确认 error 提示可操作 |

✅ **终验清单（全部达成才算「做完」）**：
1. 可靠派活：连续 20 个真实任务（chat/issue/automation 三来源混合）零次需要登 server 机器查日志排障
2. 自愈：设备睡眠唤醒 / 断网 5min / server 重启，三种扰动后系统自动回到一致状态，进行中任务可 continue 恢复
3. 审批不悬空：卡片可批可拒，过期自动 deny 且 issue 上有明确标记
4. 无静默失败：任何 failed run 都有飞书告警 + 可操作的 error 分类
5. automation 连续 7 天正确触发且留档，missed 有日志
6. 用量可信：报表与逐 run cost 抽查一致

### 启动时同步动作（P1 开工时执行）
- sdk `progress/README.md` 立 Harbor goal（已于 2026-07-15 完成）
- `~/python/ai/Harbor` 空目录删除

## 10. 开放问题（不阻塞 Phase 1）

1. worktree 分支的合并流：纯手动 vs `harbor issue merge` 命令 vs 交给 review-agent——Phase 2 用真实使用体感定。
2. per-agent skill 隔离：Mew 有 skill 绑定；claude CLI 的 skill 加载是设备全局的，做 per-agent 收窄需要独立 CLAUDE_CONFIG_DIR / harness 目录方案，成本不小。v0 接受设备全局 skill + instruction 差异化，够用再说。
3. Codex backend 的 resume 语义与 claude 是否对齐（@sm/agent CodexBackend 支持面需实测），Phase 1 以 claude 为主、codex 跑通基本执行即可。
4. 手机端入口：飞书天然覆盖（P2 后手机可用），是否还需要 PWA 另议。
