import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getInstalledRemoteSurface } from "./surface.mjs";
import { createUnixConnector } from "./surface.mjs";
import { createRemoteSurfaceExtension, REMOTE_SURFACE_FACTORY_NAME } from "./index.mjs";
import { loadRemoteProtocol } from "./protocol-loader.mjs";
import { defaultLiveHubSocketPath, HOST_ID, LIVE_SESSION_ID, startLocalHub } from "./local-hub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(here, "../..");
const sdkEntry = join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const streamEntry = join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js");

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "remote-test",
    model: "fake-model",
    usage: emptyUsage,
    stopReason: extra.stopReason ?? "stop",
    timestamp: Date.now(),
    ...extra,
  };
}

// Locally these settle in well under a second; the ceiling only has to cover a
// loaded CI runner running this suite alongside others.
function waitUntil(predicate, { timeoutMs = 20_000, label = "condition" } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for " + label));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function recordingConnector(socketPath, protocol) {
  const inner = createUnixConnector(socketPath, protocol);
  const outgoing = [];
  const incoming = [];
  return {
    outgoing,
    incoming,
    connect: (onMessage, onClose) => inner((message) => {
      incoming.push(message);
      onMessage(message);
    }, onClose).then((connection) => ({
      send(value) { outgoing.push(value); connection.send(value); },
      close() { connection.close(); },
    })),
  };
}

function hasEvent(frames, type) {
  return frames.some((frame) => frame?.type === type || (frame?.kind === "surface.event" && frame.type === type));
}

function hubAction(protocol, requestId, action, payload) {
  return {
    protocol: protocol.REMOTE_PROTOCOL_NAME,
    requestId,
    hostId: HOST_ID,
    liveSessionId: LIVE_SESSION_ID,
    action,
    payload,
  };
}

async function createSession({ scratch, protocol, hub, streamFactory }) {
  const cwd = join(scratch, "cwd");
  const agentDir = join(scratch, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "remote-test": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{ id: "fake-model", input: ["text"] }],
      },
    },
  }));
  const token = hub.issueToken(LIVE_SESSION_ID);
  const recorder = recordingConnector(hub.socketPath, protocol);
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(sdkEntry).href);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    extensionFactories: [{
      name: REMOTE_SURFACE_FACTORY_NAME,
      factory: createRemoteSurfaceExtension({
        protocol,
        socketPath: hub.socketPath,
        hostId: HOST_ID,
        liveSessionId: LIVE_SESSION_ID,
        surfaceToken: token,
        connect: recorder.connect,
      }),
    }],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
  const { AssistantMessageEventStream } = await import(pathToFileURL(streamEntry).href);
  session.agent.streamFunction = streamFactory
    ? (model, context, options) => streamFactory(AssistantMessageEventStream, model, context, options)
    : () => {
      const stream = new AssistantMessageEventStream();
      const message = assistant("remote surface turn");
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
  return { session, recorder, token, Stream: AssistantMessageEventStream };
}

