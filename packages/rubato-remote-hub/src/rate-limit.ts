export class SlidingWindowRateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #entries = new Map<string, number[]>()

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit
    this.#windowMs = windowMs
    this.#now = now
  }

  take(key: string): boolean {
    const now = this.#now()
    const cutoff = now - this.#windowMs
    const timestamps = (this.#entries.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
    if (timestamps.length >= this.#limit) {
      this.#entries.set(key, timestamps)
      return false
    }
    timestamps.push(now)
    this.#entries.set(key, timestamps)
    return true
  }
}
