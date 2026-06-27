export class RateLimiter {
  #window: number
  #max: number
  #hits = new Map<string, number[]>()

  constructor(opts: { window: number; max: number }) {
    this.#window = opts.window
    this.#max = opts.max
  }

  allow(key: string): boolean {
    const now = Date.now()
    const cutoff = now - this.#window
    const timestamps = (this.#hits.get(key) ?? []).filter((t) => t > cutoff)

    if (timestamps.length >= this.#max) {
      this.#hits.set(key, timestamps)
      return false
    }

    timestamps.push(now)
    this.#hits.set(key, timestamps)
    return true
  }

  reset(key: string): void {
    this.#hits.delete(key)
  }
}
