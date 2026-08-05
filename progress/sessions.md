# Sessions（倒序，最近 5 条；更早的移入 archive.md）

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

### 2026-08-04 — 归档：README Current Focus 迁移前原文快照
**拆仓：SDK 与个人基础设施分家（2026-07-25）**：本仓收敛为纯开源 SDK——`@smokingmouse/llm`（0.3.0，chat 直连客户端）+ `@smokingmouse/agent`（0.3.1，Claude Code / Codex CLI 编排引擎）+ `apps/cli`（llm 命令行壳）。npm 发包已完成（2FA + granular token；两包均 `--access public`）。迁出：apps/harbor + apps/harbor-web + packages/channel-feishu → 私仓 `SmokingMouse/harbor`（filter-repo 保留 100 commit 历史，deps 切 registry，tsc + 456 tests 全绿）；同轮清掉零消费者的 @sm/store / audit / sandbox / guardrails 与 archive/self-agent（历史可捞）。**注**：harbor 历史仍在本公开仓 git history 中（评估不值得重写历史，代码无凭证）；harbor 控制面对本仓的 GitHub App / Repository binding 重绑在 harbor 仓侧待办。

### 2026-07-25 — npm 发包完成 + 拆仓
- **Done**：`@smokingmouse/llm@0.3.0` / `agent@0.3.0` 发布（agent 随后补 0.3.1——0.3.0 发布点早于 harbor 线 merge，缺 `IncomingMessage.resources` 等演进）；harbor 三件套迁出至私仓；死代码集群与 archive/self-agent 移除；root tsconfig references 收敛。
- **Verified**：公开仓 `bun install` + `tsc --build` 全绿；trellis 从 registry 全新安装 + prod 验活（见 trellis progress S72）；harbor 私仓独立验证 456 tests pass。
- **追记（同日）**：`@smokingmouse/cli@0.3.0` 发布——@sm/cli 改名，bin `llm`（bun shebang），dep llm ^0.3.0。任何机器 `bun install -g @smokingmouse/cli` 一步可用；本机既有 bun link 不受影响。三包齐：llm 0.3.0 / agent 0.3.1 / cli 0.3.0。
