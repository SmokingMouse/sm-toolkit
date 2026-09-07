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

输入支持多行：Shift+Enter（终端须发送 CSI-u 或 modifyOtherKeys 编码）或 Ctrl+J 换行，Enter 发送整段。终端的 bracketed paste 模式会将 CR/CRLF 统一为 LF，保留换行、缩进和首尾空白；粘贴不会自动发送。未支持 Shift+Enter 的终端请用 Ctrl+J。输入区显示最后六行。

输入 `@` 后显示当前会话 cwd 下的文件候选，优先用 `git ls-files --cached --others --exclude-standard`（仓库内遵守 Git 忽略规则并保留已跟踪文件）；不可用时尝试可选的 `rg --files`，再降级为纯 fs 递归，读取逐层 `.gitignore` 的 glob、目录及否定规则。三条路径均排除 `.git`/`node_modules`，不列出失效文件。无需安装 rg，git 和 rg 均不存在时也可补全。支持不连续字符模糊匹配，最多 50 条。输入 `/` 显示内建命令和 `~/.claude/skills/*/SKILL.md`、`<cwd>/.claude/skills/*/SKILL.md` 的名称及一行描述；支持 symlink，项目同名 skill 优先，内建命令保留优先级。列表缓存五秒。

候选打开时，↑/↓ 切换，Tab 或 Enter 插入所选内容及尾随空格，Esc 关闭；再次 Enter 才发送。文件插入相对路径（含空格时自动加引号），普通文件引用保持 `@path` 文本；skill 插入 `/name` 文本，由后端解释。候选关闭时 Tab 仍切换 reasoning。

模糊排序先放完整连续命中的候选，连续命中位置越早越优先；其次是不连续子序列，按跳过字符数排序；同分按名称排序。保留连续优先的承诺，是因为完整文件名片段比偶然散落的字符更符合查找意图。

图片用 `看看 @./shot.png`、`@/absolute/shot.jpg` 或 `@"folder/shot name.webp"`，支持 png/jpg/jpeg/gif/webp（大小写均可），发送时转为协议的图片附件，消息中显示 `[image] 路径` 占位。`/image <path>` 直接发送图片，路径相对会话 cwd；找不到或无法读取时保留输入并显示错误。macOS 的 `/paste-image` 调用本机 `pngpaste`，把剪贴板图片存入系统临时目录并附加到草稿，可继续输入说明后按 Enter 发送；未安装时提示 `brew install pngpaste`。Ctrl-U 清空文字和待发附件。

图片走已有的本地路径协议；使用 WS 连接时，daemon 必须也能读取同一路径。成功粘贴的临时文件会保留，供排队消息和重试读取，避免退出 TUI 后排队图片失效；不自动上传或删除。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

问题卡自由回答支持多行粘贴，与主输入共用 CR/CRLF → LF 归一。粘贴只写入草稿，不会触发数字选项或自动提交；按 Enter 后才发送回答，内部换行与缩进保留。

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
