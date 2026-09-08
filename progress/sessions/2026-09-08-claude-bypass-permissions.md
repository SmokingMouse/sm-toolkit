# Claude 权限映射修复

契约 fj-as-claude-bypass-fix-a9c1：仅 default 注入 ask:*；bypass/full 选择原生 bypassPermissions 并保留 stdio，意外 can_use_tool 自动 allow、发布 permission_auto_response；dontAsk 自动 deny。readonly 改为启动时 plan 别名。协议及包 README 已同步。

验证：typecheck exit 0；agent-server 305 pass；agent-tui 172 pass；Codex 0.153.4 alignment 32 项通过。真实 Claude 2.1.258、显式 sonnet（init 为 claude-sonnet-5）、临时 daemon socket /tmp/as-bypass-smoke-TLQTKn/daemon.sock：两次 AS turn/start，bypass 内 ls 与 echo BYPASS_OK 均完成、pending=0，default echo DEFAULT_APPROVAL 产生 pending=1。daemon 已关闭。证据在契约 out/smoke-evidence.json。

限制：热切不删除启动 settings，default → acceptEdits/plan 可能继续触发 ask 规则；bypass/dontAsk 自动处理不受影响。CLI 的 --max-turns 2 已传，两次 AS turn/start；bypass result 原生 num_turns=3（保留原始证据，不将该字段等同 AS turn 数）。

Next：交主控独立验收；无 push，Trellis 迁移目标未变。
