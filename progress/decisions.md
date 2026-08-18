# Decisions(轻量决策;重量级 ADR 进 decisions/)

## 2026-08-18 — 解除 app-server 推迟,CodexBackend 接入(Phase 2 落地)
- **Decision**:CodexBackend 默认走 app-server transport(per-run spawn stdio JSON-RPC v2,逐 token 流),exec --json 降为 preflight 失败的自动回退 + `transport:"exec"` 逃生舱;原生 `thread/fork` 上位,forkCodexSession rollout copy 退役为 exec 路径兜底。
- **Why(2026-08-04 推迟理由逐条复查,依据 2026-08-18 调研 + 本机 0.147.0 实测)**:①「experimental 且 v1/v2 并存换代期」已实质消失——0.147 把 v1 会话 API(newConversation 族)整体移除,v2 唯一且默认,schema 可 `generate-json-schema` 锁版本;子命令标签仍是 experimental,但它已是 VS Code 扩展(千万级安装)与官方 Python SDK 的生产依赖,0.147 起 TUI/exec 自身也是 app-server 客户端(官方全生态收敛)。②sandbox/approval 重映射风险以「逐档纯函数单测对齐 buildCodexArgs + 真机三档 e2e(readonly 拒写 / workspace-write 圈内可写 / full 圈外可写)」收掉,approvalPolicy 恒 "never" 保持非交互 parity。③设备版本参差对 trellis 已不构成阻塞(prod 本机 0.147);老版本机器 preflight 失败静默回退 exec,行为与 0.5.x 逐字节一致。
- **关键佐证**:exec --json 无流式是输出层**有意丢弃** delta(event_processor_with_jsonl_output.rs 兜底分支,无 flag 可开,官方给程序化流式消费者指的路就是 app-server——Python SDK 即此路线);app-server `thread/resume` 可直接续 exec 录的 rollout(同一存储、id 互通,本机实测),迁移零孤儿。
- **保留的风险对冲**:协议无兼容承诺(wire_api="chat" 有废弃前科)→ 锁 schema 核对 + exec fallback 常备;审批回调(dynamicPermissionCallback)与 turn/steer 刻意不进本期,是独立 phase。
- **References**:2026-08-04 推迟条目(其重启条件「v2 收敛」已满足);trellis 仓 2026-08-18 会话的调研报告(源码级证据链)。

## 2026-08-04 — 推迟 codex app-server(Phase 2)接入
- **Decision**:codex 逐 token 流 + 双向审批的 app-server JSON-RPC 路线,评估完成但暂不实施;CodexBackend 维持 exec --json 路径(capabilities 保持 `streaming: "block"`、`dynamicPermissionCallback: false`)。
- **Why**:①协议官方标 experimental 且 v1/v2 两套 schema 并存(换代期,漂移风险高,codex 对内部面无兼容承诺——wire_api="chat" 有废弃前科);②sandbox/approval 语义需从 CLI flag 整体重映射成 `sandboxPolicy`/`approvalPolicy` RPC 参数,映射错一档是静默安全破洞(harbor Codex worktree 写权限建在现有 flag 语义上),验收需逐档 exec vs app-server 行为对照;③多设备 codex 版本参差(Mac mini 0.142.2 / 本机 0.146.0)正跨在协议换代期。
- **已确认的收益(实测,2026-08-04 codex 0.146.0)**:app-server stdio JSON-RPC 握手可用;v2 协议有完整 delta 通知族(AgentMessageDelta / ReasoningTextDelta / CommandExecOutputDelta…)、五种审批请求(ApplyPatch / CommandExecution / ExecCommand / FileChange / Permissions)、原生 `thread/fork`。schema 可由 `codex app-server generate-json-schema --out <dir>` 导出。
- **重启条件**:协议脱 experimental 或 v2 收敛、设备版本统一后再评估;第一版建议 per-run spawn(免 daemon 管理)+ exec fallback + 逐档安全对照测试。届时 forkCodexSession 的 rollout copy 可退役为旧版本 fallback(app-server 走原生 thread/fork)。
