# SM-Toolkit Progress

## Current Focus

Harbor P4.7「控制台 UI 重塑」已完成：八页统一为“港口调度台”视觉语言，桌面与窄屏真实浏览器验收通过；当前回到 P5 时间性验证，等待真双机 / 真飞书 / automation 7 天 / dogfood 一周。

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
- [ ] **Harbor（个人多设备 Agent 调度平台，Mew 复刻）** — 主方案 `progress/harbor.md`。P1–P4.7 已完成（P4.7 控制台 UI 重塑见 `progress/harbor-ui.md`）。仅剩 P5 时间性验证——真双机 Tailscale、真飞书群冒烟、automation 连跑 7 天、真实负载一周，全部依赖用户环境

## Verified Facts

- **claude CLI 的路由优先级**：env 注入的 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 优先于本机 OAuth 登录态——本地假服务器实测（2026-07-14），所有 `/v1/messages` 请求均打到 env 指定的 base_url 且带 `Bearer <token>`，零请求流向官方；`--bare` 有无不影响路由归属。因此"指定三方 endpoint 却悄悄用官方模型"在 env 齐全时不存在。
- **super-relay 等字节内部代理认 `ANTHROPIC_AUTH_TOKEN`（Bearer），不认 `ANTHROPIC_API_KEY`**；两个都设可兼容不同版本 claude CLI。
- **claude 2.1.207 的 can_use_tool 双向审批需要 initialize 握手**（2026-07-15 实测）：spawn 后客户端必须先向 stdin 发 `{"request_id":...,"type":"control_request","request":{"subtype":"initialize","hooks":{}}}`，claude 回 success 后才把权限请求以 `control_request(can_use_tool)` 下发 stdout；不握手则 `--permission-prompt-tool stdio` 被静默忽略、headless 对需授权工具直接 auto-deny（agent-gateway 时代 2.1.167 无此要求，属行为漂移）。该 flag 已从 `--help` 隐藏；`--permission-mode` 选项改为 acceptEdits/auto/bypassPermissions/manual/dontAsk/plan，旧值 `default` 仍兼容（=manual）。修复落在 `@sm/agent` ClaudeBackend。
- **设备全局 `~/.claude/settings.json` 的 permissions.allow 优先于审批链路**：allowlist 的工具（本机 Bash/Read/Edit/Write/WebFetch 全在）永不触发 can_use_tool——审批只覆盖「未 allowlist 且当前模式要求确认」的工具，是机器级信任的预期行为。e2e 测审批必须隔离 `CLAUDE_CONFIG_DIR`。
- **croner 的模式回溯 `previousRuns(n)` 是 v10 才有的 API**；v9 的 `previousRun()` 返回实例自身运行历史（新实例恒 null），拿它做停机 missed 检测形同虚设。另：bun 对 workspace 外的脚本会回退解析全局缓存里的别版本包——调试依赖行为先 `require.resolve` 确认实际加载路径。

## Session Log

### 2026-07-17 — kimi k3 接入 + provider 级 claude env 覆盖层
- **触发**：把用户的 ck() shell 函数（kimi coding API 启动 claude）收进 llm CLI；顺带落地「不同接入点配不同 env，全局 + 定制覆盖」。
- **Done**：
  - @sm/llm：`ProviderConfig`/`EndpointConfig` 加可选 `claude?: ClaudeSettings`（provider 级块随 resolveEndpoint 透传）；anthropic provider 直调对 base_url 端点补 `Authorization: Bearer`（与 x-api-key 双发——super-relay/kimi 类代理只认 Bearer；官方 API 不加，防 key 被当 OAuth token 校验）。
  - apps/cli `execClaude`：推导 tier 补 `ANTHROPIC_DEFAULT_FABLE_MODEL` + `ANTHROPIC_SMALL_FAST_MODEL`（所有代理 endpoint 受益）；env 合并优先级 = 自动推导 < 全局 claude.env < provider claude.env，args = `--model` + 全局 + provider 追加。
  - @sm/agent ClaudeBackend：`resolveClaudeModel` 对 base_url endpoint 注入三件套后追加 provider 级 claude.env——provider 块是端点正确性配置，headless 同样生效（用户追问「为啥不复用」后补齐）。
  - endpoints.yaml（真实 + example）：新增 kimi provider（`anthropic_url: https://api.kimi.com/coding`，模型 k3 / kimi-for-coding-highspeed / kimi-for-coding），provider claude.env 只写与推导/全局的差异项（OPUS/SONNET/SMALL_FAST→highspeed、HAIKU→kimi-for-coding、FABLE=k3 显式写因 headless 无推导层、SUBAGENT_MODEL=k3、1M 的 MAX_CONTEXT/AUTO_COMPACT、FORK_SUBAGENT/AGENT_TEAMS 实验开关、`ANTHROPIC_API_KEY: ""` 清空防 x-api-key 冲突）。
