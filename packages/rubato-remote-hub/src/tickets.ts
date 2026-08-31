import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

interface TicketRecord {
  readonly digest: Buffer
  readonly origin: string
  readonly ownerLogin: string
  readonly expiresAt: number
}

export class TicketStore {
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #tickets = new Map<string, TicketRecord>()

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 15_000
    this.#now = options.now ?? Date.now
  }

  issue(origin: string, ownerLogin: string): { ticket: string; expiresAt: string } {
    this.#purge()
    const ticket = randomBytes(32).toString("base64url")
    const digest = hash(ticket)
    const expiresAt = this.#now() + this.#ttlMs
    this.#tickets.set(digest.toString("hex"), { digest, origin, ownerLogin, expiresAt })
    return { ticket, expiresAt: new Date(expiresAt).toISOString() }
  }

  consume(ticket: string, origin: string, ownerLogin: string): boolean {
    this.#purge()
    const digest = hash(ticket)
    const key = digest.toString("hex")
    const record = this.#tickets.get(key)
    if (!record) return false
    this.#tickets.delete(key)
    return timingSafeEqual(record.digest, digest) && record.origin === origin && record.ownerLogin === ownerLogin && record.expiresAt > this.#now()
  }

  get size(): number {
    this.#purge()
    return this.#tickets.size
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, record] of this.#tickets) if (record.expiresAt <= now) this.#tickets.delete(key)
  }
}

function hash(ticket: string): Buffer {
  return createHash("sha256").update(ticket).digest()
}
