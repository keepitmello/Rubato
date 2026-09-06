import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { collectSessionMetrics } from "../session-metrics.mjs";
import { InteractiveActionDispatcher, RemoteActionError } from "../interactive-control-surface.mjs";
import {
  conversationEntries,
  paginateConversation,
  presentationFromTimeline,
  sanitizePageEntries,
  sanitizeRemoteMessageEvent,
  timelineChangePayloads,
} from "../remote-conversation-projection.mjs";

const BUFFER_EVENTS = 2_048;
const BUFFER_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 5_000;
const INLINE_TOOL_BYTES = 64 * 1024;
const TOOL_PREVIEW_BYTES = 16 * 1024;
const MAX_TOOL_ARTIFACT_BYTES = 20 * 1024 * 1024;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_STABLE_MS = 30_000;
const V1_REMOTE_MODES = new Set(["direct", "native-action", "terminal-only"]);
const DEGRADABLE_OUTGOING_KINDS = new Set(["surface.snapshot", "surface.summary", "surface.event"]);
const reportedOutgoingSchemaFailures = new Set();
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

/** In-process replacements keep the TUI/zmx pane; only a real process exit may kill it. */
const PROCESS_EXIT_SHUTDOWN_REASONS = new Set(["quit"]);

export function isProcessExitShutdown(reason) {
  return PROCESS_EXIT_SHUTDOWN_REASONS.has(reason);
}

const installedSurfaces = new Map();
const PROCESS_SURFACE_KEY = "process";
const DEFAULT_INSTALLED_PROTOCOL = path.join(os.homedir(), ".local", "lib", "rubato", "remote", "current", "protocol", "index.mjs");
const KNOWN_HUB_FRAME_KINDS = ["hub.launch", "hub.registered", "hub.action"];

function installedSurfaceKey(options = {}) {
  return options.liveSessionId ?? process.env.RUBATO_LIVE_SESSION_ID ?? PROCESS_SURFACE_KEY;
}

export function getInstalledRemoteSurface(options = {}) {
  return installedSurfaces.get(installedSurfaceKey(options));
}

function pathExists(value) {
  try {
    return existsSync(value);
  } catch {
    return false;
  }
}

function findCheckoutRoot(fromDir, exists = pathExists) {
  let dir = fromDir;
  for (let depth = 0; depth < 10; depth += 1) {
    if (exists(path.join(dir, "packages", "rubato-remote-protocol", "src", "index.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function resolveRemoteProtocolSource({
  env = process.env,
  exists = pathExists,
  fromFile = fileURLToPath(import.meta.url),
  installedPath = DEFAULT_INSTALLED_PROTOCOL,
  cwd = process.cwd(),
} = {}) {
  const override = typeof env.RUBATO_REMOTE_PROTOCOL === "string" ? env.RUBATO_REMOTE_PROTOCOL.trim() : "";
  if (override) {
    return { source: "env", path: path.resolve(cwd, override) };
  }
  const checkoutRoot = findCheckoutRoot(path.dirname(fromFile), exists);
  if (checkoutRoot) {
    const protocolRoot = path.join(checkoutRoot, "packages", "rubato-remote-protocol");
    return {
      source: "checkout",
      path: path.join(protocolRoot, "dist", "index.mjs"),
      entry: path.join(protocolRoot, "src", "index.ts"),
      checkoutRoot,
    };
  }
  return { source: "installed", path: installedPath };
}

function protocolSourceMtime(srcDir) {
  let latest = 0;
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".ts")) continue;
    const stamp = statSync(path.join(srcDir, name)).mtimeMs;
    if (stamp > latest) latest = stamp;
  }
  return latest;
}

function ensureCheckoutProtocolModule(resolved) {
  const dist = resolved.path;
  const entry = resolved.entry;
  const srcDir = path.dirname(entry);
  if (pathExists(dist) && statSync(dist).mtimeMs >= protocolSourceMtime(srcDir)) return dist;
  const esbuild = path.join(resolved.checkoutRoot, "packages", "rubato-remote-hub", "node_modules", ".bin", "esbuild");
  if (!pathExists(esbuild)) {
    throw new Error(`in-repo protocol at ${entry} needs esbuild to load under Node`);
  }
  mkdirSync(path.dirname(dist), { recursive: true });
  const result = spawnSync(esbuild, [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    `--outfile=${dist}`,
  ], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`in-repo protocol build failed: ${detail}`);
  }
  return dist;
}