- **Verified**：全量 tsc ✓；stub claude 实测 llm launch 路径 kimi 三层合并全对（API_KEY 覆盖为空 / tier 差异映射 / 1M 窗口 / 全局 env+args 保留）、deepseek 回归正常（双 key、全 tier 含新增 FABLE/SMALL_FAST 推导）✓；stub 实测 ClaudeBackend 路径 kimi（provider env 全量注入 + API_KEY 清空 + args 无全局项泄入）、deepseek（仍恰好三件套，零漂移）✓；本地假 server 实测 anthropic 直调双 header + `/v1/messages` 拼接 ✓。
- **真 key 冒烟（同日，key 已入 env_file）**：直调 `llm k3 -p` 正常返回（kimi 接受 x-api-key+Bearer 双 header 并存）✓ ClaudeBackend 真 claude headless 跑 k3 成功（Bearer 认证 + API_KEY 清空生效，result 带真实 cost $0.065）✓。交互 launch 与 headless 共用同一 env 注入层，未单测 TUI。
- **作用域设计**（问「为啥不复用」的答案）：endpoints.yaml 主体（base_url/key/模型解析）两条路径一直共用；provider 级 claude.env 跟 endpoint 走、两路径注入；**全局 claude: 块与 args 仅交互 launch**——EFFORT_LEVEL=max 进 headless 会漂移全部 harbor run 成本，`--dangerously-skip-permissions` 会绕过审批链。
- **触发**：agent-gateway 仓库退役时 chat 能力拍平进了 @sm/agent/@sm/llm，但 vision（图/视频/音频理解）与 image（Imagen/codex 生图）两块多模态没迁——ai-legion 四脚本全断，连带 svg-diagram 审图、xianyu-listing-kit 生图/质检、x-api 转写、article-illustrator/xhs-cards/writecraft 配图管线失能。
- **Done**：
  - `packages/llm` 新增三模块：`gemini.ts`（从 endpoints.yaml 发现 Gemini 原生 REST 根+key，不硬编码 provider 名）、`vision.ts`（图片 openai-compat inline base64；视频/音频 Gemini Files API 上传→轮询 ACTIVE→generateContent）、`image.ts`（Imagen `imagen-4.0-fast-generate-001:predict` 带 withRetry；codex exec 生图用 mkdtemp 独占工作区替代旧快照差集，天然并发安全，产出移回输出目录，targetSize 走 sips）。`LLMClient` 加 `vision()`/`image()` 方法。
  - `apps/cli`：新增 `llm vision` / `llm image` 子命令、`--list --json`（provider 状态 JSON）、`--fallback "a,b"`（走 chatWithFallback，链由调用方供给）。
  - ai-legion 四脚本（ask/vision/image/status.py）后端从 agent-gateway CLI 切到 llm CLI，**对外参数面不变**（下游零改动）；长 prompt 走 stdin 管道防 ARG_MAX。config.yaml/SKILL.md 同步（qwen 退役标注、Extending 指到 @sm/llm）。
  - 下游解耦 content-studio venv：svg-diagram review.py / xianyu gen_image.py+check_image.py / x-api x_api.py 的解释器改 `/usr/bin/python3`（ai-legion 纯 stdlib，3.9 实测可跑）。
- **Verified**（全部实测）：`llm --list --json` ✓ `--fallback` chat ✓ vision 图片（比特币图正确描述）✓ vision 音频（say 生成 m4a → Files API 上传轮询转写）✓ imagen 生图（1024×1024 PNG 落盘；首跑遇瞬时 API 错误，已补 withRetry）✓ ai-legion status/ask/ask--json/vision/image 五路 ✓ 系统 python3.9 跑 vision.py ✓；codex 生图路径已发起（~2min 异步确认）。
- **Next**：codex 并发生图（多进程 mkdtemp）真实场景观察；content-studio 已无 skill 层依赖，可择机退役。

