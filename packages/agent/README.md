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

## RunOptions

下列协议字段仅由 `ClaudeBackend` 消费；全部可选，省略时保持 0.6.x 的默认行为。

| 字段 | 类型 | 省略时 | Claude 行为 |
|---|---|---|---|
| `maxTurns` | `number` | CLI 默认轮数 | 正整数，映射 `--max-turns`；非法值直接抛错 |
| `skills` | `string[]` | 加载 CLI 默认 Skill 集 | `[]` 全关；非空数组只向主会话暴露匹配 Skill，可与 `environmentSkills:false` 总闸叠加 |
| `askTools` | `string[] \| "all"` | 不额外强制询问 | 名单只拦指定工具；`"all"` 让所有工具调用进入 `onCanUseTool` |
| `mcpServers` | `Record<string, http \| stdio \| sdk>` | 不注入 MCP server | http/stdio 写临时 `--mcp-config`；sdk 接官方 MCP Server instance，经 control protocol 回流宿主执行，要求常开 stdin |

第三方 Anthropic 兼容端点（deepseek / kimi / ark …）可选：配一份 endpoints.yaml（见 [@smokingmouse/llm](https://www.npmjs.com/package/@smokingmouse/llm)），`model` 直接写里面的模型名即可；不配则原生 claude / codex 照常可用。

源码与文档：[SmokingMouse/sm-toolkit](https://github.com/SmokingMouse/sm-toolkit)
