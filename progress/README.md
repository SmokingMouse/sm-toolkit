# SM-Toolkit Progress

## Current Focus

SDK 底座 + 应用分离完成。packages/ 放 SDK 积木，apps/ 放应用（cli + self-agent）。

## Goals

### Short-term
- [x] 建 monorepo 骨架（bun workspaces + tsconfig）
- [x] @sm/llm：config 加载 + OpenAI/Anthropic provider + retry
- [x] llm CLI：argparse + 直调 API + 交互模式（exec claude）+ 交互式模型选择器
- [x] endpoints.yaml 初始配置（5 endpoint）
- [x] CLI 安装到 PATH + cron 脚本切换验证

### Mid-long
- [x] @sm/agent：CLIRunner + Channel 接口 + Orchestrator（ACL/命令/session） + OrchestratorStore
- [x] @sm/store：SQLite / PG / Memory 三后端
- [x] @sm/audit：日志 + 定价 + 汇总
- [x] @sm/sandbox：Local + Docker 后端
- [x] @sm/guardrails：runOnce + RateLimiter + CostGate
- [x] SelfAgent 迁移到 @sm/agent（已完成，通过 symlink 依赖 + endpoint 配置替换）
- [x] 日常服务 LLM 调用层统一到 llm CLI（content-studio / monitor-hub / news-radar）
- [x] @sm/channel-feishu：飞书 Channel 适配（从 SelfAgent 移植，薄实现）
- [x] 根级 `bun run setup` 引导流程（配模型 + 注册 SDK + 注册全局命令 + 按需装 app）
- [x] agent-gateway 统一配置源（已迁移——见 2026-07-11 session；agent-gateway 独立仓库整体退役，能力拍平进 @sm/agent）
- [ ] **Harbor（个人多设备 Agent 调度平台，Mew 复刻）** — 方案 `progress/harbor.md`，5 期路线。P1 地基已完成（2026-07-15，本机模拟双设备 e2e 全过；真双机验证待用户跨设备跑），下一步 P2 飞书/审批/worktree

## Verified Facts

- **claude CLI 的路由优先级**：env 注入的 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 优先于本机 OAuth 登录态——本地假服务器实测（2026-07-14），所有 `/v1/messages` 请求均打到 env 指定的 base_url 且带 `Bearer <token>`，零请求流向官方；`--bare` 有无不影响路由归属。因此"指定三方 endpoint 却悄悄用官方模型"在 env 齐全时不存在。
- **super-relay 等字节内部代理认 `ANTHROPIC_AUTH_TOKEN`（Bearer），不认 `ANTHROPIC_API_KEY`**；两个都设可兼容不同版本 claude CLI。

## Session Log

### 2026-07-15 — Harbor Phase 1 落地（地基：跨设备执行闭环）
- **Done**：`apps/harbor/` 单包三 bin 全量实现——`src/protocol.ts`（三端共享领域类型 + WS 消息 + SSE 帧）、`server/`（db user_version 迁移含 P2/P3 表、store 全 SQL 收口、statemachine 任意回退 + status_log、bus 内存扇出、scheduler=RunCoordinator 收口 run 生命周期两端、ws DeviceHub 注册/心跳 30s/90s sweep/同名踢旧连接、rest CRUD + SSE 先订阅再回放 seq 去重 + Bearer auth）、`daemon/`（capabilities 探测 CLI 版本 + endpoints 双形式清单、executor 批量 flush 200ms/20 条、main 指数退避重连 + outbox 必达补发）、`cli/`（9 个子命令 + SSE 渲染 + id 前缀匹配）。根 tsconfig/workspaces 注册，hono 依赖入 harbor 包。启动同步动作完成（`~/python/ai/Harbor` 空目录已删）。
- **Verified**（本机 server:7788 + 双 daemon 进程模拟双设备，deepseek-v4-flash 真跑）：全量 tsc 过；P1 验收判据逐条过——issue create 派活到 dev-beta ✓ watch 流式（session/tool_call/text/cost）✓ 文件真实落盘 ✓ issue 自动 backlog→doing→review ✓ continue resume 同 session 上下文连续 + cache 复用 ✓ 中途 kill -9 daemon 重连对账 run 判 failed + issue 回 backlog + error 可操作 ✓ 崩溃后 continue 恢复上下文 ✓ model 不在能力清单被拒（报错带完整可用清单）✓ chat 第二设备路由 + 恒 open ✓ watch 已完成 run 回放 ✓ issue done 人工转换 + status_log 全轨迹（actor system/human 分明）✓。
- **Decisions**（已回写 harbor.md）：①run failed/canceled → issue 回 backlog ②对账口径 = running ∪ outbox 待发（防断线期间完成的 run 被误判 failed）③单 shared token，token_hash 存指纹留扩展 ④isolation=worktree P1 建 agent 即拒，fail loudly 优于静默不隔离。
- **Next**：真双机跨设备验证（Tailscale 环境，`~/.harbor.yaml` 配置已支持）；P2（飞书入口 + 审批链路 + worktree 生命周期 + self-agent 退役）。未 commit——等用户确认。