### 2026-07-16 — P4.7 控制台 UI 重塑完成
- **Decision**：采用“个人港口调度台”而非通用 SaaS 白卡片：暖灰画布、深海墨色侧栏、航标绿主色，运行状态和设备事实优先；不改变信息架构与业务行为。仓库无 Story checkpoint，方向由现有源码、`progress/` 与实际页面截图推导。
- **Done**：重做全局 token、字体、focus、动效、Modal / Toast / button / field / status badge；侧栏加入分组图标导航、连接态与窄屏图标轨；Devices 增加 fleet metrics、接入终端、provider / agent / endpoint 事实卡；Agents 增加 ready metrics、执行配置卡与两列分组创建表单；Settings 改为连接卡 + Prompt pipeline 工作台；Issues 五列、Chats 双栏、Automations / Approvals / Usage 表格与标题体系同步收口。
- **Verified**：harbor-web `tsc --noEmit`、Next static build 全过；agent-browser 1280×720 实测八页，Issues 五列全显、New Agent footer 可达、各页 `scrollWidth === innerWidth`；760×720 Devices 实测侧栏折叠且无页面横溢。最终截图见 Codex visualizations 目录，预览 server:17777 health 正常。
- **Next**：P5 时间性验证不变——真双机、真飞书、automation 连跑 7 天、真实负载一周。

### 2026-07-16 — P4.6 个人控制面产品化完成
- **Decision**：范围固定为 daemon lifecycle、Devices、Provider capability validation、Prompt wrapper；不扩到团队权限、Skills/Integrations 或 server service。领域边界、持久化选择与验收见 `progress/harbor-control-plane.md`，共用术语见 `progress/glossary.md`。仓库无 Story checkpoint，本期意图以 git、`progress/` 与源码为证据。
- **Done**：
  - **Daemon lifecycle**：`harbor daemon setup|status|logs|uninstall`，覆盖 macOS launchd / Linux systemd user service；setup 幂等、保留式写 `~/.harbor.yaml`（0600），definition 只含 bun/入口/HOME/PATH、不含 token；status/logs/uninstall 无 token 也可用。
  - **Provider capability**：Agent 创建强制 backend ∈ 设备实报 CLI；未指定时优先 Claude、否则唯一可用 provider；Claude 模型按 native tier/endpoints 校验，Codex model 交 CLI；Codex 禁止伪装成 `default` 动态审批。Web 表单 device→provider→model 联动，现存 Agent provider 丢失会告警。
  - **Prompt wrapper**：SQLite v3 `prompt_templates`；issue/chat/automation 三套默认模板、白名单变量、`{{prompt}}` 强制保底；scheduler 只在 dispatch 时渲染，raw `runs.prompt` 不变。REST + Settings 支持编辑、禁用、恢复默认。
  - **Devices**：新增第八个 Web 导航页，展示在线/last seen、CLI 版本、Claude endpoints、关联 Agents 与可复制 daemon setup 命令。
- **Verified**：11 个 Bun 定向测试 / 37 assertions 全过；Harbor `tsc --build`、harbor-web `tsc --noEmit` + Next static build 全过；SQLite 实迁 v3。isolated launchd 真机重复 setup、logs、无 token status、kill 后 KeepAlive（PID 75360→75529）、uninstall 全过。REST 实测默认/非法/保存/恢复模板与 Agent 创建；agent-browser 实测 Settings、Devices 实机双 provider、Agents 联动、模板保存回读，截图人工检查无布局问题。
- **Environment boundary**：当前 7777 由 VS Code NodeService 转发 Harbor API，本地无对应 `~/.harbor.yaml`，未擅自接管；测试用 17777 + 临时 HOME，service/server/browser/临时文件均已清理。
- **Next**：P5 时间性验证不变——真双机、真飞书、automation 连跑 7 天、真实负载一周。

