import {
  actionResultResponseSchema,
  artifactResponseSchema,
  createLiveSessionResponseSchema,
  decodeEventEnvelope,
  encryptedPushProfileSchema,
  gitDiffResponseSchema,
  gitStatusResponseSchema,
  hostDescriptionResponseSchema,
  hostInventoryResponseSchema,
  imageUploadResponseSchema,
  messagePageResponseSchema,
  pairApproveResponseSchema,
  pairClaimResponseSchema,
  projectListResponseSchema,
  pushProfileImportResponseSchema,
  pushSubscribeResponseSchema,
  registeredHostSchema,
  REMOTE_HTTP_ROUTES,
  REMOTE_PROTOCOL_NAME,
  snapshotResponseSchema,
  ticketResponseSchema,
  type EventEnvelope,
  type GitDiffResponse,
  type GitStatusResponse,
  type CreateLiveSessionResponse,
  type PushSubscribeRequest,
  type RegisteredHost,
  type RemoteActionPayloadMap,
  type RemoteActionType,
} from "@rubato/remote-protocol"
import { fixtureEntries, fixtureHost, fixtureInventory, fixtureProjects, fixtureSnapshot } from "./fixtures"
import type { HostInventory, ImageAttachment, ProjectChoice, SessionSnapshot } from "./types"

export const fixtureMode = typeof location !== "undefined" && (location.hostname === "127.0.0.1" || location.hostname === "localhost" || new URLSearchParams(location.search).has("fixture"))

function route(template: string, values: Readonly<Record<string, string>> = {}): string {
  return Object.entries(values).reduce((value, [name, replacement]) => value.replace(`:${name}`, encodeURIComponent(replacement)), template)
}

function endpoint(host: RegisteredHost, path: string): string {
  return new URL(path, host.baseUrl).toString()
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `요청을 마치지 못했어요 (${response.status}).`)
  }
  return response.json() as Promise<T>
}

export async function fetchInventory(hosts: readonly RegisteredHost[]): Promise<readonly HostInventory[]> {
  if (fixtureMode) return fixtureInventory
  if (hosts.length === 0) return []
  return Promise.all(hosts.map(async (host): Promise<HostInventory> => {
    try {
      const body = hostInventoryResponseSchema.parse(await request<unknown>(endpoint(host, REMOTE_HTTP_ROUTES.inventory)))
      return { host: { ...host, lastSeenAt: new Date().toISOString() }, sessions: body.sessions, connection: "online" }
    } catch (cause) {
      return { host, sessions: [], connection: navigator.onLine ? "offline" : "connecting", problem: cause instanceof Error ? cause.message : "호스트에 연결하지 못했어요." }
    }
  }))
}

export async function fetchSnapshot(host: RegisteredHost, liveSessionId: string): Promise<SessionSnapshot> {
  if (fixtureMode) {
    const requested = new URLSearchParams(location.search).get("commands")
    if (requested === null) return fixtureSnapshot
    const names = new Set(requested.split(",").filter(Boolean))
    return { ...fixtureSnapshot, commands: fixtureSnapshot.commands.filter((command) => names.has(command.name)) }
  }
  const body = snapshotResponseSchema.parse(await request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.snapshot, { liveSessionId }))))
  return {
    summary: body.summary,
    revision: body.revision,
    lastSeq: body.lastSeq,
    entries: body.entries,
    tree: body.tree,
    commands: body.commands,
    ...(body.uiRequest ? { uiRequest: body.uiRequest } : {}),
  }
}

export async function fetchArtifactText(host: RegisteredHost, liveSessionId: string, artifactId: string): Promise<string> {
  if (fixtureMode) return "큰 도구 결과의 나머지 내용입니다."
  const body = artifactResponseSchema.parse(await request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.artifact, { liveSessionId, artifactId }))))
  if (body.encoding === "utf8") return body.content
  return new TextDecoder().decode(Uint8Array.from(atob(body.content), (character) => character.charCodeAt(0)))
}

export interface GitView {
  files: GitStatusResponse["files"]
  diff: GitDiffResponse["diff"]
  summary: string
}

