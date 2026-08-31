import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { collectSessionMetrics } from "../session-metrics.mjs";
import { InteractiveActionDispatcher, RemoteActionError } from "../interactive-control-surface.mjs";

const BUFFER_EVENTS = 2_048;
const BUFFER_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 5_000;
const INLINE_TOOL_BYTES = 64 * 1024;
const TOOL_PREVIEW_BYTES = 16 * 1024;
const MAX_TOOL_ARTIFACT_BYTES = 20 * 1024 * 1024;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;
const SUBSCRIBED_EVENTS = [
  "session_start", "session_before_switch", "session_switch", "session_before_fork", "session_fork",
  "session_before_compact", "session_compact", "session_shutdown", "session_info_changed", "model_select",
  "thinking_level_change", "input", "before_agent_start", "agent_start", "message_start", "message_update",
  "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_end",
  "agent_settled", "user_bash", "wake_source_state",
];

const EVENT_TYPES = new Map([
  ["session_start", "session.snapshot"], ["session_switch", "session.switched"],
  ["session_fork", "session.switched"], ["session_info_changed", "session.changed"],
  ["session_before_compact", "compaction.start"], ["session_compact", "compaction.end"],
  ["model_select", "model.changed"], ["thinking_level_change", "thinking.changed"],
  ["before_agent_start", "agent.state"], ["agent_start", "agent.state"], ["agent_settled", "agent.state"],
  ["message_start", "message.start"], ["message_update", "message.delta"], ["message_end", "message.commit"],
  ["tool_execution_start", "tool.start"], ["tool_execution_update", "tool.update"], ["tool_execution_end", "tool.end"],
  ["wake_source_state", "background.changed"], ["session_shutdown", "live.exited"],
]);

function uuidv7(now = Date.now()) {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) bytes[index] = Number(timestamp >> BigInt((5 - index) * 8) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function jsonSafe(protocol, value) {
  try {
    return JSON.parse(JSON.stringify(protocol.redactSecrets(value), (_key, member) =>
      typeof member === "bigint" ? member.toString() : member));
  } catch {
    return { normalizationError: true };
  }
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

function conversationEntries(entries, protocol) {
  return entries.slice(-100).flatMap((entry) => {
    if (!entry || typeof entry.id !== "string") return [];
    if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
      return [{ id: entry.id, kind: "message", role: entry.message.role, text: messageText(entry.message.content), at: entry.timestamp }];
    }
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      return [{
        id: entry.id,
        kind: "tool",
        name: String(entry.message.toolName ?? "tool"),
        summary: messageText(entry.message.content),
        status: entry.message.isError ? "failed" : "done",
      }];
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      return [{ id: entry.id, kind: "notice", text: String(entry.summary ?? "Session compacted") }];
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      return [{ id: entry.id, kind: "notice", text: messageText(entry.content) }];
    }
    return [];
  }).map((entry) => jsonSafe(protocol, entry));
}

function standardUiRequest(request) {
  if (!request || !["select", "confirm", "input"].includes(request.kind)) return undefined;
  return {
    requestId: String(request.requestId ?? request.id),
    kind: request.kind,
    title: String(request.title ?? "Request"),
    ...(request.message === undefined ? {} : { message: String(request.message) }),
    ...(Array.isArray(request.options) ? {
      options: request.options.map((option) => typeof option === "string"
        ? { label: option, value: option }
        : { label: String(option.label), value: String(option.value) }),
    } : {}),
    ...(request.placeholder === undefined ? {} : { placeholder: String(request.placeholder) }),
  };
}

function tryCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function sessionTree(roots, leafId) {
  if (!Array.isArray(roots)) return [];
  const result = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    const entry = node?.entry;
    if (entry && typeof entry.id === "string") {
      const text = entry.type === "message" ? messageText(entry.message?.content) : entry.summary;
      result.push({ id: entry.id, label: String(node.label ?? text ?? entry.type ?? ""), current: entry.id === leafId });
    }
    if (Array.isArray(node?.children)) stack.push(...node.children.toReversed());
  }
  return result;
}

