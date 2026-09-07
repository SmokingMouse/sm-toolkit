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

系统日志订阅 `thread/engineEvent`，默认只占一行计数。`Ctrl-L` 或 `/log` 展开/折叠，按本地收到时间（UTC）显示 hook 摘要、`local_command` 斜杠命令回显、`api_retry`、`rate_limit`、`model_refusal_fallback`、memory、away_summary。未知 subtype 保留单行 JSON，终端宽度不足时软换行；错误/重试/限流用红色和 `[!]` 标记。引擎文字在绘制前过滤终端控制符。

子 agent 按 `parentItemId`（引擎的 `parent_tool_use_id`）嵌套到父工具下面，显示状态、phase 和持续更新的正文；父工具尚未出现时保留带 parent 标识的独立项。`/agents` 折叠/展开全部，`/agents <item-id 或 parent-id>` 切换指定项；Tab 同时控制子 agent thinking 的显示。

`/tasks` 切换底栏。根据 `TaskCreate`、`TaskUpdate`、`TaskList` 工具输入及结构化输出按 item 顺序重建 id、标题、状态；调用开始即乐观刷新，失败/拒绝后撤销，删除状态移除任务，重复快照不重复创建。没有明确 id 的 TaskCreate 用观测序号推断并标 `?`，TaskList 无结构化任务数据时保留当前列表；该面板是已观测任务的重建，不保证覆盖引擎侧未出现在历史中的任务。

展开面板自动获得滚动焦点，F6 在历史、日志、任务之间切换；PgUp/PgDn 滚动当前焦点，任务和日志各保留自己的位置。审批卡优先占用屏幕和按键。面板命令只在本地执行，断线也能切换，不发送给模型。

AS/1 的 engineEvent 不在 item 日志中，断线后系统日志永久标「重连后可能缺失」，已有日志保留；重连快照恢复子 agent 和任务，不伪造离线日志。重新启动 TUI 仅有新收到的系统日志。

观测不取 lease。发送、插话、中断和审批回复先获取短租约，操作后释放；被拒保留输入/待审批卡并显示「另一客户端持有控制权」及协议返回的持有方。`/takeover` 仅重试 `thread/lease/acquire`，成功后保持租约至 `/release`、到期或断线，不强制抢占；被拒时请持有方释放或到期后重试。手动租约不自动续期。

新增验证：`observations.test.ts` 覆盖事件归类、任务重建、嵌套、重连标识、视口与控制符过滤；`integration.test.ts` 的 `observe PTY` 使用真实 bin + MockEngine 覆盖日志折叠/展开/滚动、子 agent 正文更新/嵌套/折叠、任务刷新和重连，租约测试覆盖双客户端拒绝与恢复。
