# agent-tui

agent-server 的薄终端客户端；只消费 `client`、`protocol` 和 `paths` 子入口，不导入或启动引擎。

```sh
bun install
bun run typecheck
agent-server start
apps/agent-tui/bin/agent-tui --new --backend codex --cwd "$PWD"
apps/agent-tui/bin/agent-tui --new --backend claude --permission full --cwd "$PWD"
apps/agent-tui/bin/agent-tui --attach th_example
apps/agent-tui/bin/agent-tui --attach th_example --socket /path/agent-server.sock --token-path /path/token
apps/agent-tui/bin/agent-tui --attach th_example --ws ws://127.0.0.1:12345
```

默认 socket、token 使用 daemon 的 `resolveDaemonPaths`，遵循 `AGENT_SERVER_SOCKET_PATH`、XDG 与 HOME。显式 socket/WS 只覆盖端点；`--token-path` 可单独指定 token 文件，适用于 pane 与主控 HOME/XDG 不同的部署，不创建凭证或传递 token 内容。需要交互式 TTY；退出只断开客户端，会话仍由 daemon 托管。

fj 起位必须显式 model/permission，Codex 使用 gpt-6-astra + `--service-tier default`（Claude 不支持 tier）。同一交接重试复用 `--client-thread-id`；`--ready-file` 搭配 `--ready-nonce-file` 与 `--await-first-turn`，nonce 文件须为同用户私有常规文件，不能是 symlink。nonce 值不出现在 argv。ready 丢失时先恢复同一身份的 TUI 补回回执，fj 不会绕过握手另建裸 thread。

选型：沿用 `apps/cli/src/picker.ts` 的 ANSI 自绘惯例，使用 Bun 内置终端宽度计算和 TerminalInput 分帧后使用 Node readline 按键事件，新增运行时依赖为零。状态模型、纯文本渲染、按键控制分离，方便 MockEngine 集成测试和快照测试；无需引入 React/Ink 渲染运行时。根目录 typecheck 验证 Bun 类型兼容，测试覆盖 Unicode 宽度、终端控制字符过滤与网络重连。

Enter 发 `turn/start`；运行时同样入队，显示从 1 起的排队位置。`/steer 文本` 显式插话；中途 attach 尚未观测到当前 turn id 时提示使用排队。PageUp/PageDown 浏览历史或长卡片。Ctrl-U 清空输入；Ctrl-C 请求中断，1.5 秒内再次 Ctrl-C 退出。

| 操作 | 行为 |
| --- | --- |
| Shift+Tab | `default → acceptEdits → plan → default`；本端以 `bypassPermissions` / `full` 启动时循环末尾加入 bypass；readonly 不切换；在途连按丢弃并单独保留计数提示 |
| `/permissions` | ↑↓ 或数字选模式，Enter 确认，Esc 取消；`dontAsk` 在 bypass 资格已知或本端以 dontAsk 启动时出现；readonly 线程只展示并选中 readonly |
| Tab、`/effort low\|medium\|high\|max` | 统一调用 `thread/effort/set`；四档为 TUI thinking budget 预设：1024 / 8192 / 32768 / 65536 token，服务端确认后才更新标签 |
| `/model <name>` | `thread/engineControl set_model`，原生 success 加匹配模型的 metadata 通知才确认成功；响应后 2 秒未收到通知则提示未确认并保留命令；他端和重连通过 metadata 通知及快照同步 |
| `/compact [instructions]` | `thread/compact`，正常排队；收到持久化的 `contextCompaction` item 时显示 compact_boundary 分隔，重试复用去重键 |
| Ctrl-P、Ctrl-R | 分别折叠/展开 plan（默认展开）和 reasoning（默认折叠）；plan 保留正文和每一步状态 |
| `/takeover`、`/release` | 手动获取独占输入 lease / 释放；活跃时续期，空闲后到期 |
| `/context <窗口 token 数>` | 覆盖当前 TUI 的上下文窗口估算 |
| `/diff` | 工作区差异（原生引擎，`get_workspace_diff`） |
| `/usage` | 用量与限额表格（`get_usage`） |
| `/cost` | 本会话费用（`get_session_cost`） |
| `/mcp` | MCP 服务器状态（`mcp_status`） |
| `/rewind <原生消息 UUID>` | 回滚会话（`rewind_conversation`），y/N 确认 |
| `/btw <question>` | 侧问（`side_question`），不打断当前 turn |
| `/help` | 显示命令与快捷键帮助；内容与本表同源自 `completion.ts` 的命令面板 |
| `/new`、`/clear`（Ctrl+N） | 沿用当前 thread 的 cwd、backend、model 起新 thread 并切换；旧 thread 继续运行 |
| `/threads`（Ctrl+T） | 列出 daemon 全部会话，按最近活动降序，分叉会话显示 forkedFrom 父 thread 与 item 短 id；↑/↓ 选择、Enter attach、Esc 取消 |
| `/resume` | 打开同一会话选择器 |
| `/resume <完整 thread id>` | 恢复指定会话；systemError 时重启引擎，closed 时先询问 y/N；确认后 thread/resume 再 attach |
| `/fork [itemId]` | 无参数按 seq 选择 item（显示类型和摘要），↑↓ 选择、Enter 分叉并切换、Esc 取消；传 itemId 直接分叉。daemon 无 midThreadFork 能力时明确提示，并仅提供末尾分叉 |
| `/steer <文本>` | 向当前 turn 插话 |
| `/image <path>`、`/paste-image` | 发送本地图片 / 附加剪贴板图片 |

