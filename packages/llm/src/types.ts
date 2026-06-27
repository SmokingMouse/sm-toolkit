export interface EndpointConfig {
  base_url?: string
  api_key_env: string
  model: string
}

export interface EndpointsFile {
  endpoints: Record<string, EndpointConfig>
  default: string
  env_file?: string
}

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

export interface EndpointInfo {
  name: string
  model: string
  base_url?: string
  hasKey: boolean
}

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
