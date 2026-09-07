# agent-tui

agent-server 的薄终端客户端；只消费 `client`、`protocol` 和 `paths` 子入口，不导入或启动引擎。

```sh
bun install
bun run typecheck
agent-server start
apps/agent-tui/bin/agent-tui --new --backend codex --cwd "$PWD"
apps/agent-tui/bin/agent-tui --new --backend claude --permission full --cwd "$PWD"
apps/agent-tui/bin/agent-tui --attach th_example
apps/agent-tui/bin/agent-tui --attach th_example --socket /path/agent-server.sock
apps/agent-tui/bin/agent-tui --attach th_example --ws ws://127.0.0.1:12345
```

默认 socket、token 使用 daemon 的 `resolveDaemonPaths`，遵循 `AGENT_SERVER_SOCKET_PATH`、XDG 与 HOME。显式 socket/WS 只覆盖端点；token 仍从本机 daemon 的 token 文件读取，不创建凭证。需要交互式 TTY；退出只断开客户端，会话仍由 daemon 托管。

选型：沿用 `apps/cli/src/picker.ts` 的 ANSI 自绘惯例，使用 Bun 内置终端宽度计算和 Node readline 按键事件，新增运行时依赖为零。状态模型、纯文本渲染、按键控制分离，方便 MockEngine 集成测试和快照测试；无需引入 React/Ink 渲染运行时。根目录 typecheck 验证 Bun 类型兼容，测试覆盖 Unicode 宽度、终端控制字符过滤与网络重连。

Enter 发 `turn/start`；运行时同样入队，显示从 1 起的排队位置。`/steer 文本` 显式插话；中途 attach 尚未观测到当前 turn id 时提示使用排队。PageUp/PageDown 浏览历史或长卡片。Ctrl-U 清空输入；Ctrl-C 请求中断，1.5 秒内再次 Ctrl-C 退出。

| 操作 | 行为 |
| --- | --- |
| Shift+Tab | `default → acceptEdits → plan → default`；本端以 `bypassPermissions` / `full` 启动时循环末尾加入 bypass；readonly 不切换 |
| `/permissions` | ↑↓ 或数字选模式，Enter 确认，Esc 取消；`dontAsk` 仅在 bypass 资格已知时出现；readonly 线程只展示并选中 readonly |
| Tab、`/effort low\|medium\|high\|max` | 统一调用 `thread/effort/set`；四档为 TUI thinking budget 预设：1024 / 8192 / 32768 / 65536 token，服务端确认后才更新标签 |
| `/model <name>` | `thread/engineControl set_model`，检查原生 success 后读取 thread.model；他端和重连通过 metadata 通知及快照同步 |
| `/compact [instructions]` | `thread/compact`，正常排队；收到持久化的 `contextCompaction` item 时显示 compact_boundary 分隔，重试复用去重键 |
| Ctrl-P、Ctrl-R | 分别折叠/展开 plan（默认展开）和 reasoning（默认折叠）；plan 保留正文和每一步状态 |
| `/takeover`、`/release` | 显式获取 30 秒独占输入 lease / 释放；状态栏显示持有截止时间 |
| `/context <窗口 token 数>` | 覆盖当前 TUI 的上下文窗口估算 |

模式以 `thread.permission`、`thread/permission/changed` 为准；他端通知只更新状态栏，不覆盖本端发送/排队等消息。readonly 是 CLI 启动工具限制，不能安全热切来回：当前或本端记录的启动模式为 readonly 时，快捷键和面板都保持该限制，不发 permission/set；更改需新建线程。

仅目标为 full/bypassPermissions/dontAsk 的提权切换需 lease：TUI 临时获取 5 秒租约，在成功或失败后立即 release；default/acceptEdits/plan、effort/model/compact、ExitPlanMode 审批不主动拿租约。用户先显式 `/takeover` 获取的租约会保留至释放、断线或 30 秒到期，普通操作不偷偷续租。打底门禁的缺租约错误为 `-32005 unauthorized`，他人持有为 `-32012 lease_held`；`-32014 already_resolved` 表示审批已被处理，不引导接管。协议没有强制抢占或持有方剩余 TTL 查询：他人仍持有时 `/takeover` 会拒绝，需等其释放、断线或到期后重新执行；不是轮询命令，也不会擅自持续抢锁。

ExitPlanMode 显示专用审批卡，y 使用 turn 授权、s 使用 session 授权；收到本客户端获胜的 `serverRequest/resolved` 后切换 default。拒绝、审批已处理和他端先答不切模式。

`thread/start.permission` 已存在，`--new --permission <mode>` 会原样传入并记录（默认 default，旧别名 full/auto-edit 同样接受）。当前打底 **没有只读的启动权限上限字段**，恢复 options 也会随当前权限更新。因此仅信本端 thread/start 的启动记录判断 bypass 资格；普通 `--attach` 无法证明资格，保守隐藏 bypass/dontAsk 并显示「bypass 上限未知，已隐藏」，不会拿当前模式冒充启动上限。重连保留本端启动记录。CLI/组织策略仍可拒绝提权。

model 已由打底持久化，状态栏只显示 thread.model，并消费 `thread/metadata/updated`；失败不伪造新模型。effort 的热切预算仍没有 thread 状态字段或跨端通知，因此标注「本端设置」，收到快照或断线后清空；不声称已实现 effort 权威跨端同步。预算预设不等同于 CLI 原生 `--effort` 的内部映射。live 控制目前仅 Claude backend 支持，其他 backend 的协议拒绝会保留输入和显示值。

上下文条使用 `usage.contextTokens`，窗口默认按模型名查内置估算表：`[1m]` 后缀 1M、`gpt-5` / `gpt-5-*` 400k、Claude 名称及未知模型 200k；`~` 明示估算，不保证等于当前账号/引擎配置。`/context` 可填写已知窗口，`/model` 成功时仅自动更新估算窗口；未知 usage 显示 `?`，占比超过 80% 变黄，超过 100% 保留真实百分比并将条形限制在满格。窄终端状态栏会换行。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

Herdr：存在 `HERDR_PANE_ID` 时通过 `HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock` 注册 backend 与 AS thread id。接口按本机 `herdr api schema --json` protocol 19 校验：`pane.report_agent` + `pane.report_agent_session`，source=`agent-tui`。状态：未决卡片/断线/systemError 为 blocked，running/spawning 为 working，其余 idle。OSC 标题使用本机 agent-detection 的 Braille working、Claude `✳` idle、Codex `Action Required` blocked；Claude blocked 同时由卡片 `Enter to confirm · Esc to cancel` 与 socket 报告支持。Herdr 不可用仅提示，10 秒后重试，不影响 AS 会话。

```sh
bun run typecheck
cd apps/agent-tui && bun test
```

测试只用临时 Unix/WS 服务与 MockEngine，不启动真实 Claude/Codex。
