# Sessions（倒序，最近 5 条；更早的移入 archive.md）

### 2026-08-18 — CodexBackend 接入 app-server transport:codex 逐 token 流(0.6.0 第二批)

- **触发**:trellis 反馈 codex provider 无流式/工具卡/子 agent。调研(两 research agent 挖 openai/codex 0.147 源码 + 本机三组协议探针)推翻推迟前提:v1 会话 API 已整体移除、v2 唯一默认;TUI/exec 自身也是 app-server 客户端;exec --json 的 delta 是输出层**有意丢弃**(event_processor_with_jsonl_output.rs 兜底分支)且无 flag 可开;官方 Python SDK 即 app-server stdio 客户端。实测 app-server `thread/resume` 直接续 exec 录的 rollout(同一存储、id 互通),切换不孤儿化存量会话。
- **Done**(新 `backends/codex-app-server.ts` + codex.ts 分派):per-run spawn `codex app-server`(stdio JSON-RPC v2)——initialize → thread/start|resume|fork → turn/start;通知映射:agentMessage/delta→TextChunk(退订时靠 completed 余量补发=block)、reasoning summary/textDelta→Thinking、item 生命周期→ToolCall/Done(含 collabAgentToolCall 多 agent / dynamicToolCall / imageGeneration)、fileChange→FileChange、tokenUsage→Cost(净 input/cacheWrite→cacheCreation/context 取 last);原生 thread/fork 替代 rollout copy;abort→turn/interrupt(2s grace 再 SIGTERM);审批类 server 请求自动拒答防挂死。**preflight 契约**:turn/start 响应前零事件产出,失败抛 AppServerPreflight 静默回退 exec(prompt 绝不跑两遍);`codexTransportPlan` 纯函数预分流不支持组合(environmentSkills=false / extraArgs / ephemeral resume)走 exec;`CodexBackendOptions.transport:"exec"` 逃生舱;capabilities streaming 如实报 "token"/"block"。
- **Verified**:单测 40/40(新 17:transport 决策矩阵 / 逐档 sandbox 映射对齐 buildCodexArgs / item 映射 / cost 映射);真机 e2e 10 项全过(`scripts/e2e-codex-appserver.ts`):流式 100 chunks vs 强制 exec 1 chunk、resume 同 id 记忆在、fork 新 id 且父线不见子线暗号、readonly OS sandbox 拒写、workspace-write 圈内可写、full 圈外可写、abort 5.5s 收尾无 Result、usage 合理。tsc 全绿。改动留工作区**未 commit**(与 08-17 批同归 0.6.0)。
- **注意**:approvalPolicy 恒 "never"(非交互 parity);onCanUseTool 仍未接(独立 phase,需上游 dispatcher);experimental 标签仍在,锁 schema + exec fallback 对冲协议漂移。
- **Next**:用户 review 后两批同发 0.6.0;trellis `bun update @smokingmouse/agent` 即自动获得 codex 流式(零代码改动);后续独立 phase:审批回调(dynamicPermissionCallback)、turn/steer、subAgentActivity→Task 映射。

### 2026-08-17 — 外部 MCP 契约三件套：settingSources 数组 + delayFirstMessageMs + resolveClaudeModel 导出（Codex 执行 + Claude review）

