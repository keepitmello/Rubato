import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { PushEnvelope } from "@rubato/remote-protocol"
import { PushProfileStore, type PushTransport } from "../src/push.js"
import { HOST_ID, SESSION_ID, temporaryDirectory } from "./helpers.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

const subscription = {
  endpoint: "https://push.example/subscription",
  keys: { auth: "auth", p256dh: "p256dh" },
}
const payload: PushEnvelope = {
  type: "session-settled",
  hostId: HOST_ID,
  liveSessionId: SESSION_ID,
  title: "Session",
  body: "Work finished.",
  url: `/rubato/session/${HOST_ID}/${SESSION_ID}`,
}

type PushProfile = Parameters<PushTransport["send"]>[0]

class FakeTransport implements PushTransport {
  readonly sent: Array<{ profile: PushProfile; payload: PushEnvelope }> = []
  failure: unknown = null

  async send(profile: PushProfile, value: PushEnvelope): Promise<void> {
    if (this.failure) throw this.failure
    this.sent.push({ profile, payload: value })
  }
}

describe("Web Push backend", () => {
  test("deduplicates settle cycles, suppresses foreground delivery, and revokes gone subscriptions", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    let now = 1_000
    const transport = new FakeTransport()
    const store = new PushProfileStore(join(temporary.path, "push"), transport, () => now)
    await store.load()
    await store.subscribe(subscription, "https://phone.example.ts.net")

    expect(await store.send(payload, { foreground: true, cycleId: "cycle-1" })).toBe("foreground")
    expect(await store.send(payload, { foreground: false, cycleId: "cycle-1" })).toBe("sent")
    expect(await store.send(payload, { foreground: false, cycleId: "cycle-1" })).toBe("deduped")
    expect(transport.sent).toHaveLength(1)

    now += 30_001
    transport.failure = { statusCode: 410 }
    expect(await store.send(payload, { foreground: false, cycleId: "cycle-2" })).toBe("revoked")
    expect(store.profile()).toBeNull()
  })

  test("unsubscribe revokes only the exact endpoint and paired PWA origin", async () => {
    const temporary = await temporaryDirectory()
    cleanups.push(temporary.cleanup)
    const store = new PushProfileStore(join(temporary.path, "push"), new FakeTransport())
    await store.load()
    await store.subscribe(subscription, "https://phone.example.ts.net")
    expect(await store.revokeSubscription("https://push.example/stale", "https://phone.example.ts.net")).toBeFalse()
    expect(await store.revokeSubscription(subscription.endpoint, "https://other.example.ts.net")).toBeFalse()
    expect(store.profile()).not.toBeNull()
    expect(await store.revokeSubscription(subscription.endpoint, "https://phone.example.ts.net")).toBeTrue()
    expect(store.profile()).toBeNull()
    expect(await store.revokeSubscription(subscription.endpoint, "https://phone.example.ts.net")).toBeFalse()
  })

  test("exports encrypted profile directly between host keys and rotation requires resubscribe", async () => {
    const sourceTemporary = await temporaryDirectory()
    const destinationTemporary = await temporaryDirectory()
    cleanups.push(sourceTemporary.cleanup, destinationTemporary.cleanup)
    const source = new PushProfileStore(join(sourceTemporary.path, "push"), new FakeTransport())
    const destination = new PushProfileStore(join(destinationTemporary.path, "push"), new FakeTransport())
    await Promise.all([source.load(), destination.load()])
    await source.subscribe(subscription, "https://phone.example.ts.net")

    const encrypted = await source.exportEncrypted(await destination.publicHostKey())
    expect(JSON.stringify(encrypted)).not.toContain(source.profile()!.vapidPrivateKey)
    const imported = await destination.importEncrypted(encrypted)
    expect(imported.vapidPrivateKey).toBe(source.profile()!.vapidPrivateKey)

    const rotation = await destination.rotate()
    expect(rotation.requiresResubscribe).toBeTrue()
    expect(destination.profile()).toBeNull()
  })
})