键位优先级：Ctrl-C 始终可用；会话操作期间按原保护规则丢弃输入（扫描期间允许审批/问题卡）；关闭会话确认、会话选择器、审批卡、权限选择器依次接管按键。Ctrl-N/Ctrl-T 可从普通审批卡切换会话，控制请求提交期间需等确认。补全列表中的普通 Tab/Enter 插入候选，Shift+Tab 保留权限切换；没有补全时 Tab 切 effort，Ctrl-R 切 reasoning，Ctrl-P 切 plan。Shift+Enter/Ctrl-J 始终用于主输入换行，Ctrl-U 清空文字与附件。输入完整无参数命令后，若补全仍开着，先 Enter 插入再 Enter 执行，或加空格后 Enter。

切换会话时按 thread id 保存本端已知启动权限，清空租约显示并停止旧会话续期，未知会话隐藏 bypass 资格；权限面板、补全和本端 effort 标签重置。草稿及待发附件仍保留。

TUI 协商开启 pendingRequests 通知，状态栏显示待处理请求数。他端处理后卡片立即显示处理者并撤掉审批按键；超时、撤回会提示原因。离线计数标为待确认，重连后按 attach 快照重建待处理卡片与计数。

模式以 `thread.permission`、`thread/permission/changed` 为准；他端通知只更新状态栏，不覆盖本端发送/排队等消息。readonly 是 CLI 启动工具限制，不能安全热切来回：当前或本端记录的启动模式为 readonly 时，快捷键和面板都保持该限制，不发 permission/set；更改需新建线程。

租约统一由按 threadId 隔离的 `InputLease` 管理：发送、插话、审批（含 ExitPlanMode）和提权操作在未持有时获取 30 秒短租约，操作进行中每半 TTL 续期，完成或失败后释放；并发操作共享引用计数，最后一项完成才释放。只有 full/bypassPermissions/dontAsk 权限切换属于提权；default/acceptEdits/plan 及 effort/model/compact 控制不主动取租约。手动 `/takeover` 保留租约，只有最近一个 TTL 窗口内有输入或审批活动时才续期；无活动就停止续期，已有租约自然到期，`/release` 可显式放手（在途操作完成后释放）。切换会话立即停止旧 thread 的续期并让原租约到期，新 thread 不复用旧句柄；切回也重新取租约。断线/退出停止所有续期。状态栏保留持有、未持有、他端持有三态；他端信息仅来自最近拒绝，协议没有实时租约广播/查询或强制抢占。观测和 Ctrl-C 中断不取租约，另一客户端持锁也可急停。释放失败不覆盖操作结果，另显「租约释放未确认」；残留租约等待当前 TTL 到期，下次成功取放租约清除警告。`-32012` 提示持有方释放或到期后再 `/takeover`，`-32014` 表示审批已处理并撤卡，`-32005` 保留原生授权原因，不误报为他端持锁。

ExitPlanMode 显示专用审批卡，y 使用 turn 授权、s 使用 session 授权；收到本客户端获胜的 `serverRequest/resolved` 后切换 default。拒绝、审批已处理和他端先答不切模式。

`thread/start.permission` 已存在，`--new --permission <mode>` 会原样传入并记录（默认 default，旧别名 full/auto-edit 同样接受）。当前打底 **没有只读的启动权限上限字段**，恢复 options 也会随当前权限更新。因此仅信本端 thread/start 的启动记录判断 bypass 资格；普通 `--attach` 无法证明资格，保守隐藏 bypass/dontAsk 并显示「bypass 上限未知，已隐藏」，不会拿当前模式冒充启动上限。重连保留本端启动记录。CLI/组织策略仍可拒绝提权。

