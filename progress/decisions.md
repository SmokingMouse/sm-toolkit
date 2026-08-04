# Decisions(轻量决策;重量级 ADR 进 decisions/)

## 2026-08-04 — 推迟 codex app-server(Phase 2)接入
- **Decision**:codex 逐 token 流 + 双向审批的 app-server JSON-RPC 路线,评估完成但暂不实施;CodexBackend 维持 exec --json 路径(capabilities 保持 `streaming: "block"`、`dynamicPermissionCallback: false`)。
- **Why**:①协议官方标 experimental 且 v1/v2 两套 schema 并存(换代期,漂移风险高,codex 对内部面无兼容承诺——wire_api="chat" 有废弃前科);②sandbox/approval 语义需从 CLI flag 整体重映射成 `sandboxPolicy`/`approvalPolicy` RPC 参数,映射错一档是静默安全破洞(harbor Codex worktree 写权限建在现有 flag 语义上),验收需逐档 exec vs app-server 行为对照;③多设备 codex 版本参差(Mac mini 0.142.2 / 本机 0.146.0)正跨在协议换代期。
- **已确认的收益(实测,2026-08-04 codex 0.146.0)**:app-server stdio JSON-RPC 握手可用;v2 协议有完整 delta 通知族(AgentMessageDelta / ReasoningTextDelta / CommandExecOutputDelta…)、五种审批请求(ApplyPatch / CommandExecution / ExecCommand / FileChange / Permissions)、原生 `thread/fork`。schema 可由 `codex app-server generate-json-schema --out <dir>` 导出。
- **重启条件**:协议脱 experimental 或 v2 收敛、设备版本统一后再评估;第一版建议 per-run spawn(免 daemon 管理)+ exec fallback + 逐档安全对照测试。届时 forkCodexSession 的 rollout copy 可退役为旧版本 fallback(app-server 走原生 thread/fork)。