export async function fetchGitView(host: RegisteredHost, liveSessionId: string): Promise<GitView> {
  if (fixtureMode) return {
    files: [{ path: "src/check-in/RoomButton.tsx", status: "수정됨" }, { path: "test/check-in.accessibility.test.tsx", status: "수정됨" }],
    diff: { oldFile: { fileName: "src/check-in/RoomButton.tsx", fileLang: "tsx", content: "" }, newFile: { fileName: "src/check-in/RoomButton.tsx", fileLang: "tsx", content: "" }, hunks: ["@@ -18,7 +18,8 @@ export function RoomButton({ room }) {\n-  return <button onClick={choose}>{room.number}</button>\n+  return <button aria-label={`${room.name} 객실 선택`} onClick={choose}>\n+    {room.number}\n+  </button>"] },
    summary: "1개 파일 · 3줄 추가 · 1줄 삭제",
  }
  const [status, diff] = await Promise.all([
    request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.gitStatus, { liveSessionId }))).then((value) => gitStatusResponseSchema.parse(value)),
    request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.gitDiff, { liveSessionId }))).then((value) => gitDiffResponseSchema.parse(value)),
  ])
  return { files: status.files, diff: diff.diff, summary: diff.summary || `${status.files.length}개 파일 변경` }
}

export async function fetchOlderMessages(host: RegisteredHost, liveSessionId: string, before?: string): Promise<readonly SessionSnapshot["entries"][number][]> {
  if (fixtureMode) return fixtureEntries.slice(0, 2)
  const query = before ? `?before=${encodeURIComponent(before)}&limit=100` : "?limit=100"
  const body = messagePageResponseSchema.parse(await request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.messages, { liveSessionId }) + query)))
  return body.entries
}

export async function listProjects(host: RegisteredHost): Promise<readonly ProjectChoice[]> {
  if (fixtureMode) return fixtureProjects
  const [recent, favorites] = await Promise.all([
    request<unknown>(endpoint(host, REMOTE_HTTP_ROUTES.projectsRecent)).then((value) => projectListResponseSchema.parse(value)),
    request<unknown>(endpoint(host, REMOTE_HTTP_ROUTES.projectsFavorites)).then((value) => projectListResponseSchema.parse(value)),
  ])
  return [...favorites.projects, ...recent.projects]
}

export async function createSession(host: RegisteredHost, options: { cwd: string; model?: string; thinkingLevel?: string }): Promise<CreateLiveSessionResponse> {
  if (fixtureMode) return { liveSessionId: fixtureSnapshot.summary.liveSessionId, zmxName: fixtureSnapshot.summary.zmxName! }
  const model = options.model ? { provider: options.model === "claude" ? "anthropic" : "openai", modelId: options.model } : undefined
  const body = { cwd: options.cwd, attachAfterCreate: false, ...(model ? { model } : {}), ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}) }
  return createLiveSessionResponseSchema.parse(await request<unknown>(endpoint(host, REMOTE_HTTP_ROUTES.createLiveSession), { method: "POST", body: JSON.stringify(body) }))
}

export async function sendAction<Action extends RemoteActionType>(host: RegisteredHost, liveSessionId: string, action: Action, payload: RemoteActionPayloadMap[Action], expectedRevision?: number): Promise<void> {
  if (fixtureMode) return
  actionResultResponseSchema.parse(await request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.actions, { liveSessionId })), {
    method: "POST",
    body: JSON.stringify({ protocol: REMOTE_PROTOCOL_NAME, requestId: crypto.randomUUID(), hostId: host.hostId, liveSessionId, action, payload, expectedRevision }),
  }))
}

