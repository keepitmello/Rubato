/**
 * Direct providers declare a probe origin or a trustworthy server-duration
 * source. A missing route still scores on client duration so custom
 * registrations (b-ai, models.json) can paint Speed N. Loopback stays
 * unsupported. A declared degraded probe still excludes the call.
 *
 * Origins are the actual non-loopback request hosts pinned factories use.
 * Kiro is a loopback sidecar; v1 does not probe it and does not score it.
 * No v1 route declares `server_duration`. Adding one is a new trust boundary
 * and requires provider-wire evidence plus an end-to-end test.
 */
export const SPEED_INDEX_NETWORK_ROUTES = Object.freeze({
  "openai-codex": Object.freeze({ kind: "probe", origin: "https://chatgpt.com/backend-api" }),
  xai: Object.freeze({ kind: "probe", origin: "https://api.x.ai/v1" }),
  anthropic: Object.freeze({ kind: "probe", origin: "https://api.anthropic.com" }),
  cursor: Object.freeze({ kind: "probe", origin: "https://api2.cursor.sh" }),
  kiro: Object.freeze({ kind: "unsupported", reason: "loopback_sidecar" }),
  "google-antigravity": Object.freeze({
    kind: "probe",
    origin: "https://daily-cloudcode-pa.googleapis.com",
  }),
  opencode: Object.freeze({ kind: "probe", origin: "https://opencode.ai/zen/v1" }),
  "b-ai": Object.freeze({ kind: "probe", origin: "https://api.b.ai/v1" }),
});

export function networkRouteFor(providerId) {
  return SPEED_INDEX_NETWORK_ROUTES[providerId];
}