### 2026-07-16 — P4.5 harbor-web 实施完成（七页操作台上线，单文件看板退役）
- **Done**：
  - **后端三补丁**（`apps/harbor/src/server/`）：①`GET /api/conversations/:id` runs[] 附 `resultText`（store.getRunResultText，prune 后 null）②`PATCH /api/agents/:id {archived}` + `store.setAgentArchived`（软删除可逆）③删 `dashboard.ts` 单文件看板，rest.ts 尾部 catch-all 静态 serve `apps/harbor-web/out/`（`import.meta.dir` 相对定位不依赖 cwd、路径穿越防护、`.html` 补全、miss fallback index.html、`/_next/` immutable 缓存、out/ 缺失提示 build 命令）。
  - **harbor-web 全新前端**（`apps/harbor-web/`，Next 15.5 app router `output:'export'` + React 19 + Tailwind v4，纯 CSR，dev rewrites 代理 7777 只挂 dev phase）：七页 = Issues 五列 kanban（New Issue 派活/抽屉 statusLog 时间线/runs 流水含 resultText/SSE 事件回放直播/continue 串行闸 400 toast/done/cancel 确认/状态菜单）、Chats（草稿态首条消息落库 title=prompt 前 60 字/流式气泡 thinking 折叠 tool 摘要/串行闸禁发/历史=prompt+resultText 气泡）、Agents（卡片+device→model 联动下拉 datalist 可手输/服务端校验错误原样 toast/归档）、Automations（表格+行展开 log/enable·disable·删除/cron 语法提示/append target 下拉）、Approvals（红点徽标 30s 轮询/input 预览/30min 倒计时/批准拒绝幂等提示/历史折叠）、Usage（$/日 SVG 柱图+明细表+7/14/30 天切换）、Settings（token localStorage+保存后 reload+连接自检）。共享层：`lib/api.ts`（fetch Bearer/401 跳 Settings/SSE reader fetch+AbortController，类型从 harbor protocol.ts 相对路径 import type 零运行时依赖，运行时常量本地复制）、`usePoll`（10s 列表轮询）、toast、`components/run-stream.tsx`（useRunFrames + foldFrames 帧折叠 + EventLog 终端风回放）。
  - **Verified**（本机 e2e，agent-browser 全自动，判据 1-8 全过）：全新 profile token 门→七页可达；无效 model 报错 toast 含完整能力清单+有效创建；issue 派活→backlog→doing→review 自动流转→回放直播（thinking/Write 工具行）→continue 上下文连续（答出上轮文件名）→done，文件真实落盘；chat 草稿→流式渲染+串行闸禁发→第二条 resume（答出暗号 seahorse）→刷新历史仍在（resultText 生效）；审批 allow（隔离 CLAUDE_CONFIG_DIR daemon，红点→网页批准→续跑→文件落盘）/deny（文件未写入）；automation 每分钟 cron fired 两次入 log→disable 止血（下一分钟无触发）；usage 与 `harbor usage` CLI 全额一致（$0.4034/6 runs）；全程 harbor-server:7777 单进程 serve（next dev 零参与）+ 路径穿越防护/缓存头抽查。
- **实施中修的三个坑**（方案外新增）：①TS 6.0 新增 TS2882 检查 side-effect import——next 只声明 `*.module.css`，裸 `import "./globals.css"` 报错，补 `globals.d.ts` 的 `declare module "*.css"`；②Settings 保存 token 后 600ms `location.reload()`，否则 Shell 连接点/红点要等 30s 下一拍轮询；③Modal 长表单在矮视口下按钮被 clip 在卡片滚动区外（Playwright 点击直接失效暴露）——新增 `ModalFooter` sticky bottom 组件，四个 modal 统一，真实小屏可用性同步受益。
- **Next**：P5 时间性验证不变（真双机/真飞书/automation 7 天/dogfood 一周）；体验稳定后 nohup 换 launchd 常驻。

### 2026-07-16 — Harbor 服务拉起 + P4.5 可操作 Web 平台方案
- **Done**：正式环境首次拉起（`~/.harbor.yaml` 生成、`harbor-server`/`harbord` nohup 后台、db 落 `~/.harbor/harbor.db`、设备 SmokingMousedeMac-mini.local 注册、看板可访问）；用户 dogfood 第一反馈「要能直接在平台上操作」（Mew 截图对标）→ P4「写操作按体感再加」判断点兑现，定稿 `progress/harbor-web.md`（Next.js 静态导出 + server 单进程 serve + 删单文件版；含后端三项小补丁清单 / 七页信息架构 / 验收判据 / pitfalls，自包含可另 session 直接执行）。
- **Next**：另 session 按 harbor-web.md 实施；本机进程目前 nohup 挂载，体验稳定后配 launchd 常驻。

