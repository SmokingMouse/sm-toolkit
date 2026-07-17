# SM-Toolkit Domain Glossary

## Harbor

- **Workspace**：Harbor 的一级逻辑作用域，隔离 Agents、Skills、Conversations、Automations、prompt settings 与 Usage。它不是 Repository、目录、Device 或团队租户，也不保存统一仓库地址；Repository 的 `workspace_id` 只控制目录可见性。
- **Repository**：Agent 必选的逻辑代码资源，不直接等于本地路径。同一 Repository 可以被多个 Agent 复用，并在多台 Device 上分别 checkout；用户从 Agent 创建/详情配置，不从 Workspace 或任务单独配置。
- **Repository mount**：Repository 在某台 Device 上的绝对 checkout 路径，`(repository, device)` 唯一。Agent 绑定 Repository + Device 后确定 mount；Run 冻结具体 mount 与 execution root。被 Agent、活跃任务、Run 或 worktree 引用时不能删除。
- **Device**：运行一个 `harbord` 的真实机器。设备在线状态来自 WebSocket 连接，能力来自 daemon 启动时探测，不是用户手填标签。
- **Harbor Agent**：固定归属一个 Workspace、一台 Device，并且恰好绑定一个 Repository 的执行配置。Issue、Chat、AI draft 与 Automation 不另选仓库；指派 Agent 时继承其 Repository，具体 cwd 由该 Repository 在 Agent Device 上的 mount 决定。
- **Provider capability**：某台 Device 上实际可执行的 agent CLI（当前仅 `claude` / `codex`）及其版本。Agent 只能绑定设备已上报的 provider；provider 与模型 endpoint 是两类能力，不能互相代替。
- **Runtime**：实际执行 coding session 的 CLI，当前是 Claude Code (`claude`) 或 Codex CLI (`codex`)；UI 和代码不再把它称为模型 Provider。
- **Model route**：Device 从 sm-toolkit `endpoints.yaml` 解析并上报的 `provider:model` 路由。Harbor 只展示该 Runtime 真能消费的 route；当前 sm-toolkit route 由 Claude Code Runtime 消费 anthropic-compatible/native endpoint，Codex CLI 的模型名仍由其本地配置负责。
- **Daemon service**：操作系统用户级的 `harbord` 常驻服务。它只管理本机 daemon 进程，不是 Harbor 数据库里的领域实体，也不管理远端 server。
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
- **Concurrency**：每台 Device 可同时执行的 Run 上限（默认 2）；同一 Conversation 永远串行，防止两个 Run 从同一 session 分叉。并发属于调度器与 Device，不是 Agent 的静态属性。
- **Delivery**：Issue 可选的一份代码交付记录，当前与 Issue 是 `0..1` 关系，承载主 MR/PR、CI、人工验收、合并与部署事实；非代码 Issue 可以没有 Delivery。Delivery 不取代 Issue stage，Issue 在交付完成前持续停留在 Review。
- **Delivery status**：由 `reviewStatus + checkStatus + mergeStatus + deploymentStatus` 派生的只读阶段（如 `review_pending / checks_pending / merge_ready / deploying / succeeded`），不接受调用方直接写入，避免组合状态互相矛盾。
- **Delivery provider**：Harbor server 内可替换的 SCM/CD 执行适配器。Provider 负责“怎么向外部系统执行/确认”，Harbor 的 Delivery policy 负责“当前是否允许执行”；首个 `manual` provider 只记录人工确认的外部事实，不伪装已调用 Codebase/GitHub。
- **Delivery policy**：Harbor control plane 内置的确定性安全闸：合并必须同时满足人工验收与 CI 通过，部署必须发生在合并之后，只有无需部署或部署成功才可把 Issue 推进 Done 并收尾 worktree。
