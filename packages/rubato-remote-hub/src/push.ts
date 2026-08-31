import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import webpush from "web-push"
import type { EncryptedPushProfile, PushEnvelope, PushRotateResponse, PushSubscription } from "@rubato/remote-protocol"
import { ensurePrivateDirectory, readJson, removeIfPresent, writePrivateFile } from "./files.js"

interface PushProfile {
  readonly schemaVersion: 1
  readonly vapidPublicKey: string
  readonly vapidPrivateKey: string
  readonly subscription: PushSubscription
  readonly pwaOrigin: string
  readonly createdAt: string
}

export interface PushTransport {
  send(profile: PushProfile, payload: PushEnvelope): Promise<void>
}

export class WebPushTransport implements PushTransport {
  readonly #subject: string

  constructor(subject: string) {
    this.#subject = subject
  }

  async send(profile: PushProfile, payload: PushEnvelope): Promise<void> {
    webpush.setVapidDetails(this.#subject, profile.vapidPublicKey, profile.vapidPrivateKey)
    const subscription: webpush.PushSubscription = profile.subscription.expirationTime === undefined
      ? { endpoint: profile.subscription.endpoint, keys: profile.subscription.keys }
      : { endpoint: profile.subscription.endpoint, expirationTime: profile.subscription.expirationTime, keys: profile.subscription.keys }
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 300, urgency: "normal" })
  }
}

interface HostKeyMaterial {
  readonly privateKey: string
  readonly publicKey: string
}

export class PushProfileStore {
  readonly #root: string
  readonly #transport: PushTransport
  readonly #now: () => number
  readonly #dedupe = new Map<string, number>()
  #profile: PushProfile | null = null
  #keys: HostKeyMaterial | null = null
  #vapid: { publicKey: string; privateKey: string } | null = null

  constructor(root: string, transport: PushTransport, now: () => number = Date.now) {
    this.#root = root
    this.#transport = transport
    this.#now = now
  }

