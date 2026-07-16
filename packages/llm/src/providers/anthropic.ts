import { getApiKey } from '../config.js'
import { withRetry, categorizeHttpError } from '../retry.js'
import type {
  EndpointConfig,
  Message,
  ChatOptions,
  ChatResult,
  StreamChunk,
  Provider,
} from '../types.js'

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

function apiUrl(ep: EndpointConfig): string {
  if (!ep.base_url) return DEFAULT_API_URL
  return ep.base_url.replace(/\/+$/, '') + '/v1/messages'
}

function buildPayload(
  ep: EndpointConfig,
  messages: Message[],
  opts: ChatOptions,
  stream: boolean,
): Record<string, unknown> {
  const system = messages.find((m) => m.role === 'system')
  const nonSystem = messages.filter((m) => m.role !== 'system')

  const payload: Record<string, unknown> = {
    model: ep.model,
    messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: opts.max_tokens ?? 4096,
    stream,
  }
  if (system) payload.system = system.content
  if (opts.temperature !== undefined) payload.temperature = opts.temperature
  return payload
}

function headers(ep: EndpointConfig): Record<string, string> {
  const key = getApiKey(ep)
  const h: Record<string, string> = {
    'x-api-key': key,
    'anthropic-version': API_VERSION,
    'Content-Type': 'application/json',
  }
  // 代理端点（super-relay/kimi 等）多数只认 Bearer 不认 x-api-key，两个都带；
  // 官方 API 不加 Authorization——避免 key 被当 OAuth token 校验
  if (ep.base_url) h.Authorization = `Bearer ${key}`
  return h
}

export const anthropicProvider: Provider = {
  async chat(config, messages, opts): Promise<ChatResult> {
    return withRetry(
      async () => {
        const resp = await fetch(apiUrl(config), {
          method: 'POST',
          headers: headers(config),
          body: JSON.stringify(buildPayload(config, messages, opts, false)),
          signal: opts.signal ?? AbortSignal.timeout(120_000),
        })
        if (!resp.ok) {
          const body = await resp.text().catch(() => '')
          throw categorizeHttpError(resp.status, body)
        }
        const json: any = await resp.json()
        const text =
          json.content
            ?.filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('') ?? ''
        return {
          text,
          model: json.model ?? config.model,
          endpoint: opts.endpointName,
          usage: {
            input_tokens: json.usage?.input_tokens ?? 0,
            output_tokens: json.usage?.output_tokens ?? 0,
          },
        }
      },
      { maxRetries: 3, signal: opts.signal },
    )
  },

  async *stream(config, messages, opts): AsyncGenerator<StreamChunk> {
    const resp = await fetch(apiUrl(config), {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(buildPayload(config, messages, opts, true)),
      signal: opts.signal ?? AbortSignal.timeout(120_000),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw categorizeHttpError(resp.status, body)
    }

    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let model = config.model
    let usage = { input_tokens: 0, output_tokens: 0 }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)

        try {
          const json: any = JSON.parse(data)
          if (json.type === 'message_start') {
            model = json.message?.model ?? model
            const u = json.message?.usage
            if (u) usage.input_tokens = u.input_tokens ?? 0
          } else if (json.type === 'content_block_delta') {
            const delta = json.delta?.text
            if (typeof delta === 'string' && delta.length > 0) {
              fullText += delta
              yield { type: 'text_delta', text: delta }
            }
          } else if (json.type === 'message_delta') {
            const u = json.usage
            if (u) usage.output_tokens = u.output_tokens ?? 0
          }
        } catch {
          // skip malformed SSE
        }
      }
    }

    yield {
      type: 'done',
      result: {
        text: fullText,
        model,
        endpoint: opts.endpointName,
        usage,
      },
    }
  },
}
