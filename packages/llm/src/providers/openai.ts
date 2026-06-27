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

function buildUrl(ep: EndpointConfig): string {
  const base = ep.base_url ?? 'https://api.openai.com/v1'
  return base.replace(/\/+$/, '') + '/chat/completions'
}

function buildPayload(
  ep: EndpointConfig,
  messages: Message[],
  opts: ChatOptions,
  stream: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: ep.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream,
  }
  if (opts.temperature !== undefined) payload.temperature = opts.temperature
  if (opts.max_tokens !== undefined) payload.max_tokens = opts.max_tokens
  if (opts.json_mode) payload.response_format = { type: 'json_object' }
  return payload
}

function headers(ep: EndpointConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey(ep)}`,
    'Content-Type': 'application/json',
  }
}

export const openaiProvider: Provider = {
  async chat(config, messages, opts): Promise<ChatResult> {
    return withRetry(
      async () => {
        const resp = await fetch(buildUrl(config), {
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
        const text: string = json?.choices?.[0]?.message?.content ?? ''
        const u = json?.usage ?? {}
        return {
          text,
          model: json?.model ?? config.model,
          endpoint: opts.endpointName,
          usage: {
            input_tokens: u.prompt_tokens ?? 0,
            output_tokens: u.completion_tokens ?? 0,
          },
        }
      },
      { maxRetries: 3, signal: opts.signal },
    )
  },

  async *stream(config, messages, opts): AsyncGenerator<StreamChunk> {
    const resp = await fetch(buildUrl(config), {
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
        if (data === '[DONE]') continue

        try {
          const json: any = JSON.parse(data)
          if (json.model) model = json.model
          const delta = json.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            fullText += delta
            yield { type: 'text_delta', text: delta }
          }
          if (json.usage) {
            usage = {
              input_tokens: json.usage.prompt_tokens ?? 0,
              output_tokens: json.usage.completion_tokens ?? 0,
            }
          }
        } catch {
          // skip malformed SSE lines
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