export class SurfaceEventBuffer {
  constructor(options = {}) {
    this.maxEvents = options.maxEvents ?? BUFFER_EVENTS;
    this.maxBytes = options.maxBytes ?? BUFFER_BYTES;
    this.events = [];
    this.bytes = 0;
    this.snapshotRequired = false;
  }

  push(event) {
    const bytes = jsonBytes(event);
    if (bytes > this.maxBytes) {
      this.clear();
      this.snapshotRequired = true;
      return false;
    }
    this.events.push({ event, bytes });
    this.bytes += bytes;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      this.bytes -= this.events.shift().bytes;
      this.snapshotRequired = true;
    }
    return true;
  }

  drain() {
    const events = this.events.map((item) => item.event);
    this.clear();
    return events;
  }

  clear() {
    this.events = [];
    this.bytes = 0;
  }
}

export function defaultHubSocketPath(env = process.env) {
  return env.RUBATO_HUB_SOCKET ?? path.join(os.tmpdir(), `rubato-remote-${process.getuid?.() ?? "user"}`, "hub.sock");
}

export function createUnixConnector(socketPath, protocol) {
  return (onMessage, onClose) => new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let pending = Buffer.alloc(0);
    let opened = false;
    socket.once("connect", () => {
      opened = true;
      resolve({
        send(value) { socket.write(Buffer.from(protocol.encodeFrame(value))); },
        close() { socket.destroy(); },
      });
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length > protocol.MAX_FRAME_BYTES) {
          socket.destroy(new Error("Remote frame exceeds MAX_FRAME_BYTES"));
          return;
        }
        if (pending.length < length + 4) return;
        const frame = pending.subarray(0, length + 4);
        pending = pending.subarray(length + 4);
        onMessage(protocol.decodeFrame(frame));
      }
    });
    socket.once("error", (error) => { if (!opened) reject(error); });
    socket.once("close", () => onClose());
  });
}

export class RemoteSurface {
  constructor(pi, protocol, options = {}) {
    this.pi = pi;
    this.protocol = protocol;
    this.hostId = options.hostId ?? process.env.RUBATO_HOST_ID ?? uuidv7();
    this.liveSessionId = options.liveSessionId ?? process.env.RUBATO_LIVE_SESSION_ID ?? uuidv7();
    this.surfaceInstanceId = options.surfaceInstanceId ?? randomUUID();
    this.surfaceToken = options.surfaceToken ?? process.env.RUBATO_SURFACE_TOKEN;
    this.connect = options.connect ?? createUnixConnector(options.socketPath ?? defaultHubSocketPath(), protocol);
    this.clock = options.clock ?? { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval };
    this.buffer = new SurfaceEventBuffer(options.buffer);
    this.connection = undefined;
    this.context = undefined;
    this.sourceSeq = 0;
    this.revision = 0;
    this.createdAt = new Date(this.clock.now()).toISOString();
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.reconnectToken = options.reconnectToken;
    this.registered = false;
    this.stopped = false;
    this.connectionErrorReported = false;
    this.background = { activeCount: 0, labels: [] };
    this.teams = { activeRunCount: 0, runningMemberCount: 0, failedMemberCount: 0 };
    this.dispatcher = new InteractiveActionDispatcher(pi, {
      resolveImages: options.resolveImages,
      refreshEnvironment: options.refreshEnvironment,
      getRevision: () => this.revision,
      now: () => this.clock.now(),
    });
  }

  start() {
    this.stopped = false;
    this.connectNow();
    this.heartbeat = this.clock.setInterval(() => this.send({
      kind: "surface.heartbeat",
      protocol: this.protocol.REMOTE_PROTOCOL_NAME,
      surfaceInstanceId: this.surfaceInstanceId,
      sourceSeq: this.sourceSeq,
      at: new Date(this.clock.now()).toISOString(),
    }), HEARTBEAT_MS);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    if (this.heartbeat) this.clock.clearInterval(this.heartbeat);
    this.connection?.close();
    this.connection = undefined;
    this.registered = false;
  }

