import type { RegisteredHost } from "@rubato/remote-protocol"
import { connectTerminal, SessionStream, subscribePush, synchronizePushProfile, unsubscribePush, type PushDependencies, type SessionStreamDependencies, type TerminalDependencies } from "./api"
import { fixtureHost } from "./fixtures"

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  binaryType = ""
  sent: ArrayBuffer[] = []
  send(value: ArrayBuffer) { this.sent.push(value) }
  close() { this.readyState = WebSocket.CLOSED }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")) }
  message(value: Uint8Array) { this.dispatchEvent(new MessageEvent("message", { data: value.buffer })) }
}

class FakeEventSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  sent: string[] = []
  send(value: string) { this.sent.push(value) }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")) }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")) }
}

const frame = (type: number, payload: Uint8Array) => {
  const value = new Uint8Array(5 + payload.length); value[0] = type; new DataView(value.buffer).setUint32(1, payload.length, false); value.set(payload, 5); return value
}

describe("remote transports", () => {
  test("terminal requests a ticket, opens its websocket, and exchanges output/input/resize frames", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const socket = new FakeSocket()
    let socketUrl = ""
    const dependencies: TerminalDependencies = {
      request: (async (url: string, init?: RequestInit) => { requests.push({ url, init }); return { ticket: "12345678901234567890123456789012", expiresAt: "2026-08-31T00:00:00.000Z" } }) as TerminalDependencies["request"],
      createSocket: (url) => { socketUrl = url; return socket as unknown as WebSocket },
    }
    const output = vi.fn()
    const connection = await connectTerminal(fixtureHost, "018f0c7b-2f3b-7c4d-9e5f-1234567890ab", { output, exit: vi.fn(), error: vi.fn() }, dependencies)
    expect(requests[0]).toMatchObject({ url: "/rubato/api/v1/live/018f0c7b-2f3b-7c4d-9e5f-1234567890ab/terminal/ticket", init: { method: "POST" } })
    expect(socketUrl).toContain("/rubato/api/v1/terminal?ticket=12345678901234567890123456789012")
    connection.sendInput("ls\n"); connection.resize(80, 24)
    expect(socket.sent).toHaveLength(0)
    socket.open()
    expect([...new Uint8Array(socket.sent[0])]).toEqual([...frame(0x02, new TextEncoder().encode("ls\n"))])
    expect([...new Uint8Array(socket.sent[1])]).toEqual([...frame(0x03, Uint8Array.of(0, 80, 0, 24))])
    socket.message(frame(0x01, new TextEncoder().encode("ready\r\n")))
    expect(output).toHaveBeenCalledWith("ready\r\n")
  })

  test("reconnects the event stream from the latest installed sequence", async () => {
    const sockets: FakeEventSocket[] = []
    let scheduled: (() => void) | undefined
    let notifyCreated: (() => void) | undefined
    const created = () => new Promise<void>((resolve) => { notifyCreated = resolve })
    let nextCreated = created()
    const dependencies: SessionStreamDependencies = {
      request: (async () => ({ ticket: "event-ticket", expiresAt: "2026-08-31T00:00:00.000Z" })) as SessionStreamDependencies["request"],
      createSocket: () => { const socket = new FakeEventSocket(); sockets.push(socket); notifyCreated?.(); return socket as unknown as WebSocket },
      schedule: (callback) => { scheduled = callback; return 1 },
      clearSchedule: vi.fn(),
    }
    let lastSeq = 20
    const stream = new SessionStream(fixtureHost, "018f0c7b-2f3b-7c4d-9e5f-1234567890ab", () => lastSeq, vi.fn(), vi.fn(), dependencies)
    stream.start()
    await nextCreated
    sockets[0].open()
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "client.resume", sessions: [{ liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab", lastSeq: 20 }] })

    lastSeq = 27
    nextCreated = created()
    sockets[0].close()
    expect(scheduled).toBeTypeOf("function")
    scheduled!()
    await nextCreated
    sockets[1].open()
    expect(JSON.parse(sockets[1].sent[0])).toEqual({ type: "client.resume", sessions: [{ liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab", lastSeq: 27 }] })
    stream.stop()
  })

  test("push creates a PushManager subscription and posts it to every host", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const subscription = { toJSON: () => ({ endpoint: "https://push.example/sub", expirationTime: null, keys: { auth: "auth", p256dh: "key" } }), unsubscribe: vi.fn() } as unknown as PushSubscription
    const subscribe = vi.fn(async () => subscription)
    const dependencies: PushDependencies = {
      ready: async () => ({ pushManager: { getSubscription: async () => null, subscribe } } as unknown as ServiceWorkerRegistration),
      request: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith("/host")) return { hostId: fixtureHost.hostId, displayName: fixtureHost.displayName, ownerLogin: fixtureHost.ownerLogin, protocol: { min: 1, max: 1 }, negotiation: { compatible: true, version: 1 }, capabilities: [], pushPublicKey: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
        return { vapidPublicKey: "public", createdAt: "2026-08-31T00:00:00.000Z" }
      }) as PushDependencies["request"],
    }
    const second = { ...fixtureHost, hostId: "018f0c7a-2f3b-7c4d-8e5f-2234567890ab", baseUrl: "https://second.example.ts.net/rubato/" } as RegisteredHost
    await subscribePush([fixtureHost, second], false, dependencies)
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }))
    expect(calls.filter((call) => call.url.endsWith("push/subscribe"))).toHaveLength(2)
    expect(calls.at(-1)?.init?.body).toContain("https://push.example/sub")
  })

  test("push unsubscribe revokes every host before removing the browser subscription without prompt data", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    let browserUnsubscribed = false
    const subscription = { toJSON: () => ({ endpoint: "https://push.example/private-token", keys: { auth: "auth", p256dh: "key" } }), unsubscribe: async () => { browserUnsubscribed = true; return true } } as unknown as PushSubscription
    const dependencies: PushDependencies = {
      ready: async () => ({ pushManager: { getSubscription: async () => subscription } } as unknown as ServiceWorkerRegistration),
      request: (async (url: string, init?: RequestInit) => { expect(browserUnsubscribed).toBe(false); calls.push({ url, init }); return { revoked: true } }) as PushDependencies["request"],
    }
    const second = { ...fixtureHost, hostId: "018f0c7a-2f3b-7c4d-8e5f-2234567890ab", baseUrl: "https://second.example.ts.net/rubato/" } as RegisteredHost
    await unsubscribePush([fixtureHost, second], true, dependencies)
    expect(browserUnsubscribed).toBe(true)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.url.endsWith("/rubato/api/v1/push/subscription")).toBe(true)
      expect(call.init?.method).toBe("DELETE")
      expect(JSON.parse(String(call.init?.body))).toEqual({ endpoint: "https://push.example/private-token" })
      expect(String(call.init?.body)).not.toMatch(/prompt|message|transcript|session/i)
    }
  })

  test("push profile synchronization relays only the encrypted envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const encrypted = { schemaVersion: 1 as const, ephemeralPublicKey: "ZXBoZW1lcmFs", salt: "c2FsdA==", nonce: "bm9uY2U=", tag: "dGFn", ciphertext: "Y2lwaGVydGV4dA==" }
    const dependencies = { request: (async (url: string, init?: RequestInit) => { calls.push({ url, init }); if (url.endsWith("/host")) return { hostId: fixtureHost.hostId, displayName: fixtureHost.displayName, ownerLogin: fixtureHost.ownerLogin, protocol: { min: 1, max: 1 }, negotiation: { compatible: true, version: 1 }, capabilities: [], pushPublicKey: "ZGVzdGluYXRpb24ta2V5" }; if (url.endsWith("/export")) return encrypted; return { imported: true, pwaOrigin: "https://app.example" } }) as PushDependencies["request"] }
    const destination = { ...fixtureHost, hostId: "018f0c7a-2f3b-7c4d-8e5f-2234567890ab", baseUrl: "https://second.example.ts.net/rubato/" } as RegisteredHost
    await synchronizePushProfile(fixtureHost, destination, dependencies)
    expect(calls[1].init?.body).toBe(JSON.stringify({ destinationPublicKey: "ZGVzdGluYXRpb24ta2V5" }))
    expect(calls[2].init?.body).toBe(JSON.stringify(encrypted))
  })
})
