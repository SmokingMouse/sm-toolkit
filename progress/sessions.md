# Sessions（倒序，最近 5 条；更早的移入 archive.md）

### 2026-08-20 — Codex 图片 argv 边界与静默退出修复（0.8.4）

- **触发**：Harbor 非 Personal Chat 的 Codex 图片 Run 实际失败；附件已成功写入 message/run，CLI 启动阶段报 `Reading prompt from stdin... No prompt provided via stdin.`。
- **根因/改动**：Codex 0.147.0 的 `--image <FILE>...` 是可变长参数，`buildCodexArgs` 原先把 prompt 紧跟其后，prompt 被吞成图片路径。initial/resume 统一改为 `...imageArgs, "--", prompt`；无图也保留分隔符，保护以 `-` 开头的 prompt。Harbor 退役旧 patch 的集成回归又证实 Codex 漏消费 0.8.1 已有的 `exitSink`，现补 `sawTerminal` 终局检查，把 stderr-only 非零退出转为唯一 Error。版本升 0.8.4。
- **Verified**：真实 CLI 正反探针复现/证伪；initial 多图、resume 单图、无图 dash prompt 三条精确 argv 回归；假 Codex exit 23 进程级回归；agent 单测 70/70、package build、`git diff --check` 全绿。
- **Next**：提交并发布 0.8.4；Harbor 升级 0.5.1→0.8.4、删除旧 stderr patch，按 pinned Bun 与真实图片 Run 验收。

### 2026-08-19 — 静默死亡显式化：零终局行退出必吐 Error(0.8.1)

- **触发**:Fisher 生产实录(2026-08-18 晚)——launchd PATH 只有 claude shim 没有真身,shim exit 127 + 零 stdout,ClaudeBackend 零事件"干净"走完,上游把启动失败折算成空回复,买家侧已读不回,全链路无一处报错。
- **改动**:`stream-lines` 加 exitSink(close 写 code / spawn 失败写 spawnError)、'error' 挂监听(Node 无监听 = uncaught)、死因回填 stderrSink、rl.close() 终止读循环(Bun 实测 spawn 失败 stdout 不自行终结,destroy 叫不醒 for-await);`claude` 跟踪 sawTerminal,流走完没见过 result/error 行 → 显式 Error 带 exit code + stderr 尾巴(此前 stderrSink 只在 is_error result 分支被读,该场景等不到 result 行)。
- **Verified**:62/62(新增 4:stream-lines 三态 + 假 claude 脚本复现零输出死亡恰好一个 Error)+ tsc 零错;Fisher 侧同日已加 resolveLoopOutcome 二道兜底(BACKEND_SILENT_EXIT)。
- **Next**:发 0.8.1;Fisher bump 依赖并重启 console 验证。

### 2026-08-18 — Fisher 磨刀石：Claude 四项标准协议补齐(0.7.0)

- **触发**:Fisher 换底座的接口核对充当磨刀石，暴露 `@smokingmouse/agent` 相对官方 claude-agent-sdk 的四个通用缺口；严格不引入 Fisher 审批状态机/guardStub 等域语义，所有字段可选，Codex 行为未改。
- **Done（按 4→2→3→1）**:① `maxTurns` 正整数 → 官方隐藏 `--max-turns` ② `skills` 三态 → initialize payload，`[]` 封住默认 Skill 泄漏 ③ `askTools:"all"` → CLI `permissions.ask:["*"]`，覆盖 settings allow，让全部工具进 `onCanUseTool` ④ `mcpServers` 一等字段：http/stdio 临时 config；sdk 名单进 `initialize.sdkMcpServers`，官方 MCP Server 经 `mcp_message` control protocol 回流宿主执行。
- **参照系**:本机 `@anthropic-ai/claude-agent-sdk` 0.3.207 的 `sdk.mjs/sdk.d.ts`（max-turns argv、initialize skills/sdkMcpServers、canUseTool spawn、SDK MCP transport/control 分支）+ Claude CLI 2.1.207 wildcard 实测；MCP E2E 统一用官方 `@modelcontextprotocol/sdk` 1.29.0。
- **Verified**:agent 单测 58/58 + tsc；真 CLI E2E 四份全绿——maxTurns 一轮截止、skills 默认/空/单名单、全拦 allow+deny 后会话继续、SDK canary `CANARY-7391` + handler throw 存活、http 新字段 connected。任务 3 变异：去掉 wildcard 后 E2E 必红（`intercepted=[]`、deny handler 被执行），恢复后复绿。
- **Commits**:`54ffe3d` maxTurns；`8a8e3fa` skills；`8e9b201` 全拦；`7734a18` mcpServers。包版本已由同期 Codex 线合入提交标为 0.7.0；本轮未 publish。
- **Next**:停在人工 review；确认四项协议与同期 Codex 变更可共同进入 0.7.0 后再发布。
- **后记（同日）**:review 以 PR #15 完成（前两项 maxTurns/skills 已随 0.7.0 出包）;askTools 全拦 + mcpServers 合并后发 **0.8.0**（干净 main 构建,58/58 复核）。

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
