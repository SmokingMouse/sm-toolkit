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

## 配置

模型与端点来自 endpoints.yaml，搜索顺序：`$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml`。
格式见 [@smokingmouse/llm](https://www.npmjs.com/package/@smokingmouse/llm) 随包的 `endpoints.example.yaml`。

启动 Claude Code session 需要已安装 `claude`（`npm install -g @anthropic-ai/claude-code`）。