### 2026-07-15 — @sm/agent 新增 Thinking 事件（trellis CHAT 假死修复的 SDK 侧）
- **Done**：`EventType.Thinking` + ClaudeBackend 把 stream-json 的 `content_block_delta`/`thinking_delta` 透传为 Thinking 事件（`data.text`）。此前 thinking 被静默丢弃——claude CLI 2.x 默认先出 thinking 块再出正文（实测 haiku 无 effort env 也 thinking），effort=max 时思考期达分钟级，上游 UI 全程失明像卡死。
- **兼容**：纯增量事件类型；CLIRunner 的 toCLIEvent switch 有 default→null，self-agent 等存量消费者无感。dist 已重建。
- **验证**：trellis 全链路实测（SSE created→thinking→delta→done + UI 面板），见 trellis progress Session 52。
- **Next**：codex backend 的 reasoning 事件是否同样透传（有需求再做）。

### 2026-07-15 — Harbor 方案定稿
- **Done**：Mew 复刻调研（读原文档 + OSS 全渠道扫描：omnigent/vibe-kanban/claude-squad/omnara/ccr 等，结论 BUILD thin）+ 完整技术方案落 `progress/harbor.md`：领域模型（Conversation 统一 chat/issue）、SQLite schema、daemon WS 协议（外连+对账）、per-Issue worktree 隔离、飞书入口（审批卡片走 onCanUseTool 链路）、坑规避表、5 期开发计划 + 「基础体验没问题」终验清单。
- **Decisions**：①网关用 @sm/llm env 注入不引 claude-code-router（零跳数，trace 由 @sm/audit 兜）②落 `apps/harbor/` 单包三 bin（协议类型三端共享）③self-agent P2 并入 Harbor 后退役 ④@sm/store 表结构不复用，Harbor 自建领域表。
- **Next**：Phase 1 地基——protocol.ts → server（存储/REST/WS/队列/状态机）→ daemon（执行/对账）→ harbor CLI；验收 = 双机跨设备 issue 闭环（详见 harbor.md §9）。

