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

输入支持多行：Shift+Enter（终端须发送 CSI-u 或 modifyOtherKeys 编码）或 Ctrl+J 换行，Enter 发送整段。终端的 bracketed paste 模式会保留粘贴的换行、缩进和首尾空白；粘贴不会自动发送。未支持 Shift+Enter 的终端请用 Ctrl+J。输入区显示最后六行。

输入 `@` 后显示当前会话 cwd 下的文件候选，使用 `rg --files` 递归扫描，遵守嵌套 `.gitignore`、排除 `.git`/`node_modules`，支持不连续字符模糊匹配，最多 50 条。需要本机安装 ripgrep（macOS：`brew install ripgrep`）。输入 `/` 显示内建命令和 `~/.claude/skills/*/SKILL.md`、`<cwd>/.claude/skills/*/SKILL.md` 的名称及一行描述；支持 symlink，项目同名 skill 优先，内建命令保留优先级。列表缓存五秒。

候选打开时，↑/↓ 切换，Tab 或 Enter 插入所选内容及尾随空格，Esc 关闭；再次 Enter 才发送。文件插入相对路径（含空格时自动加引号），普通文件引用保持 `@path` 文本；skill 插入 `/name` 文本，由后端解释。候选关闭时 Tab 仍切换 reasoning。

图片用 `看看 @./shot.png`、`@/absolute/shot.jpg` 或 `@"folder/shot name.webp"`，支持 png/jpg/jpeg/gif/webp（大小写均可），发送时转为协议的图片附件，消息中显示 `[image] 路径` 占位。`/image <path>` 直接发送图片，路径相对会话 cwd；找不到或无法读取时保留输入并显示错误。macOS 的 `/paste-image` 调用本机 `pngpaste`，把剪贴板图片存入系统临时目录并附加到草稿，可继续输入说明后按 Enter 发送；未安装时提示 `brew install pngpaste`。Ctrl-U 清空文字和待发附件。

图片走已有的本地路径协议；使用 WS 连接时，daemon 必须也能读取同一路径。成功粘贴的临时文件会保留，供排队消息和重试读取，避免退出 TUI 后排队图片失效；不自动上传或删除。

审批：y 允许、s 本会话允许、n 拒绝、a 中止；permissions 的协议没有 abort 枚举，因此 a 先回空授权再中断该 turn。问题卡用数字选择/切换，Enter 下一题或提交，支持自由文本；超过 9 个选项时输入编号后 Space 切换。Esc 拒绝审批或交空答案取消问题。提交后等待服务端 resolved；他端先答显示「已由 X 处理」。断线期间禁用卡片，重连用快照恢复；离线期间已解决的卡片会标注处理者未知。

Herdr：存在 `HERDR_PANE_ID` 时通过 `HERDR_SOCKET_PATH` → `$XDG_CONFIG_HOME/herdr/herdr.sock` → `~/.config/herdr/herdr.sock` 注册 backend 与 AS thread id。接口按本机 `herdr api schema --json` protocol 19 校验：`pane.report_agent` + `pane.report_agent_session`，source=`agent-tui`。状态：未决卡片/断线/systemError 为 blocked，running/spawning 为 working，其余 idle。OSC 标题使用本机 agent-detection 的 Braille working、Claude `✳` idle、Codex `Action Required` blocked；Claude blocked 同时由卡片 `Enter to confirm · Esc to cancel` 与 socket 报告支持。Herdr 不可用仅提示，10 秒后重试，不影响 AS 会话。

```sh
bun run typecheck
cd apps/agent-tui && bun test
```

测试只用临时 Unix/WS 服务与 MockEngine，不启动真实 Claude/Codex。

输入 PTY E2E 自己创建 Bun PTY，父进程无需交互式终端。每一步按引擎收包或最新屏幕状态等待（10 秒上限），失败会打印步骤、子进程退出码和末尾终端输出；每例总预算 60 秒，覆盖启动、多个 RPC/渲染步骤及清理。图片例在模拟 pngpaste 中注入 5.2 秒延迟，回归默认 5 秒总超时导致的失败；同步仍等待实际附件状态。模拟程序使用绝对系统命令，TUI 使用测试进程同一 Bun，避免父进程 PATH 中的包装脚本改变测试行为。
