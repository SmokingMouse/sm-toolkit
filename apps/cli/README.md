# @smokingmouse/cli

`llm` —— 统一 LLM 命令行。入口用 `#!/usr/bin/env bun` 直跑 TypeScript，**需要机器上已装 [bun](https://bun.sh)**。

```sh
bun install -g @smokingmouse/cli   # 或 npm install -g @smokingmouse/cli
```

## 用法

```
llm                       交互选择模型，启动 Claude Code session
llm <model|provider>      直接指定模型启动交互 session
llm -p "问题"             直连 API 单轮问答
llm --list                列出 endpoints.yaml 里的全部模型
```

## 配置

模型与端点来自 endpoints.yaml，搜索顺序：`$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml`。
格式见 [@smokingmouse/llm](https://www.npmjs.com/package/@smokingmouse/llm) 随包的 `endpoints.example.yaml`。

启动 Claude Code session 需要已安装 `claude`（`npm install -g @anthropic-ai/claude-code`）。
