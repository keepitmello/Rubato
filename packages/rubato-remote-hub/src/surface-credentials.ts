import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { LiveSessionId, SurfaceReconnectCredentialPayload } from "@rubato/remote-protocol"
import { writePrivateFile } from "./files.js"

export class SurfaceReconnectCredentials {
  readonly #path: string
  readonly #now: () => number
  #key: Buffer | null = null

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path
    this.#now = now
  }

  async load(): Promise<void> {
    try {
      const key = await readFile(this.#path)
      if (key.length !== 32) throw new Error("invalid surface credential key")
      this.#key = key
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      const key = randomBytes(32)
      await writePrivateFile(this.#path, key)
      this.#key = key
    }
  }

  issue(liveSessionId: LiveSessionId, surfaceInstanceId: string, ttlMs = 7 * 24 * 60 * 60 * 1000): string {
    const payload: SurfaceReconnectCredentialPayload = {
      schemaVersion: 1,
      liveSessionId,
      surfaceInstanceId,
      expiresAt: this.#now() + ttlMs,
      nonce: randomBytes(16).toString("base64url"),
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
    return `${encoded}.${this.#sign(encoded).toString("base64url")}`
  }

  verify(token: string, liveSessionId: LiveSessionId, surfaceInstanceId: string): boolean {
    const [encoded, signature, extra] = token.split(".")
    if (!encoded || !signature || extra !== undefined) return false
    const actual = Buffer.from(signature, "base64url")
    const expected = this.#sign(encoded)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
    let payload: SurfaceReconnectCredentialPayload
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SurfaceReconnectCredentialPayload
    } catch {
      return false
    }
    return payload.schemaVersion === 1 && payload.liveSessionId === liveSessionId && payload.surfaceInstanceId === surfaceInstanceId && payload.expiresAt > this.#now()
  }

  #sign(value: string): Buffer {
    if (!this.#key) throw new Error("surface credentials are not loaded")
    return createHmac("sha256", this.#key).update(value).digest()
  }
}