export async function loadRemoteProtocol(options = {}) {
  let resolved = resolveRemoteProtocolSource(options);
  let modulePath = resolved.path;
  if (resolved.source === "checkout") {
    try {
      modulePath = ensureCheckoutProtocolModule(resolved);
    } catch (error) {
      // 체크아웃은 있는데 esbuild 가 없거나 빌드가 깨진 기기. 서피스를 아예 안 여는
      // 것보다 설치 릴리스로 내려가는 쪽이 낫다 — 그 사본이 있으면.
      const installedPath = options.installedPath ?? DEFAULT_INSTALLED_PROTOCOL;
      if (!pathExists(installedPath)) throw error;
      console.error(`[rubato remote] ${error instanceof Error ? error.message : String(error)}; falling back to installed protocol`);
      resolved = { source: "installed", path: installedPath };
      modulePath = installedPath;
    }
  }
  const href = pathToFileURL(modulePath).href;
  const module = options.importModule ? await options.importModule(href) : await import(href);
  return { module, source: resolved.source, path: modulePath };
}

function bindSurfaceEvents(pi, surface) {
  for (const eventName of SUBSCRIBED_EVENTS) {
    pi.on(eventName, (event, ctx) => {
      if (surface.pi !== pi) return;
      surface.observe(eventName, event, ctx);
    });
  }
  pi.events.on("rubato.remote.channel", (data) => {
    if (surface.pi !== pi) return;
    surface.observeChannel(data);
  });
  pi.events.on("interactive.ui.request", (data) => {
    if (surface.pi !== pi) return;
    surface.emit("ui.request", standardUiRequest(data) ?? data);
    surface.emit("agent.state", { execution: "idle", attention: true });
  });
  pi.events.on("interactive.ui.dismiss", (data) => {
    if (surface.pi !== pi) return;
    surface.emit("ui.dismiss", data);
    const native = tryCall(() => pi.getInteractiveControl?.()?.snapshot?.()) ?? {};
    surface.emit("agent.state", {
      execution: native.isStreaming || native.isCompacting ? "working" : "idle",
      attention: false,
    });
  });
}

function stripSummaryPresentation(message) {
  const summary = message?.summary;
  if (!summary || !Object.hasOwn(summary, "presentation")) return undefined;
  const { presentation: _presentation, ...rest } = summary;
  return { ...message, summary: rest };
}

function coerceCommandRemoteMode(command) {
  if (!command || typeof command !== "object" || V1_REMOTE_MODES.has(command.remoteMode)) return command;
  return { ...command, remoteMode: "terminal-only" };
}

function reportOutgoingSchemaFailure(kind, error) {
  const detail = error instanceof Error ? error.message : String(error);
  const signature = `${kind ?? "frame"}:${detail}`;
  if (reportedOutgoingSchemaFailures.has(signature)) return;
  reportedOutgoingSchemaFailures.add(signature);
  console.error(`[rubato remote] installed protocol rejected ${kind ?? "frame"}: ${detail}`);
}

