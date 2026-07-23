# @smokingmouse/llm

配置驱动的 LLM 直连 API 客户端：一份 `endpoints.yaml` 声明所有 provider（OpenAI / Anthropic 两种线协议兼容端点），统一模型解析 + retry。Config-driven LLM client for OpenAI/Anthropic-compatible endpoints.

```sh
bun add @smokingmouse/llm   # 或 npm i
```

## 配置

`endpoints.yaml` 搜索顺序：`$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml` → `~/.claude/global/endpoints.yaml`（legacy）。模板见包内 [endpoints.example.yaml](./endpoints.example.yaml)。

API key 不写进配置文件——yaml 里只写环境变量名（`api_key_env`），key 本体放环境变量或 `env_file`。

```ts
import { LLMClient } from '@smokingmouse/llm'
const client = new LLMClient()
// endpoint 传 undefined = 用 yaml 的 default 模型；也可写模型名 / "provider:model"
const reply = await client.chat(undefined, [{ role: 'user', content: 'hi' }])
```

源码与文档：[SmokingMouse/sm-toolkit](https://github.com/SmokingMouse/sm-toolkit)
