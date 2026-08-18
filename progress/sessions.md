# Sessions（倒序，最近 5 条；更早的移入 archive.md）

### 2026-08-18 — codex 审批回调 + multi-agent 子线隔离与 Task 映射(0.7.0)

- **触发**:0.6.0 后的下一批(审批回调/Task 树)。multi-agent 实测顺带暴露 0.6.0 潜伏 bug:**子 agent 的事件走同一 app-server 连接**(带子 threadId)——不按 threadId 过滤,子线 turn/completed 会提前终结整个 run、子线文本混进主回答。
- **Done**(`codex-app-server.ts` + codex.ts):①审批:policy "default" + onCanUseTool 在场 → approvalPolicy "untrusted"(可信白名单命令 codex 自动放行,2026-08-18 实测 echo 直跑/python3 弹审批);`item/commandExecution/requestApproval` → 回调 toolName "Bash"(input.command 取 commandActions 裸命令,非 /bin/zsh -lc 包装)、`item/fileChange/requestApproval` → 回调 toolName "Edit"(diff 从先行 item/started 缓存进 input.changes);allow→accept / deny→decline / abort→cancel(Promise.race 对齐 claude);权限确认模式 preflight 失败**不再静默回退 exec**(审批协议缺位=安全语义降级)→ fail loud 提示升级 CLI。②子线路由:threadId 非主线的通知一律不进主输出;`subAgentActivity`(id=spawn call id、agentThreadId=子线、kind started/interacted/interrupted)→ 合成 spawn_agent 工具卡 + Task started(taskType local_agent);子线工具项挂 parentToolUseId;子线 turn/completed → Task completed(summary=子线最终回答)+ spawn ToolCallDone;子线 tokenUsage → Task progress。collab agentsStates 充当 wait/spawn 输出。capabilities `dynamicPermissionCallback: true`(强制 exec 时 false)。
- **Verified**:单测 48/48;审批 e2e 3/3(`scripts/e2e-codex-approvals.ts`:allow 收 Bash+裸命令→42 落地、deny→item declined+模型答 SKIPPED、multi-agent Result 恰为最后事件+spawn/Task started/completed+summary 391);回归 e2e 11/11(流式/fork/三档 sandbox/abort/exec 强制)。tsc 全绿。
- **Next**:发 0.7.0;trellis 侧三闸已放开(approvalAvailable / route 钳制 / interactive),bump 后真机点权限卡;turn/steer 经评估推迟(树模型无消费位,决策记 trellis decisions.md)。

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