export async function pairHost(payload: { baseUrl: string; nonce: string }): Promise<RegisteredHost> {
  const url = new URL(payload.baseUrl)
  if (url.protocol !== "https:") throw new Error("HTTPS 호스트 주소만 연결할 수 있어요.")
  if (fixtureMode) return registeredHostSchema.parse({ ...fixtureHost, baseUrl: url.toString(), pairedAt: new Date().toISOString() })
  const claim = pairClaimResponseSchema.parse(await request<unknown>(new URL(REMOTE_HTTP_ROUTES.pairClaim, url).toString(), { method: "POST", body: JSON.stringify({ nonce: payload.nonce }) }))
  pairApproveResponseSchema.parse(await request<unknown>(new URL(REMOTE_HTTP_ROUTES.pairApprove, url).toString(), { method: "POST", body: JSON.stringify({ claimId: claim.claimId, confirmed: true }) }))
  const description = hostDescriptionResponseSchema.parse(await request<unknown>(new URL(REMOTE_HTTP_ROUTES.host, url).toString()))
  return registeredHostSchema.parse({ hostId: description.hostId, displayName: description.displayName, baseUrl: url.toString(), ownerLogin: description.ownerLogin, pairedAt: new Date().toISOString(), protocolMin: description.protocol.min, protocolMax: description.protocol.max })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return btoa(binary)
}

async function normalizedImage(file: File): Promise<{ blob: Blob; mimeType: string }> {
  if (file.size > 20 * 1024 * 1024) throw new Error("이미지는 20 MiB보다 작아야 해요.")
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.type !== "image/heic" && file.type !== "image/heif") { bitmap.close(); return { blob: file, mimeType: file.type } }
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("이미지를 변환하지 못했어요.")), "image/jpeg", 0.88))
    return { blob, mimeType: "image/jpeg" }
  } catch {
    if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) return { blob: file, mimeType: file.type }
    throw new Error("이 이미지 형식을 읽지 못했어요.")
  }
}

export async function uploadImage(host: RegisteredHost, liveSessionId: string, file: File): Promise<ImageAttachment> {
  const normalized = await normalizedImage(file)
  if (fixtureMode) return { imageId: crypto.randomUUID(), name: file.name, previewUrl: URL.createObjectURL(normalized.blob) }
  const response = imageUploadResponseSchema.parse(await request<unknown>(endpoint(host, route(REMOTE_HTTP_ROUTES.images, { liveSessionId })), {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, mimeType: normalized.mimeType, dataBase64: bytesToBase64(new Uint8Array(await normalized.blob.arrayBuffer())) }),
  }))
  return { imageId: response.imageId, name: file.name, previewUrl: URL.createObjectURL(normalized.blob) }
}

type PushSubscriptionWire = PushSubscribeRequest["subscription"]

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4)
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function pushWire(subscription: PushSubscription): PushSubscriptionWire {
  const value = subscription.toJSON()
  if (!value.endpoint || !value.keys?.auth || !value.keys.p256dh) throw new Error("브라우저가 완전한 알림 구독을 만들지 못했어요.")
  return { endpoint: value.endpoint, ...(value.expirationTime !== undefined ? { expirationTime: value.expirationTime } : {}), keys: { auth: value.keys.auth, p256dh: value.keys.p256dh } }
}

export interface PushDependencies {
  ready: () => Promise<ServiceWorkerRegistration>
  request: typeof request
}

const pushDependencies: PushDependencies = { ready: () => navigator.serviceWorker.ready, request }

export async function subscribePush(hosts: readonly RegisteredHost[], refresh = false, dependencies: PushDependencies = pushDependencies): Promise<void> {
  if (hosts.length === 0) throw new Error("알림을 받을 Mac을 먼저 연결하세요.")
  const source = hosts[0]
  const description = hostDescriptionResponseSchema.parse(await dependencies.request<unknown>(endpoint(source, REMOTE_HTTP_ROUTES.host)))
  const registration = await dependencies.ready()
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && refresh) { await subscription.unsubscribe(); subscription = null }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(description.pushPublicKey) })
  const body = JSON.stringify({ subscription: pushWire(subscription) })
  await Promise.all(hosts.map(async (host) => pushSubscribeResponseSchema.parse(await dependencies.request<unknown>(endpoint(host, REMOTE_HTTP_ROUTES.pushSubscribe), { method: "POST", body }))))
}

