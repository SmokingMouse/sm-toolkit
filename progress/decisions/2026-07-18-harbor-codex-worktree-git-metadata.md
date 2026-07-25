# Harbor Codex Worktree Git Metadata Grant

## Context

Harbor 的 per-Issue worktree 把代码文件放在独立 checkout，但 linked worktree 的 `.git` 只是指针；index 位于主 Repository 的 `.git/worktrees/<name>`，objects、refs 与 reflogs 位于 common gitdir。Codex `workspace-write` 默认只写 worktree 文件，因此 Agent 能改代码，却在 `git add/commit` 创建 Git lock 或对象时收到 EPERM。

把 implementation 统一切到 `danger-full-access` 会同时放开整个文件系统，破坏 Harbor 现有 permission/isolation 边界。另一方面，daemon 收到的 `repositoryRoot/worktreePath` 跨 WebSocket 传输，不能在未核验 Repository 身份时直接变成 Codex writable root。

本机 Codex CLI 0.144.2 还确认了一个不对称约束：初次 `codex exec` 接受重复 `--add-dir` 与 `--sandbox`，`codex exec resume` 的 parser 拒绝这两个 flag，但接受 `-c` config override。

## Decision

- `@sm/agent RunOptions` 增加 `additionalWritableDirs`。Codex 初次 exec 仅对 auto-edit/full Run 生成重复 `--add-dir`；readonly/default 丢弃该字段。
- Codex resume 不使用 full access 兜底：readonly 显式覆盖 `sandbox_mode="read-only"`；auto-edit 覆盖 `sandbox_mode="workspace-write"`，并把额外目录写入 `sandbox_workspace_write.writable_roots`；default 保持 workspace-write 兼容模式但不接收额外 roots；只有用户本来选择 `full` 时才保留既有 full 语义。
- `RunSpec` 显式携带 `purpose`、`repositoryRoot` 与 `executionRoot`。scheduler 必须从 Run 绑定的 Repository mount 生成 `repositoryRoot`；worktree ready 后的实际 cwd 只进入 `executionRoot/worktreePath`，不能反向冒充 Repository mount。harbord 只有在 `backend=codex + purpose=implementation + isolation=worktree + permission in (auto-edit, full)` 时计算 Git metadata grant；triage、review、verification、readonly、Claude 与非 worktree Run 返回空授权。
- worktree 路径必须等于 `worktreePathFor(repositoryRoot, conversationId)` 的规范化结果，Conversation ID 只能包含字母、数字、`_`、`-`。expected leaf 不得是 symlink；其 actual realpath 必须等于“canonical expected parent + expected basename”。Git registry 从 stdout 取得的原始绝对 leaf 只允许 `resolve`/规范化，不得跟随 leaf symlink，且必须严格等于上述 canonical expected leaf；registry leaf 自身是 symlink 也拒绝。当前 worktree 的 symbolic HEAD 还必须严格等于 `refs/heads/harbor/<conversationId>`，错误 Issue branch 或 detached HEAD 均失败。授权前还要用 Git 校验 Repository/worktree 都是 checkout root、两者 common gitdir 完全相同、actual gitdir 是 common dir 的后代。Git 机器路径只读取 stdout，成功命令的 stderr warning 也只用于诊断。任一步失败即让 Run failed，不回退主 checkout。
- 授权根选择整个真实 common gitdir。`git add/commit` 会同时写 per-worktree index、共享 objects、当前 branch ref 与 reflog；只授权其中某几个当前存在的子目录会遗漏 packed refs、lock/临时文件或未来 Git 实现细节，无法稳定保证 commit。
- launchd/systemd service definition 的 PATH 把 `dirname(bunPath)` 置顶，并对继承 PATH 按规范化路径稳定去重；service 文件仍不携带 token。

## Rationale

额外可写根是 Codex sandbox 已有的精确机制，能保留 workspace-write，而不是把“需要写 Git metadata”误翻译为“允许写整台机器”。Run purpose、permission 和 worktree 三道闸共同表达业务意图；独立的 mount/execution root、canonical physical leaf、registry raw leaf 与 symbolic HEAD 四组身份事实则避免单靠 realpath/common-dir 把其他 Repository 或同仓库其他 Issue 加进 writable roots。

PATH 修复放在 service definition 纯生成逻辑中，使 launchd/systemd 行为一致、可测试，也不需要 Agent 修改或重载当前机器的真实 service。

## Alternatives

- **所有 auto-edit Run 直接 full access**：能绕开 Gitdir 限制，但权限扩大到整个文件系统，拒绝。
- **只授权 `.git/worktrees/<name>`**：`git add` 的 index 可写，但 commit 仍需共享 objects/refs/reflogs，不完整。
- **枚举 objects/当前 ref/reflog 等子目录**：边界更窄，但依赖 Git 内部写路径与 ref 存储形态，packed refs、hooks 或版本变化会重新造成半成功；本轮不采用。
- **由 daemon 在 Agent 结束后代为 commit**：安全面可更窄，但改变“Agent 自己形成可审阅 commit”的产品语义，也需要另建 commit message、文件选择和审计协议。
- **信任 server 下发 worktreePath**：少一次本机解析，但无法防止跨 Repository 或复用另一个 Issue worktree，拒绝。

## Consequences

- common gitdir 包含同一 Repository 的所有 refs、objects、config、hooks 和其他 worktree 元数据；获授权的 implementation Agent 理论上可修改当前 Issue 之外的 branch/ref 或其他 worktree 状态。这是本方案最主要的隔离风险。当前用严格的 Run 闸、单 Repository 身份校验和用户显式 auto-edit/full 配置约束暴露面；未来若需要处理不可信 Agent，应优先设计 host-side、窄命令 Git broker，而不是继续扩大 writable roots。
- 文件系统授权不代表允许 push/merge/deploy；本变更不增加网络权限，也不调用 SCM/CD control plane。Agent 仍须服从 Run 指令与 Harbor Delivery policy。
- 旧 Codex thread 若首次创建时没有 Git metadata roots，resume 由本轮 config override 补齐；readonly resume 同时不再受用户级 writable sandbox 默认值漂移影响。
- Codex CLI 若改变 resume config key 或 `--add-dir` 行为，参数构造测试与真实 worktree commit probe 必须作为升级验收项。
- mount 身份、Issue leaf 或 Git 路径解析失败都会显式终止 Run；不会跨 Repository/Issue 猜测或静默降级。
- 人工把 Issue worktree 切到其他 branch 或 detached HEAD 后，续跑会 fail loudly；恢复到 `harbor/<conversationId>` 才能继续。
