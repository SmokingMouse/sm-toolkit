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

| 命令 | 快捷键 | 行为 |
| --- | --- | --- |
| `/new`、`/clear` | Ctrl+N | 沿用当前 thread 的 cwd、backend、model 起新 thread 并切换；旧 thread 继续运行 |
| `/threads` | Ctrl+T | 列出 daemon 全部会话，按最近活动降序；↑/↓ 选择、Enter attach、Esc 取消 |
| `/resume` | — | 打开同一会话选择器 |
| `/resume <完整 thread id>` | — | attach 指定会话并恢复历史 |
| `/fork` | — | 从当前引擎会话末端 fork 并切换；服务端目前仅支持具有 engine session id 的 Claude thread |
| `/steer <文本>` | — | 向当前 turn 插话 |

选择器显示短 id、标题（无标题时取首条用户提示）、状态、cwd、最近活动时间。协议没有 updatedAt 字段，因此时间取 items 的最大开始/完成时间与 thread 的创建/关闭时间。状态栏显示短 id、cwd、model；未返回 model 时显示 `unknown`。thread 状态包含 `permission` 时显示权限，缺少该字段时省略，不猜测 daemon 的配置。

切换成功后清理旧会话画面并 detach 旧订阅，不 close/interrupt 旧 thread。Ctrl+N/Ctrl+T 在审批卡上也可使用；卡片保留在 daemon，切回时恢复。快捷键保留输入草稿，命令成功后清空命令输入，失败保留输入并显示错误。

连接中断会显示一行提示，client 自动重连并用 `sinceSeq` attach 回当前 thread，补齐离线完成的 item；成功后显示恢复提示。daemon 重启后恢复同一 thread 的历史和服务端状态，attach 本身不重启引擎。`/resume` 同样是 attach，不调用 `thread/resume` 启动引擎。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

Herdr：存在 `HERDR_PANE_ID` 时通过 `HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock` 注册 backend 与 AS thread id。接口按本机 `herdr api schema --json` protocol 19 校验：`pane.report_agent` + `pane.report_agent_session`，source=`agent-tui`。状态：未决卡片/断线/systemError 为 blocked，running/spawning 为 working，其余 idle。OSC 标题使用本机 agent-detection 的 Braille working、Claude `✳` idle、Codex `Action Required` blocked；Claude blocked 同时由卡片 `Enter to confirm · Esc to cancel` 与 socket 报告支持。Herdr 不可用仅提示，10 秒后重试，不影响 AS 会话。

```sh
bun run typecheck
cd apps/agent-tui && bun test
```

测试只用临时 Unix/WS 服务与 MockEngine，不启动真实 Claude/Codex。

`sessions.test.ts` 覆盖排序、快捷键、选择器按键、命令分流、失败保留与状态栏；`sessions-pty.test.ts` 使用临时 daemon、独立 MockEngine 和真 Bun PTY，覆盖命令表全部会话命令、快捷键、旧会话存活、选择/取消、断线补齐和 daemon 重启，并检查实际 attach 请求携带 `sinceSeq`。