model 已由打底持久化，状态栏只显示 thread.model，并消费 `thread/metadata/updated`；失败不伪造新模型。effort 的热切预算仍没有 thread 状态字段或跨端通知，因此标注「本端设置」，收到快照或断线后清空；不声称已实现 effort 权威跨端同步。预算预设不等同于 CLI 原生 `--effort` 的内部映射。live 控制目前仅 Claude backend 支持，其他 backend 的协议拒绝会保留输入和显示值。

上下文条使用 `usage.contextTokens`，窗口默认按模型名查内置估算表：`[1m]` 后缀 1M、`gpt-5` / `gpt-5-*` 400k、Claude 名称及未知模型 200k；`~` 明示估算，不保证等于当前账号/引擎配置。`/context` 可填写已知窗口，`/model` 成功时仅自动更新估算窗口；未知 usage 显示 `?`，占比超过 80% 变黄，超过 100% 保留真实百分比并将条形限制在满格。窄终端状态栏会换行。

选择器显示短 id、标题（无标题时取首条用户提示）、状态、cwd、最近活动时间。协议没有 updatedAt 字段，因此时间取 items 的最大开始/完成时间与 thread 的创建/关闭时间。状态栏显示短 id、cwd、model；未返回 model 时显示 `unknown`。权限段使用 foundation 公开的 thread.permission。停止的引擎显示「可恢复 · /resume」。选择器在选中项超出窗口时才滚动，短列表保留所有条目。

切换成功后清理旧会话画面并 detach 旧订阅，不 close/interrupt 旧 thread。恢复其它会话失败时清理该目标的订阅，保留当前会话订阅。Ctrl+N/Ctrl+T 在审批卡上也可使用；卡片保留在 daemon，切回时恢复。快捷键保留原有草稿；命令在请求前清空输入，失败回填。会话操作进行中丢弃普通输入按键，丢弃提示独立于错误/完成消息显示；完成后重新输入。`/threads`（含无参数 `/resume`）加载期间，当前审批卡的 y/s/n/a/Esc、问题卡输入/Enter 与卡片翻页仍可操作；Ctrl-C 中断/退出始终可用。选择器确认后显示「Esc 不取消在途操作」，此时 Esc 不关闭选择器或假装取消；空列表 Enter 提示按 Esc 退出。

已关闭会话必须先确认「恢复已关闭会话？[y/N]」才启动引擎，直接指定 id 和选择器均遵循此规则。只有 y 确认；Enter、n、Esc 默认取消，不改变归档状态。

连接中断会显示一行提示，client 自动重连并用 `sinceSeq` attach 回当前 thread，补齐离线完成的 item。daemon 重启后会区分历史恢复与引擎停止，提示用 `/resume` 选择会话；选择或输入 `/resume <id>` 后恢复引擎并刷新快照（closed 会话需先确认），可继续发送 prompt。仍在运行的会话直接 attach，不重复 spawn。

当前协议限制：`/threads` 仍需分页读取历史以精确计算最大活动时间。items 按创建 seq 排序，较早 item 可能较晚完成，简单取最后一条会算错；拉取期间使用上述按键保护，不再静默拼接输入。`/new` 只能继承协议公开的 cwd/backend/model，permission 已由 foundation 公开，但本次保留 sessions 分支的 /new 行为，仍采用 daemon 默认权限；effort/sandbox/systemPrompt/tools 仅存于 daemon 内部 options，客户端不能完整继承。`/fork` 由服务端继承完整 options，但也继承上下文，不能替代清空会话的 `/new`。

输入支持多行：Shift+Enter（终端须发送 CSI-u 或 modifyOtherKeys 编码）或 Ctrl+J 换行，Enter 发送整段。终端的 bracketed paste 模式会将 CR/CRLF 统一为 LF，保留换行、缩进和首尾空白；粘贴不会自动发送。未支持 Shift+Enter 的终端请用 Ctrl+J。输入区显示最后六行。

