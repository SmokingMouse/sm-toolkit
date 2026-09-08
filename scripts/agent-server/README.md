# 用户级 agent-server LaunchAgent

本目录仅提供部署工具；测试不安装服务。主控将整个已构建 workspace 放到稳定 release 路径，保留 TUI 源码、workspace 依赖与 Bun。不要使用开发 worktree 作为生产 release。

先 `bun run typecheck`，再 `bun scripts/agent-server/install.ts /absolute/release --dry-run` 审阅 plist。确认 PATH 中 Bun、codex、claude 的真实路径与认证后，去掉 `--dry-run` 执行安装。安装用 `launchctl bootstrap gui/<uid>`，前台 `run --grace-ms 5000`，崩溃 KeepAlive 重启，间隔至少 10 秒。没有 AbandonProcessGroup，保留 launchd 默认进程组回收。

模板固定 HOME 与 socket `~/.sm-toolkit/agent-server.sock`；默认 token / DB / config / daemon 日志在 `~/.agent-server/{token,agent-server.db,config.toml,agent-server.log}`。launchd stdout/stderr 单独在 `~/Library/Logs/agent-server.launchd.{out,err}.log`。不把 token 内容放 argv。客户端可使用相同 HOME/XDG，或为 TUI 同时显式传 `--socket <path> --token-path <path>`；fj 自动传递并持久化这两个路径，pane 无须继承相同 HOME。测试必须同时隔离 socket 和 XDG_STATE_HOME。

config.toml 的 `allowed_roots` 必须包含项目主仓（信箱根）和所有执行 worktree；fjContext.root 也受该表限制。初始化后调用 `server/health` 确认就绪，不能仅看 PID。线程级 permission 明确传 full，不设 daemon 全局默认。

停用：`sh scripts/agent-server/uninstall.sh`，先 bootout 后归档 plist，保留数据与日志。服务已不存在时仍归档 plist，重复执行成功；bootout 失败且服务仍存在时保留 plist 并报错。只执行 daemon stop 会被 KeepAlive 拉回。升级先停止派单、处理在途 turn 与队列、bootout，再换 release、bootstrap。升级 fj 时一并更新 TUI：ready nonce 改用 `--ready-nonce-file` 私有文件，旧版 TUI 不兼容新握手参数。

重启会将原在途标为 systemError/failed；不自动重投。先核对工作区、队列和残留进程，取消不应恢复的排队轮次，再显式 thread/resume。TUI --attach 只重连显示，不续跑引擎；崩溃在途 delta 不保证保留。生产试点必须验证 SIGKILL 后旧引擎及其工具后代已退出；需要新凭证时交主控处理。
