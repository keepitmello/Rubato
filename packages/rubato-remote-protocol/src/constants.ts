export const REMOTE_PROTOCOL_NAME = "rubato.remote.v1" as const
export const REMOTE_PROTOCOL_CURRENT_VERSION = 2 as const
export const REMOTE_PROTOCOL_MIN_VERSION = 1 as const
export const FINAL_RESPONSE_PREVIEW_MAX_CHARS = 240
export const PENDING_INPUT_PREVIEW_MAX_CHARS = 500
export const TIMELINE_ID_MAX_CHARS = 256
export const LIVE_SESSION_SCHEMA_VERSION = 1 as const
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const REMOTE_HTTP_API_PREFIX = "/rubato/api/v1" as const

export const SURFACE_TO_HUB_FRAME_KINDS = [
  "bootstrap.claim",
  "surface.register",
  "surface.heartbeat",
  "surface.event",
  "surface.snapshot",
  "surface.summary",
  "surface.action-result",
] as const

export const HUB_TO_SURFACE_FRAME_KINDS = ["hub.launch", "hub.registered", "hub.action"] as const

export const REMOTE_HTTP_ROUTES = Object.freeze({
  health: "/rubato/api/v1/health",
  host: "/rubato/api/v1/host",
  inventory: "/rubato/api/v1/inventory",
  pairClaim: "/rubato/api/v1/pair/claim",
  pairApprove: "/rubato/api/v1/pair/approve",
  webSocketTicket: "/rubato/api/v1/auth/ticket",
  webSocket: "/rubato/api/v1/ws",
  createLiveSession: "/rubato/api/v1/live",
  liveSession: "/rubato/api/v1/live/:liveSessionId",
  snapshot: "/rubato/api/v1/live/:liveSessionId/snapshot",
  actions: "/rubato/api/v1/live/:liveSessionId/actions",
  messages: "/rubato/api/v1/live/:liveSessionId/messages",
  images: "/rubato/api/v1/live/:liveSessionId/images",
  file: "/rubato/api/v1/live/:liveSessionId/files/read",
  gitStatus: "/rubato/api/v1/live/:liveSessionId/git/status",
  gitDiff: "/rubato/api/v1/live/:liveSessionId/git/diff",
  artifact: "/rubato/api/v1/live/:liveSessionId/artifacts/:artifactId",
  projectsRecent: "/rubato/api/v1/projects/recent",
  projectsFavorites: "/rubato/api/v1/projects/favorites",
  projectsBrowse: "/rubato/api/v1/projects/browse",
  pushSubscribe: "/rubato/api/v1/push/subscribe",
  pushProfileExport: "/rubato/api/v1/push/profile/export",
  pushProfileImport: "/rubato/api/v1/push/profile/import",
  pushRotate: "/rubato/api/v1/push/rotate",
  terminalTicket: "/rubato/api/v1/live/:liveSessionId/terminal/ticket",
  terminalWebSocket: "/rubato/api/v1/terminal",
})

export const IDENTIFIER_CONTRACTS = Object.freeze({
  hostId: "installation-lifetime UUIDv7",
  liveSessionId: "process-lifetime UUIDv7",
  zmxName: "process-lifetime rubato-<first 12 compact liveSessionId characters>",
  piSessionId: "Pi-session-lifetime opaque identifier",
  sessionFile: "Pi-session-lifetime transcript path",
  leafId: "conversation-leaf opaque identifier",
  surfaceInstanceId: "surface-instance-lifetime UUID",
  clientId: "PWA-instance-lifetime UUID",
  requestId: "action-lifetime UUID",
  hostSeq: "host-inventory non-negative integer sequence",
  sessionSeq: "live-session positive integer sequence",
})

export const LIVE_LIFECYCLES = ["starting", "ready", "degraded", "stopping", "exited"] as const
export const LEAD_EXECUTIONS = ["working", "idle"] as const

export const REMOTE_ACTION_TYPES = [
  "input.submit",
  "input.steer",
  "input.followUp",
  "input.queue.clear",
  "conversation.page",
  "agent.abort",
  "session.compact",
  "session.navigate",
  "session.fork",
  "session.new",
  "session.reload",
  "session.rename",
  "model.set",
  "thinking.set",
  "bash.execute",
  "bash.abort",
  "ui.respond",
  "environment.refresh",
] as const

export const REMOTE_EVENT_TYPES = [
  "host.snapshot",
  "inventory.changed",
  "session.snapshot",
  "session.changed",
  "session.switched",
  "message.start",
  "message.delta",
  "message.commit",
  "tool.start",
  "tool.update",
  "tool.end",
  "agent.state",
  "compaction.start",
  "compaction.end",
  "model.changed",
  "thinking.changed",
  "context.changed",
  "cache.changed",
  "background.changed",
  "team.snapshot",
  "team.activity",
  "ui.request",
  "ui.dismiss",
  "artifact.created",
  "action.accepted",
  "action.completed",
  "action.rejected",
  "live.exited",
  "snapshot.required",
] as const

export const REMOTE_ERROR_CODES = [
  "unauthorized",
  "origin_not_paired",
  "protocol_mismatch",
  "host_not_found",
  "session_not_found",
  "session_starting",
  "session_stopping",
  "stale_revision",
  "busy",
  "terminal_required",
  "invalid_action",
  "payload_too_large",
  "path_not_allowed",
  "environment_not_configured",
  "zmx_unavailable",
  "internal_error",
] as const