function projectOutgoingFrame(message) {
  if (!message || typeof message !== "object") return { frame: message, changed: false };
  let frame = message;
  let changed = false;
  const stripped = stripSummaryPresentation(frame);
  if (stripped) {
    frame = stripped;
    changed = true;
  }
  if (frame.state && typeof frame.state === "object") {
    const state = { ...frame.state };
    let stateChanged = false;
    if (Object.hasOwn(state, "timeline")) {
      delete state.timeline;
      stateChanged = true;
    }
    if (Array.isArray(state.commands)) {
      let commandsChanged = false;
      const commands = state.commands.map((command) => {
        const coerced = coerceCommandRemoteMode(command);
        if (coerced !== command) commandsChanged = true;
        return coerced;
      });
      if (commandsChanged) {
        state.commands = commands;
        stateChanged = true;
      }
    }
    if (stateChanged) {
      frame = { ...frame, state };
      changed = true;
    }
  }
  return { frame, changed };
}

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
    this.resolveImages = options.resolveImages;
    this.refreshEnvironment = options.refreshEnvironment;
    this.dispatcher = this.createDispatcher(pi);
    this.lastTimeline = undefined;
    this.lastPresentationKey = undefined;
    this.presentationUnsupported = false;
    this.negotiatedProtocolVersion = undefined;
    this.legacyOutgoing = false;
    this.snapshotWireFailed = false;
    this.registeredAt = undefined;
    this.reconnectWaitMs = undefined;
  }

  start() {
    this.stopped = false;
    this.connectNow();
    this.heartbeat = this.clock.setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
  }

  sendHeartbeat() {
    const sent = this.send({
      kind: "surface.heartbeat",
      protocol: this.protocol.REMOTE_PROTOCOL_NAME,
      surfaceInstanceId: this.surfaceInstanceId,
      sourceSeq: this.sourceSeq,
      at: new Date(this.clock.now()).toISOString(),
    });
    if (sent && this.registeredAt !== undefined && (this.clock.now() - this.registeredAt) >= RECONNECT_STABLE_MS) {
      this.reconnectDelay = RECONNECT_MIN_MS;
    }
    return sent;
  }

  state() {
    return {
      registered: this.registered === true,
      legacyOutgoing: this.legacyOutgoing === true,
      reconnectDelay: this.registered ? 0 : (this.reconnectWaitMs ?? this.reconnectDelay),
      negotiatedProtocolVersion: this.negotiatedProtocolVersion,
    };
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    if (this.heartbeat) this.clock.clearInterval(this.heartbeat);
    this.connection?.close();
    this.connection = undefined;
    this.registered = false;
    if (this.installKey && installedSurfaces.get(this.installKey) === this) {
      installedSurfaces.delete(this.installKey);
    }
  }

  createDispatcher(pi) {
    return new InteractiveActionDispatcher(pi, {
      resolveImages: this.resolveImages,
      refreshEnvironment: this.refreshEnvironment,
      getRevision: () => this.revision,
      now: () => this.clock.now(),
    });
  }

  rebind(pi, options = {}) {
    if (options.resolveImages !== undefined) this.resolveImages = options.resolveImages;
    if (options.refreshEnvironment !== undefined) this.refreshEnvironment = options.refreshEnvironment;
    this.pi = pi;
    this.dispatcher = this.createDispatcher(pi);
    bindSurfaceEvents(pi, this);
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
      const registration = this.parseForHub({
        kind: "surface.register",
        protocol: this.protocol.REMOTE_PROTOCOL_NAME,
        protocolRange: {
          min: this.protocol.REMOTE_PROTOCOL_MIN_VERSION,
          max: this.protocol.REMOTE_PROTOCOL_CURRENT_VERSION,
        },
        surfaceInstanceId: this.surfaceInstanceId,
        ...(this.reconnectToken ? { reconnectToken: this.reconnectToken } : { token: this.surfaceToken }),
        // Register is validated before negotiation. Old installed protocols reject
        // summary.presentation, which used to abort connect and leave the session
        // stuck in `starting` until the hub force-killed zmx.
        summary: this.summary({ forWire: true, allowPresentation: false }),
      });
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
    if (this.registered && this.registeredAt !== undefined && (this.clock.now() - this.registeredAt) >= RECONNECT_STABLE_MS) {
      this.reconnectDelay = RECONNECT_MIN_MS;
    }
    const delay = this.reconnectDelay;
    this.reconnectWaitMs = delay;
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, delay * 2);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectNow();
    }, delay);
    const connection = this.connection;
    this.connection = undefined;
    this.registered = false;
    this.registeredAt = undefined;
    connection?.close();
  }

  parseForHub(message) {
    try {
      this.protocol.surfaceToHubFrameSchema?.parse(message);
      return message;
    } catch (error) {
      const degradable = DEGRADABLE_OUTGOING_KINDS.has(message?.kind);
      const { frame, changed } = projectOutgoingFrame(message);
      if (changed) {
        try {
          this.protocol.surfaceToHubFrameSchema?.parse(frame);
          this.legacyOutgoing = true;
          if (stripSummaryPresentation(message)) this.presentationUnsupported = true;
          if (degradable) reportOutgoingSchemaFailure(message?.kind, error);
          return frame;
        } catch (retryError) {
          if (message?.kind === "surface.snapshot") this.snapshotWireFailed = true;
          if (degradable) {
            reportOutgoingSchemaFailure(message?.kind, retryError);
            return undefined;
          }
          throw retryError;
        }
      }
      if (message?.kind === "surface.snapshot") this.snapshotWireFailed = true;
      if (degradable) {
        reportOutgoingSchemaFailure(message?.kind, error);
        return undefined;
      }
      throw error;
    }
  }

  send(message) {
    if (!this.connection || !this.registered) return false;
    try {
      const frame = this.parseForHub(message);
      if (frame === undefined) return false;
      this.connection.send(frame);
      return true;
    } catch {
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
    if (name === "session_shutdown") {
      // /resume, /new, /fork, and settings hot-reload tear down the Pi session
      // inside this same process. Emitting live.exited here made the hub
      // `zmx kill --force` the pane the user was still sitting in. The socket
      // stays up; installRemoteSurface rebinds this instance onto the new pi.
      if (!isProcessExitShutdown(event?.reason)) return;
    }
    if (name === "session_start" || name === "session_switch" || name === "session_fork" || name === "session_info_changed") {
      this.emitSnapshot();
      this.rememberTimeline();
      if (name === "session_info_changed") {
        // Still emit the lightweight changed event so hubs that only watch
        // journals can refresh the picker title without waiting on snapshot IO.
        const type = EVENT_TYPES.get(name);
        if (type) this.emit(type, this.normalizeEvent(name, event));
      }
      this.maybeEmitSummary();
      return;
    }
    if (name === "agent_settled") {
      const type = EVENT_TYPES.get(name);
      if (type) this.emit(type, this.normalizeEvent(name, event));
      this.emitSnapshot();
      this.publishTimelineChanges();
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
    this.publishTimelineChanges();
  }

  observeChannel(data) {
    if (data?.type === "team.snapshot") this.teams = { ...this.teams, ...data.payload?.counts };
    if (data?.type && this.protocol.REMOTE_EVENT_TYPES.includes(data.type)) this.emit(data.type, data.payload ?? {});
  }

  normalizeEvent(name, event) {
    const timeline = this.controlTimeline();
    const requestRunId = timeline?.activeRequestRunId;
    const withRun = (payload) => requestRunId ? { ...payload, requestRunId } : payload;
    if (name === "before_agent_start" || name === "agent_start") return { execution: "working", event };
    if (name === "agent_settled") return { execution: "idle", event };
    if (name === "message_start" || name === "message_update" || name === "message_end") {
      return withRun({ event: jsonSafe(this.protocol, sanitizeRemoteMessageEvent(event)) });
    }
    if (name === "tool_execution_start") return withRun({ event: jsonSafe(this.protocol, event) });
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
        return withRun({ artifact });
      }
      return withRun({ event: normalized });
    }
    return { event };
  }

  shouldPublishPresentation() {
    return !this.presentationUnsupported && (this.negotiatedProtocolVersion ?? 1) >= 2;
  }

  summary(options = {}) {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    const native = tryCall(() => control?.snapshot?.()) ?? {};
    const ctx = this.context;
    const metrics = collectSessionMetrics(ctx, native, this.clock.now());
    const title = tryCall(() => this.pi.getSessionName?.()) ?? ctx?.sessionManager?.getSessionName?.() ?? native.sessionName ?? basename(ctx?.cwd ?? process.cwd());
    const presentation = this.presentation(native);
    const publishPresentation = options.allowPresentation === false
      ? false
      : options.forWire === true
        ? this.shouldPublishPresentation() && presentation
        : Boolean(presentation);
    return {
      schemaVersion: 1,
      hostId: this.hostId,
      liveSessionId: this.liveSessionId,
      ...(this.managedZmxName() ? { zmxName: this.managedZmxName() } : {}),
      managed: this.isManagedLiveSession(),
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
        piVersion: "2026.9.4-3",
        remoteProtocolMin: this.protocol.REMOTE_PROTOCOL_MIN_VERSION,
        remoteProtocolMax: this.protocol.REMOTE_PROTOCOL_CURRENT_VERSION,
      },
      capabilities: control ? ["interactive-control", "standard-ui", "terminal-required"] : ["terminal-required"],
      ...(publishPresentation ? { presentation } : {}),
    };
  }

  isManagedLiveSession() {
    return Boolean(process.env.RUBATO_LIVE_SESSION_ID) && process.env.RUBATO_LIVE_SESSION_ID === this.liveSessionId;
  }

  managedZmxName() {
    if (!this.isManagedLiveSession()) return undefined;
    const compact = String(this.liveSessionId).replaceAll("-", "").slice(0, 12).toLowerCase();
    return compact.length === 12 ? `rubato-${compact}` : undefined;
  }

  controlTimeline() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    const native = tryCall(() => control?.snapshot?.()) ?? {};
    return native.requestTimeline;
  }

  presentation(native = this.controlSnapshot()) {
    const timeline = native?.requestTimeline;
    return presentationFromTimeline(timeline, this.finalPreviewOptions(timeline));
  }

  finalPreviewOptions(timeline) {
    const completed = [...(timeline?.runs ?? [])].reverse().find((run) => run.status === "completed" && run.finalMessageId);
    if (!completed) return {};
    const final = this.conversationSnapshotEntries().find((entry) => entry.id === completed.finalMessageId);
    return {
      ...(typeof final?.text === "string" ? { lastFinalText: final.text } : {}),
      ...(completed.completedAt ? { lastFinalAt: completed.completedAt } : {}),
    };
  }

  conversationSnapshotEntries() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    const page = tryCall(() => control?.readConversationPage?.({ limit: 100 }));
    if (page && typeof page.then !== "function" && Array.isArray(page.entries)) {
      return sanitizePageEntries(page.entries, this.protocol);
    }
    return conversationEntries(this.context?.sessionManager?.getBranch?.() ?? [], this.protocol);
  }

  rememberTimeline() {
    this.lastTimeline = this.controlTimeline();
  }

  publishTimelineChanges() {
    const timeline = this.controlTimeline();
    const previous = this.lastTimeline;
    this.lastTimeline = timeline;
    if (timeline && previous) {
      for (const payload of timelineChangePayloads(previous, timeline)) {
        this.emit("session.changed", payload);
      }
    }
    this.maybeEmitSummary();
  }

  controlSnapshot() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    return tryCall(() => control?.snapshot?.()) ?? {};
  }

  snapshot() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    const native = tryCall(() => control?.snapshot?.()) ?? {};
    const ctx = this.context;
    const entries = this.conversationSnapshotEntries();
    const commands = (control?.listCommands?.() ?? []).map(({ name, description, category, remoteMode }) => {
      const command = { name, description, category, remoteMode };
      return this.legacyOutgoing ? coerceCommandRemoteMode(command) : command;
    });
    const capabilities = control ? ["interactive-control", "standard-ui", "terminal-required"] : ["terminal-required"];
    const timeline = native.requestTimeline;
    return {
      summary: this.summary(),
      state: {
        revision: this.revision,
        entries,
        tree: sessionTree(ctx?.sessionManager?.getTree?.() ?? [], native.leafEntryId),
        commands,
        ...(standardUiRequest(native.uiRequest) ? { uiRequest: standardUiRequest(native.uiRequest) } : {}),
        background: jsonSafe(this.protocol, this.background),
        teams: jsonSafe(this.protocol, this.teams),
        capabilities,
        ...(timeline && !this.legacyOutgoing ? { timeline } : {}),
      },
    };
  }

  emitSnapshot() {
    if (this.snapshotWireFailed) {
      this.buffer.snapshotRequired = true;
      return undefined;
    }
    this.revision += 1;
    const snapshot = this.snapshot();
    const record = {
      kind: "surface.snapshot",
      protocol: this.protocol.REMOTE_PROTOCOL_NAME,
      surfaceInstanceId: this.surfaceInstanceId,
      sourceSeq: ++this.sourceSeq,
      at: new Date(this.clock.now()).toISOString(),
      summary: this.summary({ forWire: true }),
      state: snapshot.state,
    };
    if (!this.send(record)) this.buffer.snapshotRequired = true;
    this.lastPresentationKey = JSON.stringify(snapshot.summary.presentation ?? null);
    return record;
  }

  unknownHubFrameKind(message) {
    const kind = message?.kind;
    if (typeof kind !== "string") return false;
    const known = this.protocol.HUB_TO_SURFACE_FRAME_KINDS;
    if (Array.isArray(known)) return !known.includes(kind);
    return !KNOWN_HUB_FRAME_KINDS.includes(kind);
  }

  async receive(message) {
    let frame;
    try {
      frame = this.protocol.hubToSurfaceFrameSchema.parse(message);
    } catch {
      if (this.unknownHubFrameKind(message)) return;
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
      this.registered = true;
      this.registeredAt = this.clock.now();
      this.snapshotWireFailed = false;
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
      this.rememberTimeline();
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
    if (request.action === "conversation.page" || request.action === "input.queue.clear") {
      await this.respondToInternalAction(request);
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

  async respondToInternalAction(request) {
    this.emit("action.accepted", { requestId: request.requestId, action: request.action }, { advanceRevision: false });
    try {
      const result = jsonSafe(this.protocol, request.action === "conversation.page"
        ? await this.readConversationPage(request.payload)
        : this.clearPendingInputs());
      if (request.action === "input.queue.clear") this.publishTimelineChanges();
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

  async readConversationPage(payload = {}) {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    if (typeof control?.readConversationPage === "function") {
      return control.readConversationPage({
        ...(payload.before === undefined ? {} : { before: payload.before }),
        limit: payload.limit,
      });
    }
    const entries = conversationEntries(this.context?.sessionManager?.getBranch?.() ?? [], this.protocol, { limit: Number.MAX_SAFE_INTEGER });
    const page = paginateConversation(entries, payload);
    if (page.error) throw new RemoteActionError(page.error, page.message);
    const timeline = this.controlTimeline();
    return {
      entries: page.entries,
      requestRuns: timeline?.runs ?? [],
      ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
    };
  }

  clearPendingInputs() {
    const control = tryCall(() => this.pi.getInteractiveControl?.());
    if (typeof control?.clearPendingInputs === "function") return control.clearPendingInputs();
    return { clearedIds: [] };
  }

  maybeEmitSummary() {
    if (!this.shouldPublishPresentation()) return;
    const summary = this.summary({ forWire: true });
    const key = JSON.stringify(summary.presentation ?? null);
    if (key === this.lastPresentationKey) return;
    this.lastPresentationKey = key;
    this.send({
      kind: "surface.summary",
      protocol: this.protocol.REMOTE_PROTOCOL_NAME,
      surfaceInstanceId: this.surfaceInstanceId,
      sourceSeq: ++this.sourceSeq,
      at: new Date(this.clock.now()).toISOString(),
      summary,
    });
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
  const key = installedSurfaceKey(options);
  const existing = installedSurfaces.get(key);
  if (existing && !existing.stopped) {
    existing.rebind(pi, options);
    return existing;
  }
  let protocol = options.protocol;
  if (!protocol) {
    const loaded = await loadRemoteProtocol(options.protocolLoader ?? {});
    console.error(`[rubato remote] protocol source: ${loaded.source} (${loaded.path})`);
    protocol = loaded.module;
  }
  const surface = new RemoteSurface(pi, protocol, options);
  surface.installKey = key;
  bindSurfaceEvents(pi, surface);
  installedSurfaces.set(key, surface);
  surface.start();
  return surface;
}

export default function remoteSurfaceExtension(pi) {
  void installRemoteSurface(pi).catch((error) => {
    pi.events.emit("rubato.remote.error", { message: error instanceof Error ? error.message : String(error) });
  });
}
