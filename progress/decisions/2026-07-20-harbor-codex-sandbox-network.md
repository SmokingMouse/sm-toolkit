# Harbor Codex Sandbox Network Access

## Context

Harbor 把 Codex `auto-edit` 映射为 `workspace-write`，从而在保留 worktree 文件系统边界时允许实现代码。Codex CLI 的该 sandbox 默认禁用直接网络，真实 Run 因此无法访问 GitHub、包仓库或外部 API；DNS resolve/connect failure 是策略结果，不是 Repository 或 Device 本机断网。

用户明确要求 Codex implementation Run 能访问网络。把所有 Agent 切到 `full` 会同时放开主机文件系统；全局无条件打开网络又会静默扩大旧 Agent 权限。Codex 当前也没有一个可验证的内置组合能同时保持 `read-only` 文件系统并开放网络。

## Decision

- Agent 增加 `sandboxNetworkAccess` 显式布尔 capability，SQLite v28 列为 `sandbox_network_access`；旧 Agent、REST/Store/CLI 缺省值均为 false。
- 当前只允许 Codex Agent 配置该 capability。scheduler 在 dispatch 时冻结到 `RunSpec`，旧 server/daemon 缺字段时按 false 处理。
- `@sm/agent` 只在 Codex `workspace-write`（`auto-edit/default`）初次和 resume Run 中显式传 `sandbox_workspace_write.network_access=true|false`。`read-only` 忽略该请求，绝不切成 workspace-write；`full` 已绕过 sandbox，也不生成伪约束。
- Web Agent 创建/编辑页和 CLI `--network-access` 显式展示授权；REST 对非布尔值与 Claude `true` fail loudly。
- merged coordination 的 Harbor self-deploy 永远把该字段覆盖为 false，继续只写一次性 outbox，由 daemon 在 sandbox 外携短期 Run token 提交；Agent 不能借日常联网能力绕过 sidecar。

## Rationale

网络与文件写入是两种独立权限。显式 Agent capability 既满足需要拉取依赖、查询 GitHub/API 的实现任务，也保留旧 Agent 的 fail-closed 行为和 worktree 文件系统隔离。初次/续会话都显式传 true/false，可避免 Runtime 默认值或历史 thread 配置漂移。

## Alternatives

- **所有 Codex Agent 全局开网**：上线最快，但旧 Agent 权限无可见变化记录，拒绝。
- **切到 full access**：能联网，但同时放开整机文件系统，拒绝。
- **为 read-only Review 改用 workspace-write + 空 writable roots**：workspace 本身仍可写，破坏 Review 语义，拒绝。
- **只允许 github.com 的 host allowlist**：Codex 内置布尔开关不能表达目标域；需要独立 egress broker/OS policy，后续若处理不可信 Agent 再设计。

## Consequences

- direct network 是广域 egress，不是域名级 allowlist。启用后 Agent 可访问任意可达地址；若 Device 同时暴露 Git/SSH/npm 凭证，模型可能直接产生远端副作用或外传代码。管理员应只给确有需要的 Codex Agent 开启。
- Harbor 的 PR review/merge 和 self-deploy action 仍由 control plane/daemon 校验，但 direct network 本身无法阻止 Agent 使用 Device 上另一路凭证直接调用外部服务。
- read-only Review 继续离线。若未来确实需要“只读文件 + 网络”，必须增加可验证的独立 sandbox profile，而不是复用 workspace-write。
- Codex CLI 升级验收必须同时覆盖初次和 resume 参数、真实 HTTPS probe，以及 self-deploy outbox 仍强制断网。
