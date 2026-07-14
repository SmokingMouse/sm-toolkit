// ── config file schema ──────────────────────────────────

export interface ProviderConfig {
  api_key_env: string
  openai_url?: string
  anthropic_url?: string
  models: string[]
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