### 2026-07-14 — llm 交互选择器去 process.stdin 化（终端乱码排查）
- **触发**：bytedance 工作机（ghostty）上经 `llm` 启动 claude 后，输入框漏进终端应答序列尾巴（`22;52c` = DA1 应答、`>|ghostty` = XTVERSION 应答、`35;47;9M` = SGR 鼠标事件，ESC 前缀均被吞）。
- **Done**：`apps/cli/src/main.ts` 选择器重写——不再碰 `process.stdin`（原实现 `setRawMode+resume` 会启动 bun 内部 stdin reader），改为 `stty -icanon -echo -isig` 设终端模式 + `readSync(0)` 同步读按键，父进程全程零 stdin reader；`pickEndpoint` 转同步；补 `\x04`(EOF) 退出分支。
- **Verified**：全量 tsc 过；pty 实测（`script` + 延迟送键）选择器渲染/j 移动/q 退出/终端态恢复全正常。
- **重要否定证据**：本机（bun 1.3.14）对照实验显示旧实现下 spawn 的子进程也能完整收到 tty 字节——即"bun stdin reader 偷字节"在本机不复现。该症状属于 Claude Code ↔ 终端 DA 应答竞态的已知 bug 类别（ghostty ≥1.3.0 与 claude 双方都修过相关问题）。本次改动是消除 llm 侧变量的加固，**不保证根治**。
- **Next**：在出问题的 bytedance 机器上验证：① 裸跑 `claude` 是否同样乱码（是→与 llm 无关，升级 claude/ghostty）；② pull 本次修复后经 `llm` 再测。
- **追加（同日）**：工作机上 `llm alwaysday1` 启动的 claude 提示 "Not logged in · Please run /login"。根因：`execClaude` 对 key 缺失静默容忍（`if (key)`），代理 endpoint 只传了 `ANTHROPIC_BASE_URL` 没传 key，claude 无凭证。而 key 没解析到的上游原因是 env_file（`~/.agent-gateway.env`）在该机不存在/缺变量——`loadEnvFile` 文件不存在同样静默跳过。修复：`execClaude` 在"有 base_url 但 key 未设"时报错退出（提示 env 变量名 + env_file 检查 + `llm --list`），隔离 HOME 实测报错分支正确触发。工作机侧动作：补 env_file 里的 key。
- **追加 2（工作机复查后的真根因）**："Not logged in" 的直接原因是 **super-relay 等字节内部代理认 `ANTHROPIC_AUTH_TOKEN` 不认 `ANTHROPIC_API_KEY`**（env_file 里变量名本身就叫 `SUPER_RELAY_AUTH_TOKEN`）。修复：代理 endpoint 同时设 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY`（兼容不同版本 claude CLI），两处同步——`apps/cli` 的 `execClaude` 和 `@sm/agent` 的 `ClaudeBackend.resolveClaudeModel`（self-agent 走它，同样会栽）。工作机另有几条未回流改动（TTY 感知 spawn / `--dangerously-skip-permissions` / 超时延长），待需要时再吸收。
- **追加 3（启动配置增强）**：`execClaude` 对代理 endpoint 自动推导默认 env——`ANTHROPIC_MODEL` + 三个 `ANTHROPIC_DEFAULT_*_MODEL` 全映射到该模型（否则 subagent/后台任务找不到官方 tier 模型）、`API_TIMEOUT_MS=3000000`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。个人偏好类不硬编码：endpoints.yaml 新增顶层可选 `claude:` 块（`env` map + `args` list，@sm/llm `ClaudeSettings` 类型 + `client.claudeSettings` getter），env 覆盖推导值、args 追加到命令行。stub claude 实测 env/args/覆盖优先级全部正确；example yaml 已附注释示例。
- **触发**：trellis 想接入全局模型选择（endpoints.yaml），调研发现它依赖的 `agent-gateway`（独立仓库）本地缺失、`@sm/agent` 的 `CLIRunner` 虽已支持 endpoint 切换但功能远薄于 agent-gateway（缺 vision/fork-session/交互式工具协议/tools 白名单）。拍板方向：不维持两套 CLI-spawn 实现，把 agent-gateway 能力整体拆开摊平进 `~/sdk`，agent-gateway 仓库退役。
- **Done**：
  - `@sm/llm`：修 `resolveEndpoint` 协议 fallback bug（`preferProtocol` 请求的协议 provider 没配就报错，而非静默返回协议不匹配的 base_url）；加 `"<provider>:<model>"` 限定 id 消歧（解决 `deepseek-v4-flash` 同时在 `deepseek`/`ark-coding` 两个 provider 下的歧义）；`LLMClient` 加 `chatWithFallback`；package.json/tsconfig 改自包含打包（`prepare: tsc --build` + 自带 typescript/@types/node，不再 extend 根 tsconfig 的 bun-types），可被外部项目 `file:` 依赖。
  - `@sm/agent`：吸收 agent-gateway 的 `ClaudeBackend`/`CodexBackend`/`MockBackend`/统一 `AgentEvent`/`Cost` 模型（新 `events.ts`/`backend.ts`/`backends/*.ts`），**原样移植**不顺手优化，降低行为漂移风险。`ClaudeBackend` 新增原生 endpoints.yaml 模型解析(裸 tier 别名直通 → 配置里的模型名/限定 id 走 `@sm/llm` 解析出 base_url+key 注入 env → 都失败则透传给 `--model` 让 CLI 自己校验)。`PermissionPolicy` 加第四档 `"default"`(纯 `--permission-mode default`,不带 `--disallowedTools`)专门保真 CLIRunner 的历史行为。`CLIRunner` 降级为薄委托门面,内部转发 `ClaudeBackend`,对外 `CLIRunner`/`CLIEvent`/`CLIRunnerOptions` 签名不变——**self-agent(生产飞书 bot)零改动**。
  - **验证**：monorepo 全量 `tsc --build --force` 过（含 self-agent）；用 `CLIRunner` 精确复刻 self-agent 生产调用形状（`endpoint: deepseek-v4-flash, workspace, permission: default`）实测真 spawn，拿到真实流式回复 + 正确 `init`/`text`/`result` 事件形状。
- **Next**：trellis 侧接线见其自身 progress（`~/orca/workspaces/trellis/goosefish/progress/README.md`）。agent-gateway 独立仓库本次不做删除动作,只是不再被依赖——留不留由用户决定。

### 2026-06-28 — 架构设计
- **Done**: 完成完整技术方案（`~/.claude/plans/silly-discovering-pixel.md`）
  - 讨论确定：Claude Code CLI 为唯一 agent runtime，endpoint 通过 env vars 切换模型
  - 双路径 CLI：有 -p → 直调 API（@sm/llm）；无 -p → exec claude（@sm/agent）
  - 六个共享包：llm / agent / store / audit / sandbox / guardrails
  - 共享 vs 隔离模型：endpoints.yaml 共享，agent.yaml 项目隔离
  - 复用来源索引：agent-gateway / agent-core / SelfAgent 各提取什么
- **Decisions**: 见方案文件
- **Next**: Phase 1 实现——monorepo 骨架 → @sm/llm → CLI → endpoints.yaml → 验证

### 2026-06-28 — 全实现
- **Done**: Phase 1-3 全部代码实现
  - monorepo 骨架：bun workspaces + tsconfig project references
  - @sm/llm：endpoints.yaml 加载 + env file、OpenAI-compat provider（DeepSeek/Gemini/Qwen）、Anthropic provider、retry with linear backoff
  - @sm/store：SessionTable + MessageTable 接口，SQLite（bun:sqlite）/ Postgres / Memory 三后端
  - @sm/audit：AuditLogger（SQLite 后端）、定价表（5 模型）、按 endpoint 汇总查询
  - @sm/agent：CLIRunner（spawn claude + NDJSON 解析 + 事件映射）、SessionStore、Channel 接口、Orchestrator
  - @sm/sandbox：Local + Docker 后端，统一 exec/readFile/writeFile 接口
  - @sm/guardrails：runOnce（幂等）、RateLimiter（滑动窗口）、CostGate（per-call + daily 预算）
  - llm CLI：双路径（有 -p → 直调 API，无 -p → exec claude）、--list / --json / --stream / -s / -f
  - endpoints.yaml：5 endpoint（claude/deepseek-chat/deepseek-reasoner/gemini-flash/qwen-plus）
  - CLI `bun link` 全局安装到 PATH
- **Verified**:
  - `bunx tsc --build` 类型检查通过
  - `llm --list` 显示 5 个 endpoint + key 状态（✓/✗）
  - `llm deepseek-chat -p "say hello"` 直调 API 返回响应
  - `echo "1+1=?" | llm deepseek-chat -s "answer with just the number"` 管道正常
  - `llm deepseek-chat -p "say hi" --json` 含 usage 的 JSON
  - `llm -p "hello"` 用 default endpoint（deepseek-chat）
  - `llm deepseek-chat -p "count 1 to 5" --stream` 流式输出
- **Next**: 实际迁移验证——cron 脚本切换、agent-gateway 统一配置源

### 2026-06-28 — Git 初始化 + SelfAgent 迁移
- **Done**:
  - Git 初始化（.gitignore + 初始提交 ff27363）
  - SelfAgent 替换完成：
    - 删除 `runtime/cli-runner.ts` + `runtime/types.ts`，替换为 @sm/agent CLIRunner + CLIEvent
    - Profile 简化：去掉 model/env 字段，改为引用 endpoints.yaml 的 endpoint 名
    - 新增 `glm` endpoint 到 endpoints.yaml
    - renderer/manager/bot 适配新类型
    - 类型检查通过
  - 依赖方式：node_modules/@sm/ → ~/sdk/packages/ symlink（bun install 后需重建）
- **Decisions**: SelfAgent session/store.ts 保留不迁 @sm/store（ACL 表结构是 self-agent 特有的）
- **Next**: content-studio LLM 配置统一、agent-gateway 能力迁移评估

### 2026-06-28 — CLI 交互式模型选择器
- **Done**: `llm` 无参数在 TTY 下弹出厂商分组选择器（Anthropic/DeepSeek/Google/Alibaba/Zhipu），上下键选模型，Enter 启动 Claude Code session；非 TTY 回退 help
- **Next**: content-studio LLM 配置统一、agent-gateway 能力迁移评估

### 2026-06-29 — LLM 调用层统一
- **Done**:
  - llm CLI 增强：`--temperature` + `--json-mode` flag，provider 名自动解析到首个模型
  - content-studio：`llm/_client.py` 从 requests HTTP 改为 subprocess llm CLI，`_config.py` 精简为纯 TASK_ROUTING dict
  - monitor-hub：`engine.py` judge() 外部模型分支从 ai-legion/agent-gateway 改为 llm CLI，删除 paths.py 中 ASK_PY/AI_LEGION_PY
  - news-radar：`analyze.py` 从 endpoints.yaml 读 Claude 模型名，替代硬编码 claude-opus-4-7
- **Verified**:
  - `llm deepseek -p "hello" --temperature 0.3` ✓
  - `llm deepseek -p '...' --json-mode` 返回 JSON ✓
  - content-studio `chat()` / `chat_json()` 通过 llm CLI 正常调用 ✓
  - monitor-hub `judge()` deepseek 后端通过 llm CLI 正常调用 ✓
  - news-radar 从 endpoints.yaml 解析到 claude-opus-4-6 ✓
- **Scope note**: content-studio `analyzer/vision.py`（多模态/图片）不在日常管道中，未迁移
- **Next**: agent-gateway 能力迁移评估

### 2026-06-29 — Channel + Orchestrator 重设计
- **Done**:
  - 重新设计 @sm/agent Channel 接口：丰富为 connect/close + onMessage/onAction + reply/update/send，支持 Content 类型联合（pending/result/error/model_selector/approval_request/help）
  - 重写 Orchestrator：平台无关业务逻辑层（ACL 拦截+审批流、/model /help 命令路由、thread→endpoint 追踪、session 管理、CLIRunner 调度、pending→update 流程）
  - 新建 OrchestratorStore（bun:sqlite，sessions + acl_approvals 两表）
  - 移除 @sm/agent 对 @sm/store 的依赖（删除旧 session.ts）
  - 新建 @sm/channel-feishu 包：FeishuChannel implements Channel（WebSocket 连接 + 消息归一化 + Content→飞书卡片渲染），从 SelfAgent 移植卡片构建逻辑
  - bin/feishu-bot.ts 独立入口（env vars 配置）
  - `bunx tsc --build` 全量类型检查通过
- **Decisions**: Orchestrator 做厚 / Channel 做薄——Channel 只管平台 I/O + 卡片渲染，业务逻辑全在 Orchestrator，未来加 Slack/Discord 只需薄适配层
- **Next**: SelfAgent 迁入 monorepo

### 2026-06-29 — SDK/应用分离 + SelfAgent 迁入
- **Done**:
  - 目录重组：cli/ → apps/cli/，新建 apps/ 目录
  - 根 package.json workspaces 改为 ["packages/*", "apps/*"]
  - Orchestrator + OrchestratorStore 从 @sm/agent 移除（应用逻辑不属于 SDK）
  - @sm/agent 精简为纯底座：CLIRunner + Channel 接口 + Content 类型 + 事件类型
  - SelfAgent 迁入 apps/self-agent/，改用 SDK 包：
    - FeishuChannel（@sm/channel-feishu）替代直接操作 Lark SDK
    - Content 类型替代自建卡片 builder
    - ACL 审批改走 Channel.send()
    - 保留应用层逻辑（ACL/命令/session/config/setup）
  - `bunx tsc --build` 全量类型检查通过
- **Decisions**: SDK 是稳定地基（packages/），应用在上面盖楼（apps/），不动地基
- **Next**: 实际部署测试 self-agent、验证飞书 bot 行为一致

### 2026-06-29 — Harness 模式 + 可运行状态
- **Done**:
  - 实现 harness 概念：启动时锁定 endpoint + workspace（CLAUDE.md + rules + skills）
  - 去掉 profile 系统和 /model 命令（模型是 harness 的一部分，不运行时切换）
  - 新增 /new（重置对话）、/info（查看当前 harness）命令
  - 创建 harnesses/assistant/ 默认 harness（harness.yaml + CLAUDE.md）
  - 启动验证通过：setup 全绿、飞书 WebSocket 连接成功
- **Decisions**: 一个进程 = 一个 Channel + 一个固定 harness。不同 agent 类型 = 不同启动参数（HARNESS=xxx）
- **Next**: 飞书端到端消息测试

### 2026-07-10 — 根级安装引导流程
- **Done**:
  - 前置修复：`apps/self-agent/config/server.yaml`（明文飞书密钥）此前未被 gitignore；新增 `server.example.yaml` 模板 + `.gitignore` 追加 `server.yaml`/`data/`；`config.ts` 的 `loadServerConfig()` 首次读取时自动从模板自举
  - 新增 `packages/llm/endpoints.example.yaml`：模型目录模板随仓库分发（结构与当前 `~/.claude/global/endpoints.yaml` 一致，不含明文 key）
  - 新增 `scripts/install.ts`（根 `bun run setup` 入口），六步：环境检查（claude CLI）→ `bun install` → 配置模型（endpoints.yaml 不存在则从模板创建，已存在则 union merge 补新 provider + 交互式补 key 写入 `env_file` + 选默认模型）→ `bun link` 注册所有 `packages/@sm/*` → `bun link` 注册 `apps/cli`（全局 `llm` 命令）→ 扫描 `apps/*` 里声明了 `scripts.setup` 的 app，逐个询问是否安装（约定优于配置，以后加 app 不用改这个脚本）
  - 根 `package.json` 加 `setup` 脚本 + `@sm/llm`/`yaml` 依赖；`scripts/tsconfig.json` 接入根 `tsconfig.json` 的 project references，`scripts/install.ts` 纳入 `bun run typecheck`
- **Verified**:
  - `bunx tsc --build --force` 全量类型检查通过（含 scripts/）
  - 真机跑 `bun run scripts/install.ts` 全流程走完：模型配置走了"已存在→无新增 provider→保留 key/default"的幂等分支，`server.yaml` 未被误覆盖；`bun link` 后 `~/.bun/install/global/node_modules/@sm/` 下 7 个包 + cli 全部就位，`llm` 命令仍可用；Step F 正确发现 self-agent 为唯一可安装 app 并按默认 N 跳过
  - `/tmp` 隔离环境验证了 `server.yaml` 缺失时的自举分支（从 `server.example.yaml` 正确复制出占位符版本）
- **Next**: 无（本轮范围内已闭环）；若未来 `apps/` 下新增 app，只需给它的 `package.json` 加 `scripts.setup` 即可被根安装器自动发现
