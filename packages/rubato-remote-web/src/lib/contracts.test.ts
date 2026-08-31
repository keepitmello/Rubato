import canonicalSession from "../../../rubato-remote-protocol/test/fixtures/live-session-summary.v1.json"
import { liveSessionSummarySchema } from "@rubato/remote-protocol"
import { parseHost } from "./registry"
import { parseRoute } from "./router"

const host = { hostId: canonicalSession.hostId, displayName: "Mac mini", baseUrl: "https://mac.example.ts.net/rubato/", ownerLogin: "you@example.com", pairedAt: "2026-08-31T00:00:00.000Z" }

describe("frontend boundaries", () => {
  test("uses the canonical session summary fixture", () => {
    expect(liveSessionSummarySchema.parse(canonicalSession).title).toBe("Hotel Tablet")
  })

  test("accepts only HTTPS host addresses", () => {
    expect(parseHost(host)).toEqual(host)
    expect(() => parseHost({ ...host, baseUrl: "http://192.168.0.4/rubato/" })).toThrow("HTTPS")
  })

  test("parses deep links under the installed app scope", () => {
    expect(parseRoute(`/rubato/session/${canonicalSession.hostId}/${canonicalSession.liveSessionId}`)).toEqual({ name: "session", hostId: canonicalSession.hostId, liveSessionId: canonicalSession.liveSessionId })
    expect(parseRoute("/rubato/new")).toEqual({ name: "new" })
    expect(parseRoute("/rubato/", "?pair=one-time-payload")).toEqual({ name: "settings" })
  })
})
