import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readJson, writePrivateFile } from "./files.js"

interface NonceRecord {
  readonly digest: string
  readonly expiresAt: number
}

interface PendingClaim {
  readonly id: string
  readonly origin: string
  readonly ownerLogin: string
  readonly expiresAt: number
}

interface StoredOrigins {
  readonly schemaVersion: 1
  readonly origins: readonly string[]
}

export class PairingService {
  readonly #originsPath: string
  readonly #now: () => number
  readonly #nonces = new Map<string, NonceRecord>()
  readonly #claims = new Map<string, PendingClaim>()
  readonly #origins = new Set<string>()

  constructor(originsPath: string, now: () => number = Date.now) {
    this.#originsPath = originsPath
    this.#now = now
  }

  async load(): Promise<void> {
    const stored = await readJson<StoredOrigins>(this.#originsPath, { schemaVersion: 1, origins: [] })
    this.#origins.clear()
    for (const origin of stored.origins) if (isHttpsOrigin(origin)) this.#origins.add(origin)
  }

  issueNonce(ttlMs = 10 * 60 * 1000): { nonce: string; expiresAt: string } {
    this.#purge()
    const nonce = randomBytes(32).toString("base64url")
    const digest = hash(nonce)
    const expiresAt = this.#now() + ttlMs
    this.#nonces.set(digest, { digest, expiresAt })
    return { nonce, expiresAt: new Date(expiresAt).toISOString() }
  }

  claim(nonce: string, origin: string, ownerLogin: string): { claimId: string; expiresAt: string } {
    this.#purge()
    if (!isHttpsOrigin(origin)) throw new Error("pairing origin must be an exact HTTPS origin")
    const digest = hash(nonce)
    const record = this.#nonces.get(digest)
    if (!record || record.expiresAt <= this.#now()) throw new Error("invalid or expired pairing nonce")
    this.#nonces.delete(digest)
    const claimId = randomUUID()
    const claim: PendingClaim = { id: claimId, origin, ownerLogin, expiresAt: Math.min(record.expiresAt, this.#now() + 60_000) }
    this.#claims.set(claimId, claim)
    return { claimId, expiresAt: new Date(claim.expiresAt).toISOString() }
  }

  async approve(claimId: string, ownerLogin: string, confirmed: boolean, requestOrigin?: string): Promise<string> {
    this.#purge()
    if (!confirmed) throw new Error("pairing confirmation required")
    const claim = this.#claims.get(claimId)
    if (!claim || claim.ownerLogin !== ownerLogin || claim.expiresAt <= this.#now() || (requestOrigin !== undefined && claim.origin !== requestOrigin)) throw new Error("invalid pairing claim")
    this.#claims.delete(claimId)
    this.#origins.add(claim.origin)
    await this.#persist()
    return claim.origin
  }

  isPaired(origin: string | null | undefined): boolean {
    return typeof origin === "string" && this.#origins.has(origin)
  }

  corsHeaders(origin: string | null | undefined): Readonly<Record<string, string>> {
    if (!this.isPaired(origin)) return {}
    return cors(origin!)
  }

  pairingCorsHeaders(origin: string | null | undefined): Readonly<Record<string, string>> {
    return typeof origin === "string" && isHttpsOrigin(origin) ? cors(origin) : {}
  }

  listOrigins(): readonly string[] {
    return [...this.#origins].sort()
  }

  async revoke(origin: string): Promise<boolean> {
    const deleted = this.#origins.delete(origin)
    if (deleted) await this.#persist()
    return deleted
  }

  async #persist(): Promise<void> {
    await writePrivateFile(this.#originsPath, JSON.stringify({ schemaVersion: 1, origins: this.listOrigins() }))
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, nonce] of this.#nonces) if (nonce.expiresAt <= now) this.#nonces.delete(key)
    for (const [key, claim] of this.#claims) if (claim.expiresAt <= now) this.#claims.delete(key)
  }
}

function cors(origin: string): Readonly<Record<string, string>> {
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "600",
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value && url.username === "" && url.password === "" && url.pathname === "/"
  } catch {
    return false
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
