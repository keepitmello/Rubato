import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { writePrivateFile } from "./files.js"

const execFileAsync = promisify(execFile)
const EXCLUDED = new Set([
  "PWD", "OLDPWD", "SHLVL", "_", "TERM", "TERM_SESSION_ID", "ZMX_SESSION", "TMUX", "SSH_TTY", "CMUX_SOCKET_PATH", "__CFBundleIdentifier",
])

export interface SecretKeyStore {
  getOrCreate(): Promise<Buffer>
}

export class MacKeychainKeyStore implements SecretKeyStore {
  readonly #service: string
  readonly #account: string

  constructor(service = "com.keepitmello.rubato.remote.launch-env", account = process.env["USER"] ?? "rubato") {
    this.#service = service
    this.#account = account
  }

  async getOrCreate(): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", this.#service, "-a", this.#account, "-w"])
      return Buffer.from(stdout.trim(), "base64")
    } catch {
      const key = randomBytes(32)
      await execFileAsync("/usr/bin/security", ["add-generic-password", "-U", "-s", this.#service, "-a", this.#account, "-w", key.toString("base64")])
      return key
    }
  }
}

export class EnvironmentVault {
  readonly #path: string
  readonly #keys: SecretKeyStore

  constructor(path: string, keys: SecretKeyStore) {
    this.#path = path
    this.#keys = keys
  }

  async save(environment: Readonly<Record<string, string | undefined>>): Promise<string> {
    const filtered: Record<string, string> = {}
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined && !EXCLUDED.has(name) && !name.includes("\0") && !value.includes("\0")) filtered[name] = value
    }
    const plaintext = Buffer.from(JSON.stringify(filtered))
    const key = await this.#key()
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const payload = {
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: encrypted.toString("base64"),
    }
    await writePrivateFile(this.#path, JSON.stringify(payload))
    return createHash("sha256").update(plaintext).digest("hex")
  }

  async load(): Promise<Readonly<Record<string, string>>> {
    const raw = JSON.parse(await readFile(this.#path, "utf8")) as Record<string, unknown>
    if (raw["schemaVersion"] !== 1 || raw["algorithm"] !== "AES-256-GCM") throw new Error("unsupported launch environment")
    const nonce = decode(raw["nonce"])
    const tag = decode(raw["tag"])
    const ciphertext = decode(raw["ciphertext"])
    const decipher = createDecipheriv("aes-256-gcm", await this.#key(), nonce)
    decipher.setAuthTag(tag)
    const value = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as unknown
    if (!isStringRecord(value)) throw new Error("invalid launch environment payload")
    return value
  }

  async #key(): Promise<Buffer> {
    const key = await this.#keys.getOrCreate()
    if (key.length !== 32) throw new Error("launch environment key must be 256 bits")
    return key
  }
}

interface Handoff<T> {
  readonly digest: string
  readonly expiresAt: number
  readonly payload: T
}

export class EnvironmentHandoffStore<T = Readonly<Record<string, string>>> {
  readonly #now: () => number
  readonly #records = new Map<string, Handoff<T>>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  issue(payload: T, ttlMs = 60_000): string {
    this.#purge()
    const token = randomBytes(32).toString("base64url")
    const digest = hash(token)
    this.#records.set(digest, { digest, expiresAt: this.#now() + ttlMs, payload })
    return token
  }

  consume(token: string): T | null {
    this.#purge()
    const digest = hash(token)
    const record = this.#records.get(digest)
    if (!record) return null
    this.#records.delete(digest)
    return record.payload
  }

  revoke(token: string): boolean {
    return this.#records.delete(hash(token))
  }

  #purge(): void {
    const now = this.#now()
    for (const [key, value] of this.#records) if (value.expiresAt <= now) this.#records.delete(key)
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function decode(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("invalid encrypted launch environment")
  return Buffer.from(value, "base64")
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((member) => typeof member === "string")
}
