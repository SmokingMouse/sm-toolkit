# agent-tui

agent-server 的薄终端客户端；只消费 `client`、`protocol` 和 `paths` 子入口，不导入或启动引擎。

```sh
bun install
bun run typecheck
agent-server start
apps/agent-tui/bin/agent-tui --new --backend codex --cwd "$PWD"
apps/agent-tui/bin/agent-tui --attach th_example
apps/agent-tui/bin/agent-tui --attach th_example --socket /path/agent-server.sock
apps/agent-tui/bin/agent-tui --attach th_example --ws ws://127.0.0.1:12345
```

默认 socket、token 使用 daemon 的 `resolveDaemonPaths`，遵循 `AGENT_SERVER_SOCKET_PATH`、XDG 与 HOME。显式 socket/WS 只覆盖端点；token 仍从本机 daemon 的 token 文件读取，不创建凭证。需要交互式 TTY；退出只断开客户端，会话仍由 daemon 托管。

选型：沿用 `apps/cli/src/picker.ts` 的 ANSI 自绘惯例，使用 Bun 内置终端宽度计算和 Node readline 按键事件，新增运行时依赖为零。状态模型、纯文本渲染、按键控制分离，方便 MockEngine 集成测试和快照测试；无需引入 React/Ink 渲染运行时。根目录 typecheck 验证 Bun 类型兼容，测试覆盖 Unicode 宽度、终端控制字符过滤与网络重连。

Enter 发 `turn/start`；运行时同样入队，显示从 1 起的排队位置。`/steer 文本` 显式插话；中途 attach 尚未观测到当前 turn id 时提示使用排队。Tab 切换 reasoning，PageUp/PageDown 浏览历史或长卡片。Ctrl-U 清空输入；Ctrl-C 请求中断，1.5 秒内再次 Ctrl-C 退出。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

Herdr：存在 `HERDR_PANE_ID` 时通过 `HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock` 注册 backend 与 AS thread id。接口按本机 `herdr api schema --json` protocol 19 校验：`pane.report_agent` + `pane.report_agent_session`，source=`agent-tui`。状态：未决卡片/断线/systemError 为 blocked，running/spawning 为 working，其余 idle。OSC 标题使用本机 agent-detection 的 Braille working、Claude `✳` idle、Codex `Action Required` blocked；Claude blocked 同时由卡片 `Enter to confirm · Esc to cancel` 与 socket 报告支持。Herdr 不可用仅提示，10 秒后重试，不影响 AS 会话。

```sh
bun run typecheck
cd apps/agent-tui && bun test
```

测试只用临时 Unix/WS 服务与 MockEngine，不启动真实 Claude/Codex。

## 观测面板

系统日志订阅 `thread/engineEvent`，默认只占一行计数。`Ctrl-L` 或 `/log` 展开/折叠，按本地收到时间（UTC）显示 hook 摘要、`local_command` 斜杠命令回显、`api_retry`、`rate_limit`、`model_refusal_fallback`、memory、away_summary。未知 subtype 显示单行 JSON，终端宽度不足时软换行；错误/重试/限流用红色和 `[!]` 标记，限流/重试归类优先于 hook。环形缓冲只保留最近 2000 条，表头显示丢弃计数；摘要最多 2048 字符、subtype 最多 256 字符，超长显示「截断」，不保留无界原始 payload。每帧仅排列可见日志窗口。引擎文字在绘制前过滤终端控制符并拆分换行，不突破固定帧高。

子 agent 按 `parentItemId`（引擎的 `parent_tool_use_id`）嵌套到父工具下面，显示状态、phase 和持续更新的正文；父工具尚未出现时按 seq 保留带 parent 标识的独立项。`/agents` 折叠/展开全部，`/agents <item-id 或 parent-id>` 切换指定项，不存在时提示「没有匹配的子 agent」；Tab 同时控制子 agent thinking 的显示。

`/tasks` 切换底栏。根据 `TaskCreate`、`TaskUpdate`、`TaskList` 工具输入及结构化输出按 item 顺序重建 id、标题、状态；调用开始即乐观刷新，失败/拒绝后撤销，删除状态移除任务，重复快照不重复创建。没有明确 id 的 TaskCreate 使用 `local:<item-id>` 并标 `?`；内部以 Symbol 键与引擎真实字符串 id 隔离，TaskUpdate 不能误改推断项。TaskList 无结构化任务数据时保留当前列表；该面板是已观测任务的重建，不保证覆盖引擎侧未出现在历史中的任务。

展开面板自动获得滚动焦点，F6 在历史、日志、任务之间切换；PgUp/PgDn 滚动当前焦点，日志按事件滚动，任务按行滚动，各保留自己的位置。审批卡优先占用屏幕和按键。面板命令只在本地执行，断线也能切换，不发送给模型。

AS/1 的 engineEvent 不在 item 日志中，首次 attach 就标「仅显示接入后事件」，断线后永久标「重连后可能缺失」；已有日志在缓冲上限内保留，重连快照恢复子 agent 和任务，不伪造离线日志。

观测和 Ctrl-C 中断不取 lease，另一客户端持锁也可急停。发送、插话和审批回复显式获取 30 秒租约；等待操作结果（审批等待 resolved/expired/错误）后释放。并发操作共享引用计数，最后一项完成才释放；长操作和 `/takeover` 每半个 TTL 用 acquire 续期。`/release` 停止手动持有，仍有操作时延后释放。断线/退出停止续期；续期失败显示错误，不自动重放操作。表头显示「持有/续期中」「未持有」或「他端持有」。协议无租约广播/查询接口，他端信息只代表最近一次拒绝，不声称实时探测。

`/takeover` 仅重试 `thread/lease/acquire`，不强制抢占；`-32012` 提示持有方释放或到期后重试。`-32014` 是 already_resolved，提示已由其他客户端处理并撤卡；`-32005` 是 unauthorized，保留原生原因，不误报为他端持锁。打底 `1b168c9` 的提升类 permission/engineControl 操作须在持有有效租约时发出；本 TUI 没有新增这些控制入口。中断始终不受租约门禁约束。

新增验证：`observations.test.ts` 覆盖事件归类、任务重建、嵌套、重连标识、换行/ANSI 反例和有界窗口；`lease.test.ts` 覆盖短 TTL、并发引用计数、续期、释放与断线；`integration.test.ts` 覆盖真实服务器急停/租约/撤卡、观测 PTY 以及 5000 条事件后按键回显 <50ms 的真实 PTY 基准。测试只启动 MockEngine。