export async function unsubscribePush(hosts: readonly RegisteredHost[], unsubscribeBrowser: boolean, dependencies: PushDependencies = pushDependencies): Promise<void> {
  const registration = await dependencies.ready()
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return
  const endpointValue = subscription.toJSON().endpoint
  if (!endpointValue || !endpointValue.startsWith("https://")) throw new Error("브라우저 알림 구독 주소가 올바르지 않아요.")
  const body = JSON.stringify({ endpoint: endpointValue })
  await Promise.all(hosts.map((host) => dependencies.request<unknown>(endpoint(host, "/rubato/api/v1/push/subscription"), { method: "DELETE", body })))
  if (unsubscribeBrowser && !await subscription.unsubscribe()) throw new Error("브라우저 알림 구독을 해제하지 못했어요.")
}

export async function synchronizePushProfile(source: RegisteredHost, destination: RegisteredHost, dependencies: Pick<PushDependencies, "request"> = pushDependencies): Promise<void> {
  const destinationDescription = hostDescriptionResponseSchema.parse(await dependencies.request<unknown>(endpoint(destination, REMOTE_HTTP_ROUTES.host)))
  const encrypted = encryptedPushProfileSchema.parse(await dependencies.request<unknown>(endpoint(source, REMOTE_HTTP_ROUTES.pushProfileExport), { method: "POST", body: JSON.stringify({ destinationPublicKey: destinationDescription.pushPublicKey }) }))
  pushProfileImportResponseSchema.parse(await dependencies.request<unknown>(endpoint(destination, REMOTE_HTTP_ROUTES.pushProfileImport), { method: "POST", body: JSON.stringify(encrypted) }))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
function terminalFrame(type: number, payload: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(5 + payload.byteLength)
  frame[0] = type
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false)
  frame.set(payload, 5)
  return frame.buffer
}

export interface TerminalConnection {
  sendInput(value: string): void
  resize(cols: number, rows: number): void
  close(): void
}
export interface TerminalHandlers { output(value: string): void; exit(): void; error(message: string): void }
export interface TerminalDependencies {
  request: typeof request
  createSocket(url: string): WebSocket
}
const terminalDependencies: TerminalDependencies = { request, createSocket: (url) => new WebSocket(url) }