  async load(): Promise<void> {
    await ensurePrivateDirectory(this.#root)
    this.#profile = await readJson<PushProfile | null>(this.#profilePath(), null)
    this.#keys = await this.#loadOrCreateHostKeys()
    this.#vapid = this.#profile ? { publicKey: this.#profile.vapidPublicKey, privateKey: this.#profile.vapidPrivateKey } : await this.#loadOrCreateVapidKeys()
  }

  async subscribe(subscription: PushSubscription, pwaOrigin: string): Promise<PushProfile> {
    if (!isHttpsOrigin(pwaOrigin)) throw new Error("push origin must be HTTPS")
    validateSubscription(subscription)
    const keys = await this.#vapidKeys()
    const profile: PushProfile = {
      schemaVersion: 1,
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: keys.privateKey,
      subscription,
      pwaOrigin,
      createdAt: new Date(this.#now()).toISOString(),
    }
    await this.#saveProfile(profile)
    return profile
  }

  async importEncrypted(payload: EncryptedPushProfile): Promise<PushProfile> {
    const keys = await this.#hostKeys()
    const privateKey = createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), format: "der", type: "pkcs8" })
    const ephemeralPublic = createPublicKey({ key: Buffer.from(payload.ephemeralPublicKey, "base64"), format: "der", type: "spki" })
    const key = deriveKey(diffieHellman({ privateKey, publicKey: ephemeralPublic }), payload.salt)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.nonce, "base64"))
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()])
    const profile = JSON.parse(plaintext.toString("utf8")) as PushProfile
    validateProfile(profile)
    await this.#saveProfile(profile)
    return profile
  }

  async exportEncrypted(destinationPublicKey: string): Promise<EncryptedPushProfile> {
    if (!this.#profile) throw new Error("push profile not configured")
    const destination = createPublicKey({ key: Buffer.from(destinationPublicKey, "base64"), format: "der", type: "spki" })
    const ephemeral = generateKeyPairSync("x25519")
    const salt = randomBytes(32)
    const key = deriveKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: destination }), salt.toString("base64"))
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.#profile)), cipher.final()])
    return {
      schemaVersion: 1,
      ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }
  }

  async publicHostKey(): Promise<string> {
    return (await this.#hostKeys()).publicKey
  }

  async send(payload: PushEnvelope, options: { foreground: boolean; cycleId: string }): Promise<"sent" | "deduped" | "foreground" | "unconfigured" | "revoked"> {
    if (options.foreground) return "foreground"
    if (!this.#profile) return "unconfigured"
    const cycleKey = `${payload.liveSessionId}:${payload.type}:${options.cycleId}`
    const recentKey = `${payload.liveSessionId}:${payload.type}:recent`
    this.#purgeDedupe()
    if (this.#dedupe.has(cycleKey) || this.#dedupe.has(recentKey)) return "deduped"
    this.#dedupe.set(cycleKey, this.#now())
    this.#dedupe.set(recentKey, this.#now())
    try {
      await this.#transport.send(this.#profile, payload)
      return "sent"
    } catch (error) {
      const statusCode = statusOf(error)
      if (statusCode === 404 || statusCode === 410) {
        await this.revoke()
        return "revoked"
      }
      this.#dedupe.delete(cycleKey)
      this.#dedupe.delete(recentKey)
      throw error
    }
  }

  async revoke(): Promise<void> {
    this.#profile = null
    await removeIfPresent(this.#profilePath())
    this.#dedupe.clear()
  }

  async revokeSubscription(endpoint: string, pwaOrigin: string): Promise<boolean> {
    if (!this.#profile || this.#profile.subscription.endpoint !== endpoint || this.#profile.pwaOrigin !== pwaOrigin) return false
    await this.revoke()
    return true
  }

  async rotate(): Promise<PushRotateResponse> {
    const keys = webpush.generateVAPIDKeys()
    await writePrivateFile(join(this.#root, "vapid.json"), JSON.stringify(keys))
    this.#vapid = keys
    await this.revoke()
    return { requiresResubscribe: true, vapidPublicKey: keys.publicKey }
  }

  async vapidPublicKey(): Promise<string> {
    return (await this.#vapidKeys()).publicKey
  }

  profile(): PushProfile | null {
    return this.#profile
  }

  async #saveProfile(profile: PushProfile): Promise<void> {
    await Promise.all([
      writePrivateFile(this.#profilePath(), JSON.stringify(profile)),
      writePrivateFile(join(this.#root, "vapid.json"), JSON.stringify({ publicKey: profile.vapidPublicKey, privateKey: profile.vapidPrivateKey })),
    ])
    this.#profile = profile
    this.#vapid = { publicKey: profile.vapidPublicKey, privateKey: profile.vapidPrivateKey }
  }

  async #hostKeys(): Promise<HostKeyMaterial> {
    this.#keys ??= await this.#loadOrCreateHostKeys()
    return this.#keys
  }

  async #vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
    this.#vapid ??= await this.#loadOrCreateVapidKeys()
    return this.#vapid
  }

  async #loadOrCreateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
    const path = join(this.#root, "vapid.json")
    const stored = await readJson<{ publicKey: string; privateKey: string } | null>(path, null)
    if (stored?.publicKey && stored.privateKey) return stored
    const keys = webpush.generateVAPIDKeys()
    await writePrivateFile(path, JSON.stringify(keys))
    return keys
  }

  async #loadOrCreateHostKeys(): Promise<HostKeyMaterial> {
    const path = join(this.#root, "host-x25519.json")
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as HostKeyMaterial
      if (parsed.privateKey && parsed.publicKey) return parsed
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    const pair = generateKeyPairSync("x25519")
    const material = {
      privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    }
    await writePrivateFile(path, JSON.stringify(material))
    return material
  }

  #profilePath(): string {
    return join(this.#root, "profile.json")
  }

  #purgeDedupe(): void {
    const now = this.#now()
    for (const [key, sentAt] of this.#dedupe) {
      const ttl = key.endsWith(":recent") ? 30_000 : 10 * 60_000
      if (sentAt <= now - ttl) this.#dedupe.delete(key)
    }
  }
}

function deriveKey(secret: Buffer, saltBase64: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(saltBase64, "base64"), Buffer.from("rubato-push-profile-v1"), 32))
}

function validateProfile(value: PushProfile): void {
  if (value.schemaVersion !== 1 || !value.vapidPrivateKey || !value.vapidPublicKey || !isHttpsOrigin(value.pwaOrigin)) {
    throw new Error("invalid push profile")
  }
  validateSubscription(value.subscription)
}

function validateSubscription(value: PushSubscription): void {
  if (!value || typeof value.endpoint !== "string" || !value.endpoint.startsWith("https://") || !value.keys || typeof value.keys.auth !== "string" || typeof value.keys.p256dh !== "string") {
    throw new Error("invalid push subscription")
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value
  } catch {
    return false
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined
  const value = error.statusCode
  return typeof value === "number" ? value : undefined
}
