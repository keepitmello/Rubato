import { createHash, randomBytes } from "node:crypto"
import type { LiveSessionId } from "@rubato/remote-protocol"

interface SurfaceToken {
  readonly liveSessionId: LiveSessionId
  readonly digest: string
  readonly expiresAt: number
}

export class SurfaceTokenStore {
  readonly #now: () => number
  readonly #tokens = new Map<string, SurfaceToken>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  issue(liveSessionId: LiveSessionId, ttlMs = 60_000): string {
    this.#purge()
    const token = randomBytes(32).toString("base64url")
    const digest = hash(token)
    this.#tokens.set(digest, { liveSessionId, digest, expiresAt: this.#now() + ttlMs })
    return token
  }

  consume(liveSessionId: LiveSessionId, token: string): boolean {
    this.#purge()
    const digest = hash(token)
    const record = this.#tokens.get(digest)
    if (!record) return false
    this.#tokens.delete(digest)
    return record.liveSessionId === liveSessionId && record.expiresAt > this.#now()
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, value] of this.#tokens) if (value.expiresAt <= now) this.#tokens.delete(key)
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
