# SM-Toolkit Domain Glossary

## Harbor

- **Workspace**：Harbor 的一级逻辑作用域，隔离 Agents、Skills、Conversations、Automations、prompt settings 与 Usage。它不是 Repository、目录、Device 或团队租户，也不保存统一仓库地址；Repository 的 `workspace_id` 只控制目录可见性。
- **Repository**：Agent 必选的逻辑代码资源，不直接等于本地路径。同一 Repository 可以被多个 Agent 复用，并在多台 Device 上分别 checkout；用户从 Agent 创建/详情配置，不从 Workspace 或任务单独配置。
- **Repository mount**：Repository 在某台 Device 上的绝对主 checkout 路径，`(repository, device)` 唯一。Agent 绑定 Repository + Device 后确定 mount；`RunSpec.repositoryRoot` 始终保持这个身份锚点，即使 Run 已进入 linked worktree。被 Agent、活跃任务、Run 或 worktree 引用时不能删除。
- **Execution root**：某一 Run 的实际 cwd 快照。首轮 worktree Run 下发时可先等于 Repository mount，`worktree_ready` 后改为 per-Issue worktree；后续 implementation/reviewer 继续用该 worktree，但不改变 `repositoryRoot` 的 mount 语义。
- **Device**：运行一个 `harbord` 的真实机器。设备在线状态来自 WebSocket 连接，能力来自 daemon 启动时探测，不是用户手填标签。
- **Harbor Agent**：固定归属一个 Workspace，并且在任一时刻恰好绑定一台 Device 与一个 Repository 的执行配置。Issue、Chat、AI draft 与 Automation 不另选仓库；指派 Agent 时继承其当前 execution binding。Device 可经显式迁移安全切换，不代表历史 Run 会随之改写。
- **Agent execution binding**：Agent 当前的 `Device + Repository + repository mount` 组合，决定未来 Run 的执行位置。迁移要求目标 Device 具备 Agent Runtime/model 能力与 Repository mount，且 Agent 没有 active Run 或未清理 worktree；历史 Run 继续保留原 Device/mount/execution root 快照，旧 Device 独占的 runtime Skills 在确认后解除。
- **Provider capability**：某台 Device 上实际可执行的 agent CLI（当前仅 `claude` / `codex`）及其版本。Agent 只能绑定设备已上报的 provider；provider 与模型 endpoint 是两类能力，不能互相代替。
- **Runtime**：实际执行 coding session 的 CLI，当前是 Claude Code (`claude`) 或 Codex CLI (`codex`)；UI 和代码不再把它称为模型 Provider。
- **Model route**：Device 从 sm-toolkit `endpoints.yaml` 解析并上报的 `provider:model` 路由。Harbor 只展示该 Runtime 真能消费的 route；当前 sm-toolkit route 由 Claude Code Runtime 消费 anthropic-compatible/native endpoint，Codex CLI 的模型名仍由其本地配置负责。
- **Daemon service**：操作系统用户级的 `harbord` 常驻服务。它只管理本机 daemon 进程，不是 Harbor 数据库里的领域实体，也不管理远端 server；生成的 PATH 必须包含启动用 `bunPath` 的目录，保证 Run 内仍能找到仓库工具。
- **Prompt wrapper**：server 在派发 Run 时临时包裹原始用户 prompt 的结构化上下文。原始 prompt 仍原样落库；wrapper 不替代 Agent instruction，也不改变 Conversation 历史。
- **Prompt source**：决定 wrapper 模板的来源类别：`issue`、`chat`、`automation`。Automation 优先按来源识别，即使它创建的是 issue。
- **Workspace Skill**：Workspace 内可复用的一份 `SKILL.md` 指令快照。`manual` 来源由 Harbor 编辑/上传、可跨设备；`runtime` 来源由某台 Device 的 daemon 从 `.claude/.codex/.agents` 目录探测并同步，只能绑定该 Device 且 Runtime 兼容的 Agent。
- **Agent Skill binding**：Agent 与 Workspace Skill 的有序多对多配置，可为空。Run 派发时才解析当前绑定并合入 system prompt；Skill 归档会解除所有绑定，避免已隐藏配置继续生效。
- **Harbor control plane**：由 `harbor-server` 的 REST、状态机与 `RunCoordinator` 组成的确定性主控，不是一名可配置 Agent。它负责排队、并发闸、阶段流转、取消与收尾；Agent 只执行具体 Run。
- **Issue**：可持续迭代并最终验收的交付单元。可以先不指派 Agent 留在 Inbox；标题、description、priority 和当前 Assignee 属于 Issue，执行日志与成本属于 Run。
- **AI Issue draft**：`kind=issue_draft` 的隐藏创建器状态。只读 Agent 先把自然语言请求分诊为可编辑的标题、范围与验收标准；只有人工确认发布后才原位转为 Issue，发布前不出现在 Chats、Issues 或 Automation target 列表。
- **Assignee**：Issue 当前的 implementation Agent，可空、可在没有 active Run 时更换。Reviewer 是独立 Run 的执行者，不覆盖 Assignee；更换 Assignee 会清空旧 Agent 的 resume session。
- **Issue stage**：`backlog(Inbox) → todo(Ready) → doing(Running) → review → done/canceled`。`doing/review` 由 implementation Run 自动推进，人工只做分诊、要求修改、验收或取消，避免拖拽制造假状态。
- **Run purpose**：一次执行的意图快照：`triage` 只读分诊 AI Issue draft，不建 worktree、不推进阶段；`implementation` 推进 Issue 阶段并续接 Assignee session；`review` / `verification` 只在 Review 内运行，不改变 Assignee、不自动 Done。
- **Additional writable dirs**：`@sm/agent` Run 级、位于 workspace 之外的显式可写根；Codex 初次 exec 映射为重复 `--add-dir`，resume 映射为 `sandbox_workspace_write.writable_roots`。它不是 `full access`，readonly/default 必须忽略。
- **Worktree Git metadata grant**：harbord 只给 `Codex + implementation + worktree + auto-edit/full` Run 增加的 Git 元数据写授权。授权前必须同时证明：worktree leaf 不是 symlink且 realpath 等于“canonical expected parent + 当前 Issue basename”；Git registry 的原始绝对 leaf（只做 resolve/规范化）严格等于该 expected leaf且本身不是 symlink；symbolic HEAD 是 `refs/heads/harbor/<Issue ID>`；common gitdir 与 Repository 相同。triage/review/verification/readonly/非 worktree 不获得。
- **Concurrency**：每台 Device 可同时执行的 Run 上限（默认 2）；同一 Conversation 永远串行，防止两个 Run 从同一 session 分叉。并发属于调度器与 Device，不是 Agent 的静态属性。
- **Delivery**：Issue 可选的一份代码交付记录，当前与 Issue 是 `0..1` 关系，承载主 MR/PR、CI、人工验收、合并与部署事实；非代码 Issue 可以没有 Delivery。Delivery 不取代 Issue stage，Issue 在交付完成前持续停留在 Review。
- **Delivery status**：由 `reviewStatus + checkStatus + mergeStatus + deploymentStatus` 派生的只读阶段（如 `review_pending / checks_pending / merge_ready / deploying / succeeded`），不接受调用方直接写入，避免组合状态互相矛盾。
- **SCM Delivery provider**：Harbor server 内可替换的代码托管适配器。Provider 只负责 MR/PR、checks 与 merge 的外部事实；Harbor policy 负责“当前是否允许合并”。`manual` 只记录人工确认，`github` 从 server-only 凭证调用 GitHub REST。它与 Deployment Provider 正交。
- **Deployment target**：管理员通过 env / `~/.harbor.yaml` 配置的部署目的地。Delivery 可选绑定一个 target id；DB/REST 只保存和展示非敏感 id/name/provider，repository/release/SQLite/plist 路径、命令 argv、health URL、环境变量与凭证不进入 DB/前端。无 target 时保持 manual deployment fallback。
- **Deployment job**：merge 且 Harbor review/check gates 通过后，由 control plane 持久化到 SQLite 的一次部署尝试。首次 enqueue/Retry 各占一个递增 generation，并冻结完整非敏感 target manifest fingerprint 与 exact committed revision；独立 host worker 用单调 fencing epoch + nonce 领取，只有 active job + generation + revision + fence 同时匹配的 checkpoint/result/host mutation 才成立。
- **Deployment maintenance gate**：Local launchd cutover 前同时写入 SQLite singleton 与 host-global 稳定路径 0600 sentinel 的 durable 写闸。它冻结 job/generation/revision/fingerprint、原 rollback attempt/baseline 与当前 expected revision；任一副本存在、不可读或不一致，REST/WS/automation/daemon 写入路径都 fail-closed，只允许 exact revision-aware health。sentinel 不依赖可删除或漂移的 target state path。
- **Deployment needs recovery**：停机、rollback、DB restore、baseline health 或双 gate identity 任一无法证明时的非终态安全状态。普通 Retry 与 Issue Done 都被禁止；只有 host 管理员用原 rollback anchor 实际恢复并验证 baseline revision + launchd label/PID + health 后，才转为可重试的 failed。
- **Local launchd Deployment Provider**：独立 `harbor-deploy-worker` 执行的 host deployment provider。它从管理员 target 配置取得多 service manifest（至少 server + daemon）、路径/受控 steps/launchd/health 参数，完成 fixed remote fetch、exact revision release、build/test、逐 service 停机证明、SQLite 一致性 backup、launchd definition 原子切换与 revision-aware health；health 阶段只启 server，放闸后才启 daemon。失败恢复冻结 baseline definition/release/DB，任何不确定性都保持 Issue Review / needs recovery。
- **GitHub Delivery sync**：用户显式触发的外部事实刷新。Repository `remoteUrl` 是 owner/repo 身份真相；PR number 来自同仓校验后的 PR URL，或该 mapping 下的正整数 external id。classic protection、active rulesets、完整分页 latest check-runs、combined commit statuses 与 PR open/closed/merged 都来自 GitHub REST。同名 required context 聚合 check-run/status 全部来源（failed 优先于 pending，全部成功才 passed）；无 checks/缺 required 是 pending。check-run/status 必须有唯一 id；check-runs 的 total_count 跨页稳定且只能精确读满，combined statuses 的跨页顶层 state/SHA/total 一致且可由完整 statuses 推导。重复、漂移、overshoot、不完整，或非空 statuses 的 combined 顶层状态比本地 required 结果更差时都按 unavailable/fail-safe 拒绝，后者不会把 unrelated context 冒充 required failure。required workflow 或 protected branch classic 404 权限歧义也明确失败。
- **GitHub head evidence**：`latestHeadSha` 是最近一次成功 sync 观察到的 PR head，`approvedHeadSha` 是人工实际审查的 head。head 变化使旧 review/check evidence 失效；merge 只接受两者相等，并把同一 expected SHA 交给 GitHub 原子校验。
- **Delivery external-action revision**：Delivery 内部单调递增的 CAS 版本。每次新 implementation 无条件推进 revision，即使 review/check 已是 pending/pending；sync/merge 先按 Delivery 串行，Provider HTTP 返回后只有 revision 未变化才能连同 audit event 原子落库。旧 generation 的慢 sync 被丢弃且不自动重试。
- **Delivery policy**：Harbor control plane 内置的确定性安全闸：合并必须同时满足人工验收、CI 通过与 GitHub approval/head SHA 一致，部署必须发生在合并之后，只有无需部署或部署成功才可把 Issue 推进 Done 并收尾 worktree。