- **触发**：Fisher（闲鱼底座）迁移评估点出三个契约缺口。任务书 `/tmp/sm-agent-contract-task.md` 派 Codex 执行，Claude review + 解 E2E blocker。
- **Done**：① `resolveClaudeModel` 包根导出 + 三档单测（Fisher agent-loop 手拼的同构逻辑将换成引用，那份缺 provider 级 claude.env 合并）② `settingSources: boolean | Array<'user'|'project'|'local'>`——boolean 行为逐字节保持，`[]` 与 false 对齐走 `--setting-sources=`；08-01 外部 MCP pending 与 07-15 全局 allowlist 两条实测知识进类型注释 ③ `delayFirstMessageMs`：独立于 onCanUseTool 也开常开 stream-json stdin；与 onCanUseTool 组合时 control initialize 立即发、只延 user prompt；`claudeInputMode` / `claudeSettingSourceArgs` 抽纯函数锁行为；codex 惰性忽略 ④ SessionStart 补透传 `mcp_servers`（review 时补：不透传则上游在事件流里永远无法核验「MCP 真就绪」）。
- **🔴 waitForMcpServers 被前置探测证伪，不实现**：stream-json stdin 常开、不写首条消息，5 秒 stdout 只有 hook 行、**零 system/init**——CLI 要收到首条 user message 才吐 init，「等 init 再发首条」= 死锁。该模式下固定延时是唯一可行形态。
- **E2E 波折**：Codex 手写 JSON-RPC server 的握手不被 CLI MCP client 接受（5 次 initialize 重试，永不到 tools/list）→ 判据如实记 0/3 blocked；换官方 `@modelcontextprotocol/sdk` StreamableHTTP（stateless 模式）后 **3/3**（init `probe: connected` + 真 ping tool_use + canary 原文；`delayFirstMessageMs: 300` + `settingSources: ['user']` + 显式 --mcp-config）。复跑脚本 `/tmp/mcp-e2e/rerun-e2e.ts`，证据 `rerun-output.json`。
- **Verified**：`tsc --build` 全绿；`bun test` 23/23（基线 16）；runner.ts 冻结未动；真 CLI 调用 Codex 5 次 + 复跑 6 次。改动留工作区**未 commit**。
- **Next**：用户 review 后发 0.6.0（minor）；SdkBackend（进程内 claude-agent-sdk 封装，Fisher 换底座前置）待依赖决策（倾向 optional peerDependency）。

### 2026-08-05 — CodexBackend 解析降级不再伪装成登录问题(0.5.1)

- **触发**:trellis 二号机指定了 cpa provider 仍报「codex 未登录」。根因不在登录——那台机器的 endpoints.yaml 没有 codex 标记(标记躺在一号机 ~/.claude 未提交改动里),resolveCodexModel 静默降级成透传后撞上登录闸,配置漂移伪装成登录问题。
- **改动**(`backends/codex.ts`):拆掉一揽子 catch——①端点在 yaml 但无 codex 标记 → 仍透传(opt-in 语义不变)但带 `degraded` 原因,登录闸失败时拼进报错;②端点已标记注入但 key 缺失 → `fatal` 直接报错不 spawn(配置自相矛盾时静默换鉴权路线是把配置错误变成别的症状);③不在 yaml → 照旧透传。登录闸报错永远带诊断(degraded 原因或通用指引)。
- **Verified**:四分支子进程实测(SM_ENDPOINTS_PATH 指 yaml 变体 + 假 codex 二进制)——key 缺失报 fatal 且点名 env var;无标记+未登录报「yaml 没同步」;标记+key 齐时登录闸被跳过(假 codex login 恒 exit 1 仍 NO_ERROR)且 argv 含 `-c model_provider="sm_endpoint"`、spawn env 含 key;原生名+未登录给通用指引。tsc build 零错。
- **Next**:发 agent@0.5.1;trellis bump 并按 facts 清单验 registry 产物。

### 2026-08-04 — CodexBackend 实现 forkSession(rollout copy 模拟 headless fork)
- **机制**:codex exec 无 fork 子命令(交互版 `codex fork` 有)。`forkCodexSession()` 把父 thread 的 rollout jsonl 复制成新 uuid(文件名 + 全文替换 id)再 resume 新 id;失败 fail loud——静默线性 resume 会让树形分支共写同一 thread 互相污染。claude/codex capabilities 均补 `forkSession: true` 供上游探测。
- **Verified**:单测 3 个(复制改写 id / 同父双 fork 互异 / 缺档 throw),agent 16/16;端到端:fork 出新 id、答出父线暗号(历史继承),fork 线 cachedTokens 79k(前缀相同 → provider prompt cache 命中,cache 继承白捡);CLI 层已验证双向隔离(fork 写入新暗号,父线不可见);负向 fail loud 带 id + 路径。
- **注意**:resume 必须带与录制一致的 -m(model 漂移曾实测触发上游 400);rollout 格式是 codex 内部实现,版本升级需回归(0.146.0 实测)。
- **Next**:已完成——llm@0.4.0 + agent@0.5.0 同日发布。

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