输入 `@` 后显示当前会话 cwd 下的文件候选，优先用 `git ls-files --cached --others --exclude-standard`（仓库内遵守 Git 忽略规则并保留已跟踪文件）；不可用时尝试可选的 `rg --files`，再降级为纯 fs 递归，读取逐层 `.gitignore` 的 glob、目录及否定规则。三条路径均排除 `.git`/`node_modules`，不列出失效文件。无需安装 rg，git 和 rg 均不存在时也可补全。支持不连续字符模糊匹配，最多 50 条。输入 `/` 显示内建命令和 `~/.claude/skills/*/SKILL.md`、`<cwd>/.claude/skills/*/SKILL.md` 的名称及一行描述；支持 symlink，项目同名 skill 优先，内建命令保留优先级。列表缓存五秒。

候选打开时，↑/↓ 切换，Tab 或 Enter 插入所选内容及尾随空格，Esc 关闭；再次 Enter 才发送。文件插入相对路径（含空格时自动加引号），普通文件引用保持 `@path` 文本；skill 插入 `/name` 文本，由后端解释。候选关闭时 Tab 切换 effort；reasoning 统一用 Ctrl-R。

模糊排序先放完整连续命中的候选，连续命中位置越早越优先；其次是不连续子序列，按跳过字符数排序；同分按名称排序。保留连续优先的承诺，是因为完整文件名片段比偶然散落的字符更符合查找意图。

图片用 `看看 @./shot.png`、`@/absolute/shot.jpg` 或 `@"folder/shot name.webp"`，支持 png/jpg/jpeg/gif/webp（大小写均可），发送时转为协议的图片附件，消息中显示 `[image] 路径` 占位。`/image <path>` 直接发送图片，路径相对会话 cwd；找不到或无法读取时保留输入并显示错误。macOS 的 `/paste-image` 调用本机 `pngpaste`，把剪贴板图片存入系统临时目录并附加到草稿，可继续输入说明后按 Enter 发送；未安装时提示 `brew install pngpaste`。Ctrl-U 清空文字和待发附件。

图片走已有的本地路径协议；使用 WS 连接时，daemon 必须也能读取同一路径。成功粘贴的临时文件会保留，供排队消息和重试读取，避免退出 TUI 后排队图片失效；不自动上传或删除。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

审批卡下 bracketed paste 一律写入主输入框，即使内容恰为 y/s/n/a 也不触发决策；这些快捷键只接受按键。问题卡自由回答支持多行粘贴，与主输入共用 CR/CRLF → LF 归一。粘贴只写入回答草稿，不会触发数字选项或自动提交；按 Enter 后才发送回答，内部换行与缩进保留。

Herdr：存在 `HERDR_PANE_ID` 时通过 `HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock` 注册 backend 与 AS thread id。接口按本机 `herdr api schema --json` protocol 19 校验：`pane.report_agent` + `pane.report_agent_session`，source=`agent-tui`。状态：未决卡片/断线/systemError 为 blocked，running/spawning 为 working，其余 idle。OSC 标题使用本机 agent-detection 的 Braille working、Claude `✳` idle、Codex `Action Required` blocked；Claude blocked 同时由卡片 `Enter to confirm · Esc to cancel` 与 socket 报告支持。Herdr 不可用仅提示，10 秒后重试，不影响 AS 会话。

```sh
bun run typecheck
cd apps/agent-tui && bun test
```

测试只用临时 Unix/WS 服务与 MockEngine，不启动真实 Claude/Codex。

`sessions.test.ts` 覆盖排序、窗口滚动、延迟 start/list/attach 按键隔离、并发提示、Esc 竞态、恢复入口、空列表与协议能力边界；`sessions-pty.test.ts` 覆盖全部会话命令、快速连续 /new、旧会话存活、断线 sinceSeq 和重启后的下一次回答。`recovery-pty.test.ts` 在干净子进程环境中 SIGKILL 独立 daemon，再恢复同一 thread、验证历史无重复及新 turn 回答，也验证关闭后的会话可恢复。

P2-a–f 回归补充：消息去重、错误与丢弃提示共存、跨尺寸 render 不改模型、失败恢复订阅清理、closed 的默认取消/显式确认、延迟扫描期间审批及问题回答；Unix 集成验证扫描尚未完成时审批已到引擎，PTY 验证默认取消后 thread 仍为 closed。

输入 PTY E2E 自己创建 Bun PTY，父进程无需交互式终端。每一步按引擎收包或最新屏幕状态等待（10 秒上限），失败会打印步骤、子进程退出码和末尾终端输出；每例总预算 60 秒，覆盖启动、多个 RPC/渲染步骤及清理。图片例在模拟 pngpaste 中注入 5.2 秒延迟，回归默认 5 秒总超时导致的失败；同步仍等待实际附件状态。模拟程序使用绝对系统命令，TUI 使用测试进程同一 Bun，避免父进程 PATH 中的包装脚本改变测试行为。

