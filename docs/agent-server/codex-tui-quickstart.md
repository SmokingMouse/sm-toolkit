# Codex 官方 TUI 接入 agent-server

当前协议基线为 `codex-cli 0.153.4`。官方 TUI 通过独立 codex-ingress 连接 daemon，可显示 Codex 与 Claude 线程；进程、审批、队列和历史由 agent-server 管理。需已安装 bun、Codex CLI；使用 Claude 时还需 Claude CLI 与已有登录态。

## 启动

在 daemon 的 `config.toml`（默认 `~/.agent-server/config.toml`，XDG 路径见[包 README](../../packages/agent-server/README.md)）中合并：

```toml
[codex_ingress]
enabled = true
claude_threads = true
port = 0
unix_path = "default"
```

项目目录须已在 daemon 的 `allowed_roots` 内。在仓库根目录执行：

```sh
bun install
bun run typecheck
packages/agent-server/bin/agent-server run
```

已有托管 daemon 按[部署说明](../../scripts/agent-server/README.md)重启，先处理在途任务。endpoint 文件为 as/1 socket 路径加 `.endpoint.json`；默认 `~/.sm-toolkit/agent-server.sock.endpoint.json`，其 `codexIngressUrl` / `codexIngressUnixUrl` 给出实际入口。

## 连接

Unix 连接使用 endpoint 的 `codexIngressUnixUrl`，默认路径示例：

```sh
codex --remote "unix://${CODEX_HOME:-$HOME/.codex}/agent-server/ingress.sock" --model gpt-5.6-sol
```

这是 WebSocket over Unix socket，无需 bearer 参数。socket 为 0600，父目录须本用户所有且 0700；路径不能已被占用，macOS 上最长 103 字节。

WS 连接将下面地址替换为 endpoint 的 `codexIngressUrl`；token 路径同样应与 daemon 一致：

```sh
export AS_NATIVE_TOKEN="$(cat "$HOME/.agent-server/token")"
codex --remote ws://127.0.0.1:PORT --remote-auth-token-env AS_NATIVE_TOKEN --model gpt-5.6-sol
unset AS_NATIVE_TOKEN
```

WS 只监听 loopback，鉴权通过请求头；不要把 token 值填进 argv。新建 Claude 线程将 `--model` 改为 `sonnet` 或 `opus`；模型仍受 daemon 的允许规则约束。

## 会话与限制

使用 `/resume` 在 picker 中切换线程、`/fork` 分叉、Esc 中断当前 turn。已有线程上的跨后端启动模型覆盖会被忽略，并提示沿用原模型；新建线程才选择引擎。显示端退出或崩溃后 turn 继续执行，重新连接可读取完成历史。

四类审批通过 AS broker 处理；Claude 通用工具权限显示为 allow/deny 问答。配置/文件/插件等未支持的 native 方法明确拒绝。Claude 多选问答、输出流、effort 及只读名单限制详见[协议](protocol.md)，完整方法清单见[治理表](codex-method-policy.md)。只读名单的自定义条目不自动获得参数安全校验。

## 验证与升级

```sh
python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex
python3 packages/agent-server/scripts/codex-remote-smoke.py --backend claude
python3 packages/agent-server/scripts/codex-remote-smoke.py --backend codex --transport unix
scripts/codex-ingress-upgrade-check.sh --out /tmp/codex-upgrade-report
```

升级脚本默认双后端 × WS/Unix × 三轮，包含模型覆盖兼容、wire schema、显示端断连及 Claude 权限问答，另跑全量测试和 typecheck；`schema.diff` 必须为空且全部检查 exit 0。冒烟隔离 HOME/DB/socket，Codex 模型响应使用本地 fixture，Claude 使用真实模型与已有登录；产物目录含隔离登录副本，只分享脱敏日志及 summary，勿整体公开。