export async function connectTerminal(host: RegisteredHost, liveSessionId: string, handlers: TerminalHandlers, dependencies: TerminalDependencies = terminalDependencies): Promise<TerminalConnection> {
  const ticketPath = route(REMOTE_HTTP_ROUTES.terminalTicket, { liveSessionId })
  let ticket = "fixture-terminal-ticket"
  try {
    const response = ticketResponseSchema.parse(await dependencies.request<unknown>(fixtureMode ? ticketPath : endpoint(host, ticketPath), { method: "POST", body: JSON.stringify({ purpose: "terminal" }) }))
    ticket = response.ticket
  } catch (cause) {
    if (!fixtureMode) throw cause
  }
  if (fixtureMode && dependencies === terminalDependencies) {
    handlers.output("Rubato emergency terminal\r\nConnected to the current live process.\r\n")
    return { sendInput: (value) => handlers.output(value), resize: () => undefined, close: handlers.exit }
  }
  const url = new URL((fixtureMode ? `${location.origin}${REMOTE_HTTP_ROUTES.terminalWebSocket}` : endpoint(host, REMOTE_HTTP_ROUTES.terminalWebSocket)) + `?ticket=${encodeURIComponent(ticket)}`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const socket = dependencies.createSocket(url.toString())
  const queued: ArrayBuffer[] = []
  const send = (frame: ArrayBuffer) => socket.readyState === WebSocket.OPEN ? socket.send(frame) : queued.push(frame)
  socket.binaryType = "arraybuffer"
  socket.addEventListener("open", () => { for (const frame of queued.splice(0)) socket.send(frame) })
  socket.addEventListener("message", (event) => {
    const frame = new Uint8Array(event.data as ArrayBuffer)
    if (frame.byteLength < 5) return
    const length = new DataView(frame.buffer, frame.byteOffset).getUint32(1, false)
    const payload = frame.subarray(5, 5 + length)
    if (frame[0] === 0x01) handlers.output(decoder.decode(payload))
    else if (frame[0] === 0x04) handlers.exit()
    else if (frame[0] === 0x05) handlers.error(decoder.decode(payload))
  })
  return {
    sendInput: (value) => send(terminalFrame(0x02, encoder.encode(value))),
    resize: (cols, rows) => { const payload = new Uint8Array(4); const view = new DataView(payload.buffer); view.setUint16(0, cols, false); view.setUint16(2, rows, false); send(terminalFrame(0x03, payload)) },
    close: () => socket.close(),
  }
}

export interface SessionStreamDependencies {
  request: typeof request
  createSocket: (url: string) => WebSocket
  schedule: (callback: () => void, delay: number) => number
  clearSchedule: (id: number) => void
}

const streamDependencies: SessionStreamDependencies = {
  request,
  createSocket: (url) => new WebSocket(url),
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  clearSchedule: (id) => clearTimeout(id),
}

export class SessionStream {
  private socket?: WebSocket
  private stopped = false
  private attempt = 0
  private reconnectTimer?: number

  constructor(
    private readonly host: RegisteredHost,
    private readonly sessionId: string,
    private readonly lastSeq: () => number,
    private readonly onEvent: (event: EventEnvelope) => void,
    private readonly onState: (state: "connecting" | "online" | "offline") => void,
    private readonly dependencies: SessionStreamDependencies = streamDependencies,
  ) {}

  start(): void {
    this.stopped = false
    document.addEventListener("visibilitychange", this.onVisibility)
    window.addEventListener("online", this.onOnline)
    window.addEventListener("offline", this.onOffline)
    if (fixtureMode && this.dependencies === streamDependencies) { this.onState(navigator.onLine ? "online" : "offline"); return }
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.socket?.close()
    if (this.reconnectTimer) this.dependencies.clearSchedule(this.reconnectTimer)
    document.removeEventListener("visibilitychange", this.onVisibility)
    window.removeEventListener("online", this.onOnline)
    window.removeEventListener("offline", this.onOffline)
  }

  private connect = async (): Promise<void> => {
    if (this.stopped || !navigator.onLine) { this.onState("offline"); return }
    this.onState("connecting")
    try {
      const { ticket } = ticketResponseSchema.parse(await this.dependencies.request<unknown>(endpoint(this.host, REMOTE_HTTP_ROUTES.webSocketTicket), { method: "POST", body: JSON.stringify({ purpose: "events" }) }))
      const wsUrl = new URL(endpoint(this.host, REMOTE_HTTP_ROUTES.webSocket) + `?ticket=${encodeURIComponent(ticket)}`); wsUrl.protocol = "wss:"
      const socket = this.dependencies.createSocket(wsUrl.toString())
      this.socket = socket
      socket.addEventListener("open", () => {
        this.attempt = 0
        this.onState("online")
        socket.send(JSON.stringify({ type: "client.resume", sessions: [{ liveSessionId: this.sessionId, lastSeq: this.lastSeq() }] }))
      })
      socket.addEventListener("message", ({ data }) => {
        try { this.onEvent(decodeEventEnvelope(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer))) } catch { /* Invalid frames never enter UI state. */ }
      })
      socket.addEventListener("close", () => this.scheduleReconnect())
      socket.addEventListener("error", () => socket.close())
    } catch { this.scheduleReconnect() }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.onState(navigator.onLine ? "connecting" : "offline")
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++)
    this.reconnectTimer = this.dependencies.schedule(() => void this.connect(), delay)
  }

  private onVisibility = (): void => { if (document.visibilityState === "visible" && this.socket?.readyState !== WebSocket.OPEN) { if (this.reconnectTimer) this.dependencies.clearSchedule(this.reconnectTimer); void this.connect() } }
  private onOnline = (): void => { if (this.reconnectTimer) this.dependencies.clearSchedule(this.reconnectTimer); void this.connect() }
  private onOffline = (): void => { this.onState("offline"); this.socket?.close() }
}
