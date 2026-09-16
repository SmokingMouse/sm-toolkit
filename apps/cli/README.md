# @smokingmouse/cli

`llm` —— 统一 LLM 命令行。入口用 `#!/usr/bin/env bun` 直跑 TypeScript，**需要机器上已装 [bun](https://bun.sh)**。

```sh
bun install -g @smokingmouse/cli   # 或 npm install -g @smokingmouse/cli
```

## 用法

```sh
llm                           # 交互选择模型（支持即时模糊打字过滤 / Recent置顶回车秒开 / Tab切厂商）
llm <model|provider|alias>    # 直接指定模型、厂商或常用别名启动交互 session
llm -p "问题"                 # 直连 API 单轮问答（默认模型）
llm <model> -p "问题"         # 指定模型直调 API（支持别名与唯一子串）
llm --list                    # 列出 endpoints.yaml 里的全部模型与 key 状态
llm update                    # 检查并自动升级 @smokingmouse/cli 到最新版本
llm bench                     # 全端点测速（ttft / tps / 连通性）
```

## 快捷交互与智能匹配

- **⚡ 最近使用 (MRU)**：打开 `llm` 直接按 `Enter` 秒开上次使用的模型；常用模型自动置顶。
- **🔍 即时模糊搜索**：进入交互选择器后直接打字（如 `3.7`、`fa`、`son`、`k3`），实时过滤并高亮。
- **🗂️ 厂商模式一键切换**：按 `Tab` 在全量模型平铺搜索与按厂商分组浏览之间切换；按 `Esc` 优雅退回上一级。
- **🎯 命令行别名与子串**：
  - `llm fa` / `llm fable` → `claude-fable-5`
  - `llm 3.7` / `llm flash` → `gemini-3.7-flash-high`
  - `llm op` / `llm opus` → `claude-opus-4-8`
  - `llm so` / `llm sonnet` → `claude-sonnet-5`
  - `llm k3` → `k3`
  - `llm ds` / `llm dr` → `deepseek-v4-flash` / `deepseek-v4-pro`
  - `llm cpa` → 多模型厂商自动预填并唤起交互挑选具体模型

## 跑在 agent-server 上（`--as`）

默认行为不变：`llm <model>` 仍然在本地 `spawn claude`。加 `--as` 则换一条路线——
先经 as/1 在常驻 agent-server daemon 上建一条 `backend=claude` 的线程，再 exec 官方
**Codex TUI** `resume <nativeId>` 接上去。换来的是 daemon 独占引擎进程、审批 broker
与 SQLite 审计日志（线程在 `thread/list` / Trellis 主页里可见、可中断、可审批）。

```sh
llm sonnet --as                          # 走 agent-server
llm sonnet --as --permission readonly    # readonly | default | auto-edit | full（默认 full）
llm sonnet --local                       # 强制本地（默认）
LLM_ROUTE=as llm sonnet                  # 用环境变量设默认路线，命令行 flag 优先
llm sonnet --as --print-launch           # 只打印路线判定结果与 argv，不 exec（dry run）
```

**显示端是 Codex TUI，不是 Claude Code TUI。** `/` 菜单、plan mode UI、teammate 面板
这些 Claude Code 自己的界面都没有；能用的是 Codex 的 `/resume` `/fork` `/rename`
`/quit` `Esc`。跑的引擎仍然是 Claude。

路线判定与失败处理：

| 情形 | 结果 |
|---|---|
| endpoint 文件缺 / 连不上 socket / `server/health` 不 ok / codex 二进制不支持 `--remote` | 静默回落本地，stderr 一行 `llm: agent-server 不可用，回落本地：<原因>` |
| cwd 不在 daemon 的 `allowed_roots` | 同上回落，原因里含 `allowed_roots` |
| 模型被 `denied_models` 拒 / daemon 要求显式模型 | **不回落**，stderr 打人话并非零退出（你明确要上 daemon，不该被悄悄换路线） |

### 三条坑

1. **cwd 必须在 `allowed_roots` 里**（daemon 默认只允许 `$HOME`）。在 `/tmp`、
   `/Volumes/*`、`/opt` 下 `--as` 起不来，会回落本地。
2. **`fable` 被 `denied_models` 拒**（默认名单 `["fable", "claude-fable*"]`）。而
   `llm claude` / `llm fa` / `llm fable` 三个别名全指向 `claude-fable-5`——这几条在
   `--as` 下会直接报错退出。换模型，或加 `--local`。
3. **改了 endpoints.yaml 要重启 daemon 才生效**。daemon 侧 `loadEndpoints()` 的缓存是
   模块级、永不失效；`llm` 自己是每次进程重读，两边不一致。新加的模型名在 AS 路线上
   要等 `launchctl kickstart -k gui/$(id -u)/com.smokingmouse.agent-server` 之后才认。

另外：AS 路线上客户端传不进 env（`thread/start` 拒绝 `env` 字段），所以 endpoints.yaml
**顶层** `claude.args` / `claude.env`（`--teammate-mode in-process`、
`CLAUDE_CODE_EFFORT_LEVEL` 等）不生效——启动时会把被忽略的 key 名打到 stderr。
provider 级 `claude.env` 仍由 daemon 侧解析保留。凭证也由 daemon 自己从
endpoints.yaml 的 `env_file` 读，不走客户端。

需要本机有支持 `--remote-auth-token-env` 的 `codex`（可用 `SM_AS_CODEX_BIN` 指定路径）；
endpoint 文件默认 `~/.sm-toolkit/agent-server.sock.endpoint.json`，可用
`SM_AS_ENDPOINT_JSON` 覆盖（ingress 端口每次 daemon 重启都变，所以每次都重读、不缓存）。

## 配置

模型与端点来自 endpoints.yaml，搜索顺序：`$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml`。
格式见 [@smokingmouse/llm](https://www.npmjs.com/package/@smokingmouse/llm) 随包的 `endpoints.example.yaml`。

启动 Claude Code session 需要已安装 `claude`（`npm install -g @anthropic-ai/claude-code`）。
