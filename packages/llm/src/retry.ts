export interface RetryOptions {
  maxRetries?: number
  signal?: AbortSignal
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  let lastErr: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (e: any) {
      lastErr = e
      const isTimeout =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
      const retriable = isTimeout || e?.retriable === true
      if (retriable && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      throw e
    }
  }

  throw lastErr ?? new Error('unknown error')
}

export function categorizeHttpError(
  status: number,
  body: string,
): Error & { retriable: boolean } {
  const e: any = new Error(`${status}: ${body.slice(0, 200)}`)
  e.retriable = status === 429 || status >= 500
  return e
}
