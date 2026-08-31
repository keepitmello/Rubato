import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export const TERMINAL_TICKET_TTL_MS = 30_000
export const CANONICAL_ZMX_NAME_PATTERN = /^rubato-[0-9a-f]{12}$/

export interface TerminalLaunchIdentity {
  readonly origin: string
  readonly ownerLogin: string
  readonly zmxName: string
}

export interface TerminalLaunchTicket extends TerminalLaunchIdentity {
  readonly ticket: string
  readonly expiresAt: string
}

export interface TerminalTicketValidationHook {
  consume(ticket: string, identity: TerminalLaunchIdentity): boolean | Promise<boolean>
}

interface TicketRecord extends TerminalLaunchIdentity {
  readonly digest: Buffer
  readonly expiresAt: number
}

export class TerminalLaunchTicketStore implements TerminalTicketValidationHook {
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #records = new Map<string, TicketRecord>()

  constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? TERMINAL_TICKET_TTL_MS
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0 || this.#ttlMs > TERMINAL_TICKET_TTL_MS) {
      throw new RangeError(`terminal ticket TTL must be between 1 and ${TERMINAL_TICKET_TTL_MS} milliseconds`)
    }
  }

  issue(identity: TerminalLaunchIdentity): TerminalLaunchTicket {
    assertLaunchIdentity(identity)
    this.#purge()
    const ticket = randomBytes(32).toString("base64url")
    const digest = hash(ticket)
    const expiresAt = this.#now() + this.#ttlMs
    this.#records.set(digest.toString("hex"), { ...identity, digest, expiresAt })
    return { ...identity, ticket, expiresAt: new Date(expiresAt).toISOString() }
  }

  consume(ticket: string, identity: TerminalLaunchIdentity): boolean {
    if (!isOpaqueTicket(ticket)) return false
    assertLaunchIdentity(identity)
    this.#purge()
    const digest = hash(ticket)
    const key = digest.toString("hex")
    const record = this.#records.get(key)
    if (!record) return false
    this.#records.delete(key)
    return record.expiresAt > this.#now()
      && timingSafeEqual(record.digest, digest)
      && record.origin === identity.origin
      && record.ownerLogin === identity.ownerLogin
      && record.zmxName === identity.zmxName
  }

  peek(ticket: string, origin: string): TerminalLaunchIdentity | null {
    if (!isOpaqueTicket(ticket)) return null
    this.#purge()
    const digest = hash(ticket)
    const record = this.#records.get(digest.toString("hex"))
    if (!record || record.expiresAt <= this.#now() || !timingSafeEqual(record.digest, digest) || record.origin !== origin) return null
    return { origin: record.origin, ownerLogin: record.ownerLogin, zmxName: record.zmxName }
  }

  get size(): number {
    this.#purge()
    return this.#records.size
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, record] of this.#records) if (record.expiresAt <= now) this.#records.delete(key)
  }
}

export function assertCanonicalZmxName(value: string): void {
  if (!CANONICAL_ZMX_NAME_PATTERN.test(value)) throw new TypeError("invalid canonical Rubato zmx name")
}

export function assertLaunchIdentity(identity: TerminalLaunchIdentity): void {
  assertCanonicalZmxName(identity.zmxName)
  if (!isHttpsOrigin(identity.origin)) throw new TypeError("terminal launch origin must be an exact HTTPS origin")
  if (identity.ownerLogin.length === 0 || identity.ownerLogin.length > 320 || identity.ownerLogin.includes("\0")) {
    throw new TypeError("invalid terminal launch owner identity")
  }
}

function isOpaqueTicket(value: string): boolean {
  return value.length >= 32 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value && url.pathname === "/" && url.username === "" && url.password === ""
  } catch {
    return false
  }
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}