### 2026-07-15 — Harbor P2+P3+P4 一次落地 + self-agent 退役（方案收尾）
- **Done**：
  - **P2**：审批链路全闭环（daemon onCanUseTool → approval_req → 落库 → 飞书卡片/CLI 双通道决议 → approval_res resolve → claude 原地续跑；30min sweep 过期 deny、重复点击幂等、重连补投、run 终态作废 pending）；worktree 生命周期（per-issue 建/复用/回填路径、done/cancel 收尾保留分支删目录、dirty 拒删、设备离线重连补发、prune 自愈）；FeishuEntry（`<agent> <指令>` 话题映射、/bind /chat /status /done /cancel /agents /help、ack 卡原地更新为结果、failed 无静默告警、send-gate 三场景 + admin-only ACL）；@sm/agent Content 加 `tool_approval` + channel-feishu 卡片渲染 + `sendToChat`。
  - **P3**：croner v10 调度（fired/missed 双日志、停机跳过不补跑）、`harbor usage` 聚合+下钻、run_events 7 天 prune、`~/.claude/skills/harbor` skill、三 bin `bun link` 全局。
  - **P4**：决策变更——不引 Next.js，server `GET /` 直出单文件看板（kanban/issue 抽屉含 status_log 时间线/run 事件回放含直播/用量图表；token localStorage）。
  - **修复上游**：@sm/agent ClaudeBackend 交互模式补 **initialize 握手**（claude 2.1.207 行为漂移，细节见 Verified Facts）；P1 遗留 bug 两枚——run 结束的自动流转会覆盖人工 done/canceled（加终态尊重 guard）、同 conversation 可并行 run 导致 resume 分叉（加串行闸）；issue cancel 现在级联 run_cancel。
  - **self-agent 退役**：`apps/self-agent` → `archive/self-agent/`（RETIRED.md 含能力去向表 + 凭证迁移步骤），workspaces/tsconfig/.gitignore 同步。
- **Verified**（本机 e2e，deepseek-v4-flash 真跑 + 隔离 CLAUDE_CONFIG_DIR）：v1→v2 迁移无损；审批 allow（watch 提示→CLI 批→续跑→文件落盘）/deny（文件未删）/expire（老化 31min→sweep 自动拒）/cancel 级联四路径；同 repo 双 issue 并行 worktree 互不可见+分支独立+主仓库干净；dirty 拒删→commit 后重连补发删除成功；非 git workdir 报错带 git 原文；automation 每分钟连发 6 次+停机 missed 留档+enable/disable；usage 与 DB 原始 sum 全额一致（15 runs/$0.8641）；串行闸拒绝并行；resume 上下文连续（模型答出上一轮文件路径）；108KB 工具输出截到 8KB 带标记；prune 清 24 行老化事件；离线派活排队提示+上线自动跑；看板 agent-browser 实测（5 列/抽屉/回放/用量图截图确认）；飞书 mock e2e 23 项断言全过。
- **Decisions**（已回写 harbor.md 各期）：P4 单文件看板取代 Next.js（只读期零进程零构建，真要写操作再立）；审批双通道先到先得；ACL 简化 admin-only；飞书话题锚 `chatId|anchor`。
- **Next**：用户侧时间性验证——①真双机（Tailscale + `~/.harbor.yaml`）②飞书凭证迁 `~/.harbor.yaml` 后真群冒烟（步骤见 `archive/self-agent/RETIRED.md`，注意先停旧 self-agent 进程防双响应）③automation 连跑 7 天 ④dogfood 一周（P5 终验清单）。

### 2026-07-15 — claude 后端 --setting-sources 改等号形式（工作机 0 输出修复上游化）
- **触发**：工作机 pull trellis a29f9b5 后 chat 仍 0 输出，排查是 `("--setting-sources", "")` 的独立空字符串 argv 在该机 runtime 下被丢弃 → `--strict-mcp-config` 被当成 setting-sources 的值 → CLI 报错退出。本机 bun 1.3.14 实测**不**吞空 argv（不复现），但等号形式把值焊死在同一 argv 里对 runtime 差异免疫，语义不变（仍是"不加载任何 settings source"，不是工作机临时用的 `=local`——那会让真实 cwd 的 caller 突然加载 .claude/settings.local.json，通用 SDK 不做该语义漂移）。
- **验证**：`--setting-sources=` 与 `=local` 裸 CLI 均实测接受；trellis 隔离实例真 spawn 纯 chat 回答正常。
- **Next**：工作机收敛——`git checkout -- packages/agent/src && git pull && bun run build`（其手工 Thinking 补丁与上游 a3ce7b2 等价，等号修复本条已含）。

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