四项输入 PTY 用例均显式构造只有 Bun 和模拟 pngpaste 的 PATH，并断言其中没有 git/rg。单测分别验证真实 Git 仓库枚举、可选 rg 命令分支（离线 fixture，不要求本机安装 rg）和无外部程序的 fs 分支。

## 观测面板

系统日志订阅 `thread/engineEvent`，默认只占一行计数。`Ctrl-L` 或 `/log` 展开/折叠，按本地收到时间（UTC）显示 hook 摘要、`local_command` 斜杠命令回显、`api_retry`、`rate_limit`、`model_refusal_fallback`、memory、away_summary。未知 subtype 显示单行 JSON，终端宽度不足时软换行；错误/重试/限流用红色和 `[!]` 标记，限流/重试归类优先于 hook。环形缓冲只保留最近 2000 条，表头显示丢弃计数；摘要最多 2048 字符、subtype 最多 256 字符，超长显示「截断」，不保留无界原始 payload。每帧仅排列可见日志窗口。引擎文字在绘制前过滤终端控制符并拆分换行，不突破固定帧高。

子 agent 按 `parentItemId`（引擎的 `parent_tool_use_id`）嵌套到父工具下面，显示状态、phase 和持续更新的正文；父工具尚未出现时按 seq 保留带 parent 标识的独立项。`/agents` 折叠/展开全部，`/agents <item-id 或 parent-id>` 切换指定项，不存在时提示「没有匹配的子 agent」；Ctrl-R 同时控制子 agent thinking 的显示。键位冲突按上面的优先级处理：普通 Tab 仍用于补全或 effort，Shift-Tab 用于权限，观测分支原来的 Tab 推理映射统一为 Ctrl-R。

`/tasks` 切换底栏。根据 `TaskCreate`、`TaskUpdate`、`TaskList` 工具输入及结构化输出按 item 顺序重建 id、标题、状态；调用开始即乐观刷新，失败/拒绝后撤销，删除状态移除任务，重复快照不重复创建。没有明确 id 的 TaskCreate 使用 `local:<item-id>` 并标 `?`；内部以 Symbol 键与引擎真实字符串 id 隔离，TaskUpdate 不能误改推断项。TaskList 无结构化任务数据时保留当前列表；该面板是已观测任务的重建，不保证覆盖引擎侧未出现在历史中的任务。

展开面板自动获得滚动焦点，F6 在历史、日志、任务之间切换；PgUp/PgDn 滚动当前焦点，日志按事件滚动，任务按行滚动。离开日志尾部后锚定所看事件，新事件不挤走视口；锚定的条目被环形缓冲淘汰时显示「已滚出保留窗口」，不悄悄切换成别的内容，按 PgUp/PgDn 重新定位。回到尾部恢复跟随新事件。面板命令只在本地执行，断线也能切换，不发送给模型。

审批在获取租约后重新核对卡片状态和响应 handle；已经 resolved/expired 的卡片不会被复活。错误回执按卡片保留的 RPC id 关联，不依赖客户端尚未删除的 pending handle。审批获取租约和等待确认期间可继续输入普通消息；等待确认上限 5 秒（客户端超时更短时跟随该值），失败或超时恢复审批按键、释放临时租约，保留答案供手动重试，不自动重发。迟到的确认仍可正常撤卡。

AS/1 的 engineEvent 不在 item 日志中，首次 attach 就标「仅显示接入后事件」，断线后永久标「重连后可能缺失」；已有日志在缓冲上限内保留，重连快照恢复子 agent 和任务，不伪造离线日志。

新增验证：`observations.test.ts` 覆盖事件归类、任务重建、嵌套、重连标识、换行/ANSI 反例和有界窗口；`lease.test.ts` 覆盖短 TTL、并发引用计数、续期、释放与断线；`integration.test.ts` 覆盖真实服务器急停/租约/撤卡、观测 PTY 以及 5000 条事件后按键回显 <50ms 的真实 PTY 基准。测试只启动 MockEngine。

已知限制：极窄终端（columns ≤ 2、有效宽度 1）会丢弃占两列的汉字/emoji 等宽字形，例如 `wrap("宽宽宽", 1)` 返回空行。该存量行为本轮未改，固定帧高规则仍成立；正常宽度终端不受此限制影响。
