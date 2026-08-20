import { openaiProvider } from './providers/openai.js'
import { anthropicProvider } from './providers/anthropic.js'
import type { EndpointConfig } from './types.js'

// ── endpoint 测速：单次流式请求同时测联通与吞吐 ──────────
//
// 走 provider.stream() 而非 chat()——chat 带 withRetry，会把「间歇性失败」
// 洗成「慢但成功」，测速要的是裸网络真相；stream 无重试，一次定生死。

/** 单 endpoint 一次测速的度量结果 */
export interface BenchMeasurement {
  /** 首个可见 token 延迟 ms；全程无正文（如纯 thinking 输出）为 null */
  ttft_ms: number | null
  total_ms: number
  output_tokens: number
  /** 端点没报 usage 时按 chars/4 估算 token 数 */
  tokens_estimated: boolean
  /**
   * 解码吞吐 token/s = output_tokens / (总时长 - ttft)。
   * 无 ttft 时退化为 output_tokens / 总时长；零输出为 null。
   * 注意：thinking 模型的思考 token 计在 output 里但发生在首个可见
   * token 之前，其 tps 会偏高——横向比较时同类模型才可比。
   */
  tps: number | null
  text_chars: number
  /**
   * 收到的 text_delta 事件数。均摊 token/事件 过大（如 >100）说明响应是
   * 整块缓冲送达而非逐 token 流，此时 tps 不代表真实解码速度。
   */
  deltas: number
}

export interface BenchOptions {
  /** 生成 token 上限，默认 256（太小则解码窗口短、tps 噪声大） */
  max_tokens?: number
  /** 单请求超时 ms，默认 60_000 */
  timeout_ms?: number
  /** 覆盖默认测速 prompt（默认为有界计数题，防端点忽略 max_tokens 时刷屏） */
  prompt?: string
}

const BENCH_PROMPT =
  'Count from 1 to 500, comma separated. Output only the numbers.'

/**
 * 对一个已解析的 endpoint 发一次流式请求，返回联通/延迟/吞吐度量。
 * 失败（无 key / 连不上 / HTTP 错 / 超时）原样抛出，由调用方归类展示。
 */
export async function benchEndpoint(
  ep: EndpointConfig,
  endpointName: string,
  opts: BenchOptions = {},
): Promise<BenchMeasurement> {
  const provider = ep.protocol === 'openai' ? openaiProvider : anthropicProvider
  const t0 = performance.now()
  let tFirst: number | null = null
  let text = ''
  let outputTokens = 0
  let deltas = 0

  for await (const chunk of provider.stream(
    ep,
    [{ role: 'user', content: opts.prompt ?? BENCH_PROMPT }],
    {
      max_tokens: opts.max_tokens ?? 256,
      signal: AbortSignal.timeout(opts.timeout_ms ?? 60_000),
      endpointName,
    },
  )) {
    if (chunk.type === 'text_delta') {
      if (tFirst === null) tFirst = performance.now()
      text += chunk.text
      deltas++
    } else if (chunk.type === 'done') {
      outputTokens = chunk.result.usage.output_tokens
    }
  }

  const total_ms = performance.now() - t0
  const tokens_estimated = outputTokens === 0 && text.length > 0
  if (tokens_estimated) outputTokens = Math.ceil(text.length / 4)

  const decode_ms =
    tFirst !== null ? Math.max(total_ms - (tFirst - t0), 1) : total_ms
  const tps = outputTokens > 0 ? outputTokens / (decode_ms / 1000) : null

  return {
    ttft_ms: tFirst !== null ? tFirst - t0 : null,
    total_ms,
    output_tokens: outputTokens,
    tokens_estimated,
    tps,
    text_chars: text.length,
    deltas,
  }
}
