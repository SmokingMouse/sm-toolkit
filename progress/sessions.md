# Sessions（倒序，最近 5 条；更早的移入 archive.md）

### 2026-08-04 — CodexBackend 接入 endpoints.yaml + 本地仓追平 origin
- **背景**：本地 clone 落后 origin/main 70 commit（0.3.1→0.4.0 发包线全在远端）；先在旧 base 做完 codex 端点注入，发现落后后备份改动（/tmp/sm-backup）、ff pull 至 acb0443（0.4.0），在新 base 重放。
- **Done**:
  - `@smokingmouse/llm`：`CodexSettings { wire_api: 'responses' }`，`ProviderConfig`/`EndpointConfig` 加 `codex` 块透传 + 导出；endpoints.yaml（legacy 位 `~/.claude/global/`）cpa 标记 `codex: { wire_api: responses }`（显式 opt-in，chat-only 端点勿标）
  - `@smokingmouse/agent` codex.ts：`resolveCodexModel()` 镜像 claude 版三分支——标记端点 → 真实 model + `-c model_provider(s).sm_endpoint` 五件套注入 + api key 进 spawn env；未标记 / 解析失败 → 原样透传不降级；注入时跳过 `codex login status`（env_key 鉴权不依赖登录态）；`buildCodexArgs` 加 `configOverrides`（exec/resume 共用 common）；capabilities 加 `configDrivenModelSwitch: true`
  - 小补：stderrSink 兜底（turn.failed/error 无信息量时拼 stderr 尾部，对齐 claude）；SessionStart 在注入时回填 model（透传场景仍 null，不冒充全局 config 可能改写的事实）
  - codex.test.ts +3 用例（initial/resume 注入、无注入时 args 与旧行为逐字节一致）
- **Verified**：根级 typecheck 全绿；agent 包 13/13 pass；端到端（gpt-5.4-mini 走 cpa）：`session_start` 带 model 回填、`tool_call`/`tool_call_done` 按 id 配对且 output `trellis-e2e\n` 回传、负向坏 `CPA_API_KEY` → 401 且 url = 注入 base_url（判别性证明非 fallback 全局 config.toml bearer）
- **能力打平备忘（trellis 选 codex provider 视角）**：0.3.2 已补事件面（工具生命周期 id 配对 + aggregated_output / reasoning→Thinking / web_search）；本轮补注入 + model 回填 + stderr 兜底。剩余是 codex CLI 天花板：onCanUseTool 双向审批（trellis PendingInteraction 在 codex 下不可用）、逐 token 流、forkSession、tools 白名单 / askTools、settingSources。cost 仍 CODEX_PRICE 估算（estimated:true 契约诚实；trellis 记 token 不记 usd）。
- **Next**：发版 `@smokingmouse/llm` + `agent`（minor）trellis 才吃得到注入；发布动作待用户确认。

### 2026-08-04 — 归档：README Current Focus 迁移前原文快照
**拆仓：SDK 与个人基础设施分家（2026-07-25）**：本仓收敛为纯开源 SDK——`@smokingmouse/llm`（0.3.0，chat 直连客户端）+ `@smokingmouse/agent`（0.3.1，Claude Code / Codex CLI 编排引擎）+ `apps/cli`（llm 命令行壳）。npm 发包已完成（2FA + granular token；两包均 `--access public`）。迁出：apps/harbor + apps/harbor-web + packages/channel-feishu → 私仓 `SmokingMouse/harbor`（filter-repo 保留 100 commit 历史，deps 切 registry，tsc + 456 tests 全绿）；同轮清掉零消费者的 @sm/store / audit / sandbox / guardrails 与 archive/self-agent（历史可捞）。**注**：harbor 历史仍在本公开仓 git history 中（评估不值得重写历史，代码无凭证）；harbor 控制面对本仓的 GitHub App / Repository binding 重绑在 harbor 仓侧待办。

### 2026-07-25 — npm 发包完成 + 拆仓
- **Done**：`@smokingmouse/llm@0.3.0` / `agent@0.3.0` 发布（agent 随后补 0.3.1——0.3.0 发布点早于 harbor 线 merge，缺 `IncomingMessage.resources` 等演进）；harbor 三件套迁出至私仓；死代码集群与 archive/self-agent 移除；root tsconfig references 收敛。
- **Verified**：公开仓 `bun install` + `tsc --build` 全绿；trellis 从 registry 全新安装 + prod 验活（见 trellis progress S72）；harbor 私仓独立验证 456 tests pass。
- **追记（同日）**：`@smokingmouse/cli@0.3.0` 发布——@sm/cli 改名，bin `llm`（bun shebang），dep llm ^0.3.0。任何机器 `bun install -g @smokingmouse/cli` 一步可用；本机既有 bun link 不受影响。三包齐：llm 0.3.0 / agent 0.3.1 / cli 0.3.0。

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

### 2026-07-15 — claude 后端 --setting-sources 改等号形式（工作机 0 输出修复上游化）
- **触发**：工作机 pull trellis a29f9b5 后 chat 仍 0 输出，排查是 `("--setting-sources", "")` 的独立空字符串 argv 在该机 runtime 下被丢弃 → `--strict-mcp-config` 被当成 setting-sources 的值 → CLI 报错退出。本机 bun 1.3.14 实测**不**吞空 argv（不复现），但等号形式把值焊死在同一 argv 里对 runtime 差异免疫，语义不变（仍是"不加载任何 settings source"，不是工作机临时用的 `=local`——那会让真实 cwd 的 caller 突然加载 .claude/settings.local.json，通用 SDK 不做该语义漂移）。
- **验证**：`--setting-sources=` 与 `=local` 裸 CLI 均实测接受；trellis 隔离实例真 spawn 纯 chat 回答正常。
- **Next**：工作机收敛——`git checkout -- packages/agent/src && git pull && bun run build`（其手工 Thinking 补丁与上游 a3ce7b2 等价，等号修复本条已含）。

