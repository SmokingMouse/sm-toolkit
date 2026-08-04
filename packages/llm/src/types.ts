// ── config file schema ──────────────────────────────────

export interface ProviderConfig {
  api_key_env: string
  openai_url?: string
  anthropic_url?: string
  models: string[]
  /** provider 级 claude session 配置，env 覆盖顶层 claude: 同名项，args 追加其后 */
  claude?: ClaudeSettings
  /** 显式声明该端点可供 codex CLI 使用（及其 wire 协议）。不写 = 不给 codex 注入 */
  codex?: CodexSettings
}

/**
 * codex CLI 端点声明。codex 0.146.0 起 wire_api="chat" 已废弃（openai/codex#7782），
 * 只有 Responses API 端点能接——所以这是显式 opt-in 标记：chat-only 的 openai_url
 * （deepseek/gemini/ark 等）绝不能标，注入了也只会 400。
 */
export interface CodexSettings {
  wire_api: 'responses'
}

/** 启动 claude CLI 交互 session 时的附加配置（llm 无 -p 路径透传） */
export interface ClaudeSettings {
  /** 附加环境变量（覆盖自动推导的默认值） */
  env?: Record<string, string>
  /** 附加命令行参数（如 --dangerously-skip-permissions） */
  args?: string[]
}

export interface ConfigFile {
  providers: Record<string, ProviderConfig>
  default: string
  env_file?: string
  claude?: ClaudeSettings
}

// ── resolved flat config (per model, used by provider impls) ──

export interface EndpointConfig {
  base_url?: string
  api_key_env: string
  model: string
  protocol: 'openai' | 'anthropic'
  /** 所属 provider 的 claude 块（若有），供启动 claude session 的调用方合并 */
  claude?: ClaudeSettings
  /** 所属 provider 的 codex 块（若有），供 CodexBackend 判定可否注入端点 */
  codex?: CodexSettings
}

// ── listing types ───────────────────────────────────────

export interface ProviderInfo {
  name: string
  openai_url?: string
  anthropic_url?: string
  hasKey: boolean
  models: string[]
}

export interface EndpointInfo {
  name: string
  model: string
  provider: string
  openai_url?: string
  anthropic_url?: string
  hasKey: boolean
}

// ── chat types ──────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  max_tokens?: number
  temperature?: number
  json_mode?: boolean
  signal?: AbortSignal
}

export interface ChatResult {
  text: string
  model: string
  endpoint: string
  usage: { input_tokens: number; output_tokens: number }
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'done'; result: ChatResult }

export interface Provider {
  chat(
    config: EndpointConfig,
    messages: Message[],
    opts: ChatOptions & { endpointName: string },
  ): Promise<ChatResult>

  stream(
    config: EndpointConfig,
    messages: Message[],
    opts: ChatOptions & { endpointName: string },
  ): AsyncGenerator<StreamChunk>
}