test("candidate remote-surface local hub scenarios", { timeout: 90000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-remote-hub-"));
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousSocket = process.env.RUBATO_HUB_SOCKET;
  process.env.HOME = home;
  delete process.env.RUBATO_HUB_SOCKET;

  const hub = await startLocalHub(join(scratch, "hub"));
  process.env.RUBATO_HUB_SOCKET = hub.socketPath;
  assert.notEqual(hub.socketPath, defaultLiveHubSocketPath());

  let session;
  let recorder;
  let Stream;
  let firstStream;
  const firstStarted = new Promise((resolve) => { firstStream = resolve; });
  let continueStream;
  const continued = new Promise((resolve) => { continueStream = resolve; });
  let submitPromise;
  let livePromise;

  t.after(async () => {
    try { getInstalledRemoteSurface({ liveSessionId: LIVE_SESSION_ID })?.stop(); } catch {}
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
      session?.dispose();
    } catch {}
    try { await hub.close(); } catch {}
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSocket === undefined) delete process.env.RUBATO_HUB_SOCKET;
    else process.env.RUBATO_HUB_SOCKET = previousSocket;
    const socketLeft = existsSync(hub.socketPath);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    assert.equal(socketLeft, false, "hub socket must be removed in after()");
    assert.equal(existsSync(hub.socketPath), false);
  });

  const { module: protocol } = await loadRemoteProtocol();

  await t.test("connect", async () => {
    const created = await createSession({
      scratch: join(scratch, "session"),
      protocol,
      hub,
      streamFactory: (Ctor, _model, _context, options) => {
        const open = new Ctor();
        open.push({ type: "start", partial: assistant("pending", { content: [] }) });
        options.signal.addEventListener("abort", () => {
          open.push({ type: "error", reason: "aborted", error: assistant("aborted", { stopReason: "aborted", errorMessage: "aborted" }) });
        }, { once: true });
        firstStream(open);
        return open;
      },
    });
    session = created.session;
    recorder = created.recorder;
    Stream = created.Stream;
    await waitUntil(() => recorder.incoming.some((frame) => frame?.kind === "hub.registered"), {
      timeoutMs: 8000,
      label: "hub.registered",
    });
    const surface = getInstalledRemoteSurface({ liveSessionId: LIVE_SESSION_ID });
    assert.equal(surface?.registered, true);
    assert.equal((statSync(hub.socketPath).mode & 0o777), 0o600);
  });

  await t.test("list shows the candidate session", async () => {
    await waitUntil(async () => (await hub.list()).some((item) => item.liveSessionId === LIVE_SESSION_ID), {
      label: "hub list contains session",
    });
    const sessions = await hub.list();
    assert.equal(sessions.some((item) => item.liveSessionId === LIVE_SESSION_ID), true);
  });

  await t.test("send input", async () => {
    submitPromise = hub.dispatch(hubAction(protocol, "00000000-0000-4000-8000-000000000011", "input.submit", {
      text: "stream from remote",
    }));
    await waitUntil(() => hasEvent(recorder.outgoing, "action.accepted") || hasEvent(recorder.outgoing, "action.rejected"), {
      label: "submit action event",
    });
    assert.equal(hasEvent(recorder.outgoing, "action.accepted"), true, "input.submit should be accepted");
  });

  await t.test("observe streaming", async () => {
    await firstStarted;
    await waitUntil(() => hasEvent(recorder.outgoing, "agent.state"), { label: "agent.state" });
    assert.equal(hasEvent(recorder.outgoing, "agent.state"), true);
    assert.equal(session.isStreaming, true);
  });

  await t.test("abort", async () => {
    const abort = hub.dispatch(hubAction(protocol, "00000000-0000-4000-8000-000000000012", "agent.abort", {}));
    await Promise.all([submitPromise, abort].map((promise) => Promise.resolve(promise).catch((error) => error)));
    await waitUntil(() => recorder.outgoing.some((frame) =>
      frame?.kind === "surface.action-result" && frame.requestId === "00000000-0000-4000-8000-000000000012"
    ), { label: "abort result" });
    const result = recorder.outgoing.find((frame) =>
      frame?.kind === "surface.action-result" && frame.requestId === "00000000-0000-4000-8000-000000000012"
    );
    assert.equal(result.accepted, true);
  });

  await t.test("disconnect the surface while the run continues", async () => {
    session.agent.streamFunction = () => {
      const open = new Stream();
      open.push({ type: "start", partial: assistant("pending", { content: [] }) });
      continueStream(open);
      return open;
    };
    livePromise = hub.dispatch(hubAction(protocol, "00000000-0000-4000-8000-000000000013", "input.submit", {
      text: "keep running after disconnect",
    }));
    const active = await continued;
    const surface = getInstalledRemoteSurface({ liveSessionId: LIVE_SESSION_ID });
    assert.ok(surface);
    surface.connection.close();
    await waitUntil(() => surface.registered === false, { label: "surface disconnected" });
    assert.equal(session.isStreaming, true, "run continues after surface disconnect");
    active.push({ type: "done", reason: "stop", message: assistant("still running") });
    await livePromise.catch((error) => error);
  });

  await t.test("reconnect and receive current state", async () => {
    const surface = getInstalledRemoteSurface({ liveSessionId: LIVE_SESSION_ID });
    assert.ok(surface);
    const seqBefore = Math.max(0, ...recorder.outgoing.filter((frame) => frame?.kind === "surface.snapshot").map((frame) => frame.sourceSeq ?? 0));
    await waitUntil(() => surface.registered === true, { timeoutMs: 15000, label: "surface reconnected" });
    await waitUntil(() => recorder.outgoing.some((frame) => frame?.kind === "surface.snapshot" && (frame.sourceSeq ?? 0) > seqBefore), {
      label: "snapshot after reconnect",
    });
    const snapshot = [...recorder.outgoing].reverse().find((frame) => frame?.kind === "surface.snapshot" && (frame.sourceSeq ?? 0) > seqBefore);
    assert.equal(snapshot.kind, "surface.snapshot");
    const entries = snapshot.state?.entries ?? [];
    assert.ok(Array.isArray(entries));
    const userTexts = entries.filter((entry) => entry.role === "user").map((entry) => entry.text);
    const assistantTexts = entries.filter((entry) => entry.role === "assistant").map((entry) => entry.text);
    assert.equal(userTexts.at(-1), "keep running after disconnect", "snapshot must keep the last input");
    assert.equal(assistantTexts.at(-1), "still running", "snapshot must keep the streamed text that finished after disconnect");
    assert.ok(userTexts.includes("stream from remote"), "snapshot must keep the aborted turn input");
    const aborted = snapshot.state?.timeline?.runs?.some((run) => run.status === "interrupted")
      || assistantTexts.includes("aborted")
      || assistantTexts.filter((text) => text !== "still running").every((text) => text === "aborted" || text === "");
    assert.equal(aborted, true, "snapshot must retain abort state of the first turn");
    assert.equal(snapshot.summary?.execution, "idle");
  });
});
