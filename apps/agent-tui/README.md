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
| `/resume <完整 thread id>` | — | 恢复指定会话；systemError 时重启引擎，closed 时先询问 y/N；确认后 thread/resume 再 attach |
| `/fork` | — | 从当前引擎会话末端 fork 并切换；服务端目前仅支持具有 engine session id 的 Claude thread |
| `/steer <文本>` | — | 向当前 turn 插话 |

选择器显示短 id、标题（无标题时取首条用户提示）、状态、cwd、最近活动时间。协议没有 updatedAt 字段，因此时间取 items 的最大开始/完成时间与 thread 的创建/关闭时间。状态栏显示短 id、cwd、model；未返回 model 时显示 `unknown`。当前 Thread 协议不提供 permission，不显示权限段。停止的引擎显示「可恢复 · /resume」。选择器在选中项超出窗口时才滚动，短列表保留所有条目。

切换成功后清理旧会话画面并 detach 旧订阅，不 close/interrupt 旧 thread。恢复其它会话失败时清理该目标的订阅，保留当前会话订阅。Ctrl+N/Ctrl+T 在审批卡上也可使用；卡片保留在 daemon，切回时恢复。快捷键保留原有草稿；命令在请求前清空输入，失败回填。会话操作进行中丢弃普通输入按键，丢弃提示独立于错误/完成消息显示；完成后重新输入。`/threads`（含无参数 `/resume`）加载期间，当前审批卡的 y/s/n/a/Esc、问题卡输入/Enter 与卡片翻页仍可操作；Ctrl-C 中断/退出始终可用。选择器确认后显示「Esc 不取消在途操作」，此时 Esc 不关闭选择器或假装取消；空列表 Enter 提示按 Esc 退出。

已关闭会话必须先确认「恢复已关闭会话？[y/N]」才启动引擎，直接指定 id 和选择器均遵循此规则。只有 y 确认；Enter、n、Esc 默认取消，不改变归档状态。

连接中断会显示一行提示，client 自动重连并用 `sinceSeq` attach 回当前 thread，补齐离线完成的 item。daemon 重启后会区分历史恢复与引擎停止，提示用 `/resume` 选择会话；选择或输入 `/resume <id>` 后恢复引擎并刷新快照（closed 会话需先确认），可继续发送 prompt。仍在运行的会话直接 attach，不重复 spawn。

当前协议限制：`/threads` 仍需分页读取历史以精确计算最大活动时间。items 按创建 seq 排序，较早 item 可能较晚完成，简单取最后一条会算错；拉取期间使用上述按键保护，不再静默拼接输入。`/new` 只能继承协议公开的 cwd/backend/model，permission/effort/sandbox/systemPrompt/tools 存在 daemon 内部 options，Thread 与 server/config/read 都不提供，无法在客户端完整继承；这些配置仍采用 daemon 默认值。`/fork` 由服务端继承完整 options，但也继承上下文，不能替代清空会话的 `/new`。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

Herdr：存在 `HERDR_PANE_ID` 时通过 `HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock` 注册 backend 与 AS thread id。接口按本机 `herdr api schema --json` protocol 19 校验：`pane.report_agent` + `pane.report_agent_session`，source=`agent-tui`。状态：未决卡片/断线/systemError 为 blocked，running/spawning 为 working，其余 idle。OSC 标题使用本机 agent-detection 的 Braille working、Claude `✳` idle、Codex `Action Required` blocked；Claude blocked 同时由卡片 `Enter to confirm · Esc to cancel` 与 socket 报告支持。Herdr 不可用仅提示，10 秒后重试，不影响 AS 会话。

```sh
bun run typecheck
cd apps/agent-tui && bun test
```

测试只用临时 Unix/WS 服务与 MockEngine，不启动真实 Claude/Codex。

`sessions.test.ts` 覆盖排序、窗口滚动、延迟 start/list/attach 按键隔离、并发提示、Esc 竞态、恢复入口、空列表与协议能力边界；`sessions-pty.test.ts` 覆盖全部会话命令、快速连续 /new、旧会话存活、断线 sinceSeq 和重启后的下一次回答。`recovery-pty.test.ts` 在干净子进程环境中 SIGKILL 独立 daemon，再恢复同一 thread、验证历史无重复及新 turn 回答，也验证关闭后的会话可恢复。

P2-a–f 回归补充：消息去重、错误与丢弃提示共存、跨尺寸 render 不改模型、失败恢复订阅清理、closed 的默认取消/显式确认、延迟扫描期间审批及问题回答；Unix 集成验证扫描尚未完成时审批已到引擎，PTY 验证默认取消后 thread 仍为 closed。
