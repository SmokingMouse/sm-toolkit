export class CostGate {
  #perCall: number
  #daily: number
  #todaySpent = 0
  #todayDate = ''

  constructor(opts: { perCall?: number; daily?: number }) {
    this.#perCall = opts.perCall ?? Infinity
    this.#daily = opts.daily ?? Infinity
  }

  check(estimatedTokens: number): void {
    this.#rollDay()
    if (estimatedTokens > this.#perCall) {
      throw new Error(
        `CostGate: estimated ${estimatedTokens} tokens exceeds per-call limit of ${this.#perCall}`,
      )
    }
    if (this.#todaySpent + estimatedTokens > this.#daily) {
      throw new Error(
        `CostGate: daily budget exhausted (spent=${this.#todaySpent}, limit=${this.#daily})`,
      )
    }
  }

  record(actualTokens: number): void {
    this.#rollDay()
    this.#todaySpent += actualTokens
  }

  get todaySpent(): number {
    this.#rollDay()
    return this.#todaySpent
  }

  get dailyRemaining(): number {
    this.#rollDay()
    return Math.max(0, this.#daily - this.#todaySpent)
  }

  #rollDay(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.#todayDate) {
      this.#todayDate = today
      this.#todaySpent = 0
    }
  }
}