  async connectNow() {
    try {
      const connection = await this.connect(
        (message) => void this.receive(message),
        () => this.disconnected(),
      );
      if (this.stopped) return connection.close();
      this.connection = connection;
      this.registered = false;
      const registration = {
        kind: "surface.register",
        protocol: this.protocol.REMOTE_PROTOCOL_NAME,
        protocolRange: {
          min: this.protocol.REMOTE_PROTOCOL_MIN_VERSION,
          max: this.protocol.REMOTE_PROTOCOL_CURRENT_VERSION,
        },
        surfaceInstanceId: this.surfaceInstanceId,
        ...(this.reconnectToken ? { reconnectToken: this.reconnectToken } : { token: this.surfaceToken }),
        summary: this.summary(),
      };
      this.protocol.surfaceToHubFrameSchema?.parse(registration);
      connection.send(registration);
    } catch (error) {
      this.connection?.close();
      if (!this.connectionErrorReported) {
        this.connectionErrorReported = true;
        console.error(`[rubato remote] surface connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.disconnected();
    }
  }

  disconnected() {
    if (this.stopped || this.reconnectTimer) return;
    this.connection = undefined;
    this.registered = false;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, delay * 2);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectNow();
    }, delay);
  }

  send(message) {
    if (!this.connection || !this.registered) return false;
    try {
      this.protocol.surfaceToHubFrameSchema?.parse(message);
      this.connection.send(message);
      return true;
    } catch {
      this.disconnected();
      return false;
    }
  }

  emit(type, payload = {}, options = {}) {
    if (options.advanceRevision !== false) this.revision += 1;
    const record = {
      kind: "surface.event",
      protocol: this.protocol.REMOTE_PROTOCOL_NAME,
      liveSessionId: this.liveSessionId,
      surfaceInstanceId: this.surfaceInstanceId,
      sourceSeq: ++this.sourceSeq,
      at: new Date(this.clock.now()).toISOString(),
      type,
      payload: jsonSafe(this.protocol, payload),
    };
    if (!this.send(record)) this.buffer.push(record);
    return record;
  }

  observe(name, event, ctx) {
    if (ctx) this.context = ctx;
    if (name === "session_start" || name === "session_switch" || name === "session_fork" || name === "session_info_changed") {
      this.emitSnapshot();
      if (name === "session_info_changed") {
        // Still emit the lightweight changed event so hubs that only watch
        // journals can refresh the picker title without waiting on snapshot IO.
        const type = EVENT_TYPES.get(name);
        if (type) this.emit(type, this.normalizeEvent(name, event));
      }
      return;
    }
    if (name === "wake_source_state") {
      this.background = {
        activeCount: Number(event?.activeCount ?? event?.active?.length ?? 0),
        labels: event?.labels ?? event?.active?.map((item) => item.label).filter(Boolean) ?? [],
      };
    }
    const type = EVENT_TYPES.get(name);
    if (type) this.emit(type, this.normalizeEvent(name, event));
  }

  observeChannel(data) {
    if (data?.type === "team.snapshot") this.teams = { ...this.teams, ...data.payload?.counts };
    if (data?.type && this.protocol.REMOTE_EVENT_TYPES.includes(data.type)) this.emit(data.type, data.payload ?? {});
  }

  normalizeEvent(name, event) {
    if (name === "before_agent_start" || name === "agent_start") return { execution: "working", event };
    if (name === "agent_settled") return { execution: "idle", event };
    if (name === "tool_execution_update" || name === "tool_execution_end") {
      const normalized = jsonSafe(this.protocol, event);
      const encoded = Buffer.from(JSON.stringify(normalized));
      if (encoded.length > INLINE_TOOL_BYTES) {
        const artifactId = randomUUID();
        const preview = encoded.subarray(0, TOOL_PREVIEW_BYTES).toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
        const artifact = {
          artifactId,
          byteLength: encoded.length,
          preview,
          available: false,
          truncated: encoded.length > MAX_TOOL_ARTIFACT_BYTES,
        };
        this.emit("artifact.created", artifact);
        return { artifact };
      }
      return { event: normalized };
    }
    return { event };
  }

  summary() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    const native = tryCall(() => control?.snapshot?.()) ?? {};
    const ctx = this.context;
    const metrics = collectSessionMetrics(ctx, native, this.clock.now());
    const title = tryCall(() => this.pi.getSessionName?.()) ?? ctx?.sessionManager?.getSessionName?.() ?? native.sessionName ?? basename(ctx?.cwd ?? process.cwd());
    return {
      schemaVersion: 1,
      hostId: this.hostId,
      liveSessionId: this.liveSessionId,
      ...(process.env.RUBATO_LIVE_SESSION_ID && process.env.ZMX_SESSION ? { zmxName: process.env.ZMX_SESSION } : {}),
      managed: Boolean(process.env.RUBATO_LIVE_SESSION_ID),
      pid: process.pid,
      lifecycle: "ready",
      execution: native.uiRequest ? "idle" : native.isStreaming || native.isCompacting ? "working" : "idle",
      attention: Boolean(native.uiRequest),
      title: title || "rubato",
      cwd: ctx?.cwd ?? process.cwd(),
      createdAt: this.createdAt,
      ...(metrics.lastAssistantAt ? { lastAssistantAt: metrics.lastAssistantAt } : {}),
      pi: {
        ...(ctx?.sessionManager?.getSessionId?.() ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
        ...(native.sessionFile ? { sessionFile: native.sessionFile } : {}),
        ...(native.leafEntryId ? { leafId: native.leafEntryId } : {}),
      },
      model: metrics.model,
      context: metrics.context,
      cache: metrics.cache,
      background: this.background,
      teams: this.teams,
      build: {
        piVersion: "2026.8.22",
        remoteProtocolMin: this.protocol.REMOTE_PROTOCOL_MIN_VERSION,
        remoteProtocolMax: this.protocol.REMOTE_PROTOCOL_CURRENT_VERSION,
      },
      capabilities: control ? ["interactive-control", "standard-ui", "terminal-required"] : ["terminal-required"],
    };
  }

  snapshot() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    const native = tryCall(() => control?.snapshot?.()) ?? {};
    const ctx = this.context;
    const entries = ctx?.sessionManager?.getBranch?.() ?? [];
    const commands = (control?.listCommands?.() ?? []).map(({ name, description, category, remoteMode }) => ({
      name,
      description,
      category,
      remoteMode,
    }));
    const capabilities = control ? ["interactive-control", "standard-ui", "terminal-required"] : ["terminal-required"];
    return {
      summary: this.summary(),
      state: {
        revision: this.revision,
        entries: conversationEntries(entries, this.protocol),
        tree: sessionTree(ctx?.sessionManager?.getTree?.() ?? [], native.leafEntryId),
        commands,
        ...(standardUiRequest(native.uiRequest) ? { uiRequest: standardUiRequest(native.uiRequest) } : {}),
        background: jsonSafe(this.protocol, this.background),
        teams: jsonSafe(this.protocol, this.teams),
        capabilities,
      },
    };
  }

  emitSnapshot() {
    this.revision += 1;
    const snapshot = this.snapshot();
    const record = {
      kind: "surface.snapshot",
      protocol: this.protocol.REMOTE_PROTOCOL_NAME,
      surfaceInstanceId: this.surfaceInstanceId,
      sourceSeq: ++this.sourceSeq,
      at: new Date(this.clock.now()).toISOString(),
      summary: snapshot.summary,
      state: snapshot.state,
    };
    if (!this.send(record)) this.buffer.push(record);
    return record;
  }

  async receive(message) {
    let frame;
    try {
      frame = this.protocol.hubToSurfaceFrameSchema.parse(message);
    } catch {
      this.connection?.close();
      this.disconnected();
      return;
    }
    if (frame.kind === "hub.registered") {
      if (!frame.negotiation.compatible) {
        this.stop();
        return;
      }
      this.negotiatedProtocolVersion = frame.negotiation.version;
      this.reconnectToken = frame.reconnectToken;
      this.surfaceToken = undefined;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.registered = true;
      this.connectionErrorReported = false;
      if (this.buffer.snapshotRequired) {
        this.buffer.clear();
        this.buffer.snapshotRequired = false;
      } else {
        for (const event of this.buffer.drain()) {
          if (!this.send(event)) this.buffer.push(event);
        }
      }
      this.emitSnapshot();
      return;
    }
    if (frame.kind !== "hub.action" || !this.registered) return;
    const request = frame.request;
    if (request.hostId !== this.hostId || request.liveSessionId !== this.liveSessionId) {
      this.send({
        kind: "surface.action-result",
        protocol: this.protocol.REMOTE_PROTOCOL_NAME,
        requestId: request.requestId,
        accepted: false,
        revision: this.revision,
        payload: { error: this.remoteError(new RemoteActionError("invalid_action", "Action identity does not match this surface"), "invalid_action") },
      });
      return;
    }
    this.emit("action.accepted", { requestId: request.requestId, action: request.action }, { advanceRevision: false });
    try {
      const result = jsonSafe(this.protocol, await this.dispatcher.dispatch(request));
      this.emit("action.completed", { requestId: request.requestId, action: request.action, result }, { advanceRevision: false });
      this.send({
        kind: "surface.action-result",
        protocol: this.protocol.REMOTE_PROTOCOL_NAME,
        requestId: request.requestId,
        accepted: true,
        revision: this.revision,
        payload: result,
      });
    } catch (error) {
      const remoteError = this.remoteError(error, error instanceof RemoteActionError ? error.code : "internal_error");
      this.emit("action.rejected", { requestId: request.requestId, action: request.action, error: remoteError }, { advanceRevision: false });
      this.send({
        kind: "surface.action-result",
        protocol: this.protocol.REMOTE_PROTOCOL_NAME,
        requestId: request.requestId,
        accepted: false,
        revision: this.revision,
        payload: { error: remoteError },
      });
    }
  }

  remoteError(error, code) {
    return {
      code,
      message: error instanceof RemoteActionError ? error.message : "Remote action failed",
      traceId: randomUUID(),
    };
  }
}

export async function installRemoteSurface(pi, options = {}) {
  const protocol = options.protocol ?? await import(pathToFileURL(path.join(os.homedir(), ".local", "lib", "rubato", "remote", "current", "protocol", "index.mjs")).href);
  const surface = new RemoteSurface(pi, protocol, options);
  for (const eventName of SUBSCRIBED_EVENTS) {
    pi.on(eventName, (event, ctx) => surface.observe(eventName, event, ctx));
  }
  pi.events.on("rubato.remote.channel", (data) => surface.observeChannel(data));
  pi.events.on("interactive.ui.request", (data) => {
    surface.emit("ui.request", standardUiRequest(data) ?? data);
    surface.emit("agent.state", { execution: "idle", attention: true });
  });
  pi.events.on("interactive.ui.dismiss", (data) => {
    surface.emit("ui.dismiss", data);
    const native = tryCall(() => pi.getInteractiveControl?.()?.snapshot?.()) ?? {};
    surface.emit("agent.state", {
      execution: native.isStreaming || native.isCompacting ? "working" : "idle",
      attention: false,
    });
  });
  surface.start();
  return surface;
}

export default function remoteSurfaceExtension(pi) {
  void installRemoteSurface(pi).catch((error) => {
    pi.events.emit("rubato.remote.error", { message: error instanceof Error ? error.message : String(error) });
  });
}
