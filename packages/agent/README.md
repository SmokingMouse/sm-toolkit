# @smokingmouse/agent

Claude Code / Codex CLI 编排引擎：spawn 本机 `claude` / `codex` CLI，把 stream-json 归一成统一 `AgentEvent` 流（文本/thinking/工具调用/权限回调/成本）。Backend abstraction over the Claude Code & Codex CLIs.

```sh
bun add @smokingmouse/agent   # 或 npm i
```

前置：本机装好并登录 `claude` CLI（`npm i -g @anthropic-ai/claude-code && claude login`）；`codex` CLI 可选。

```ts
import { ClaudeBackend } from '@smokingmouse/agent'
for await (const e of new ClaudeBackend().run('hello', { model: 'sonnet' })) {
  // e: AgentEvent — TextChunk / Thinking / ToolCall / Result / ...
}
```

第三方 Anthropic 兼容端点（deepseek / kimi / ark …）可选：配一份 endpoints.yaml（见 [@smokingmouse/llm](https://www.npmjs.com/package/@smokingmouse/llm)），`model` 直接写里面的模型名即可；不配则原生 claude / codex 照常可用。

源码与文档：[SmokingMouse/sm-toolkit](https://github.com/SmokingMouse/sm-toolkit)
