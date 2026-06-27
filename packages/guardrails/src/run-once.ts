import type { KVStore } from '@sm/store'

export async function runOnce<T>(
  key: string,
  fn: () => Promise<T>,
  kv: KVStore,
): Promise<T> {
  const existing = await kv.get(`runonce:${key}`)
  if (existing !== null) {
    return JSON.parse(existing) as T
  }

  const result = await fn()
  await kv.set(`runonce:${key}`, JSON.stringify(result))
  return result
}
