import test from "node:test";
import assert from "node:assert/strict";
import { isProcessExitShutdown, RemoteSurface, SurfaceEventBuffer } from "../../src/extensions/remote-surface.mjs";

const protocol = {
  REMOTE_PROTOCOL_NAME: "rubato.remote.v1",
  REMOTE_PROTOCOL_CURRENT_VERSION: 1,
  REMOTE_PROTOCOL_MIN_VERSION: 1,
  REMOTE_EVENT_TYPES: ["team.snapshot"],
  redactSecrets: (value) => value,
  surfaceToHubFrameSchema: { parse: (value) => value },
  hubToSurfaceFrameSchema: { parse: (value) => value },
};

const registered = {
  kind: "hub.registered",
  protocol: "rubato.remote.v1",
  hostSeq: 1,
  reconnectToken: "reconnect-token",
  protocolRange: { min: 1, max: 1 },
  negotiation: { compatible: true, version: 1 },
};

function context() {
  return {
    cwd: "/tmp/project",
    sessionManager: {
      getBranch: () => [],
      getSessionName: () => "Session",
      getSessionId: () => "pi-session",
      getTree: () => ({ root: "leaf" }),
    },
  };
}

test("surface buffer is bounded by event count and bytes", () => {
  const countBound = new SurfaceEventBuffer({ maxEvents: 2, maxBytes: 10_000 });
  countBound.push({ n: 1 });
  countBound.push({ n: 2 });
  countBound.push({ n: 3 });
  assert.equal(countBound.snapshotRequired, true);
  assert.deepEqual(countBound.drain(), [{ n: 2 }, { n: 3 }]);

  const byteBound = new SurfaceEventBuffer({ maxEvents: 10, maxBytes: 10 });
  assert.equal(byteBound.push({ payload: "too large" }), false);
  assert.equal(byteBound.snapshotRequired, true);
  assert.deepEqual(byteBound.drain(), []);
});

test("overflow reconnect emits one authoritative snapshot instead of stale deltas", async () => {
  const sent = [];
  const surface = new RemoteSurface(
    { getInteractiveControl: () => undefined, getSessionName: () => "Session" },
    protocol,
    {
      hostId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b4",
      liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
      surfaceInstanceId: "123e4567-e89b-42d3-a456-426614174000",
      surfaceToken: "surface-token",
      buffer: { maxEvents: 2, maxBytes: 100_000 },
      connect: async () => ({ send: (value) => sent.push(value), close() {} }),
      clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
    },
  );
  surface.context = context();
  surface.emit("message.delta", { n: 1 });
  surface.emit("message.delta", { n: 2 });
  surface.emit("message.delta", { n: 3 });
  assert.equal(surface.buffer.snapshotRequired, true);

  await surface.connectNow();
  assert.equal(sent[0].kind, "surface.register");
  await surface.receive(registered);
  const snapshots = sent.filter((value) => value.kind === "surface.snapshot");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].state.entries.length, 0);
});

test("large tool updates become bounded redacted artifact previews", () => {
  const surface = new RemoteSurface({}, protocol, {
    buffer: { maxEvents: 5, maxBytes: 100_000 },
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  surface.observe("tool_execution_end", { output: `\u001b[31m${"x".repeat(70_000)}\u001b[0m` });
  const records = surface.buffer.drain();
  assert.equal(records[0].type, "artifact.created");
  assert.equal(records[0].payload.available, false);
  assert.equal(records[0].payload.preview.includes("\u001b[31m"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(records[0])) < 64 * 1024);
  assert.equal(records[1].type, "tool.end");
  assert.equal(records[1].payload.artifact.artifactId, records[0].payload.artifactId);
});

test("intact reconnect replays buffered events in source order", async () => {
  const sent = [];
  const surface = new RemoteSurface({}, protocol, {
    surfaceToken: "surface-token",
    buffer: { maxEvents: 5, maxBytes: 100_000 },
    connect: async () => ({ send: (value) => sent.push(value), close() {} }),
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  surface.emit("message.delta", { n: 1 });
  surface.emit("message.commit", { n: 2 });
  await surface.connectNow();
  await surface.receive(registered);
  assert.deepEqual(
    sent.filter((value) => value.kind === "surface.event").map((value) => value.sourceSeq),
    [1, 2],
  );
});

test("registration always publishes an authoritative initial snapshot", async () => {
  const sent = [];
  const surface = new RemoteSurface(
    { getInteractiveControl: () => undefined, getSessionName: () => "Session" },
    protocol,
    {
      surfaceToken: "surface-token",
      connect: async () => ({ send: (value) => sent.push(value), close() {} }),
      clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
    },
  );
  surface.context = context();
  await surface.connectNow();
  await surface.receive(registered);
  assert.equal(sent.filter((value) => value.kind === "surface.snapshot").length, 1);
});

test("registration honors negotiation and reconnect credentials", async () => {
  const sent = [];
  let closed = false;
  const surface = new RemoteSurface({}, protocol, {
    surfaceToken: "surface-token",
    connect: async () => ({ send: (value) => sent.push(value), close: () => { closed = true; } }),
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  await surface.connectNow();
  await surface.receive(registered);
  assert.equal(surface.negotiatedProtocolVersion, 1);
  assert.equal(surface.reconnectToken, "reconnect-token");
  assert.equal(surface.registered, true);

  await surface.receive({ ...registered, negotiation: { compatible: false, reason: "protocol_mismatch" } });
  assert.equal(surface.stopped, true);
  assert.equal(surface.registered, false);
  assert.equal(closed, true);
});

test("failed registration closes its socket before reconnecting", async () => {
  let closed = false;
  const invalidProtocol = {
    ...protocol,
    surfaceToHubFrameSchema: { parse: () => { throw new Error("invalid registration"); } },
  };
  const surface = new RemoteSurface({}, invalidProtocol, {
    surfaceToken: "surface-token",
    connect: async () => ({ send() {}, close: () => { closed = true; } }),
    clock: { now: () => 1_000, setTimeout: () => 1, clearTimeout, setInterval, clearInterval },
  });
  await surface.connectNow();
  assert.equal(closed, true);
  assert.equal(surface.connection, undefined);
});

test("repeated pre-registration failures back off instead of resetting", async () => {
  const delays = [];
  let onClose = () => {};
  const surface = new RemoteSurface({}, protocol, {
    surfaceToken: "surface-token",
    connect: async (_onMessage, close) => {
      onClose = close;
      return { send() {}, close() {} };
    },
    clock: {
      now: () => 1_000,
      setTimeout: (fn, delay) => {
        delays.push(delay);
        return delay;
      },
      clearTimeout,
      setInterval,
      clearInterval,
    },
  });
  await surface.connectNow();
  onClose();
  assert.deepEqual(delays, [250]);
  surface.reconnectTimer = undefined;
  await surface.connectNow();
  onClose();
  assert.deepEqual(delays, [250, 500]);
  surface.reconnectTimer = undefined;
  await surface.connectNow();
  onClose();
  assert.deepEqual(delays, [250, 500, 1_000]);
  surface.reconnectTimer = undefined;
  await surface.connectNow();
  await surface.receive(registered);
  onClose();
  assert.deepEqual(delays, [250, 500, 1_000, 250]);
});

test("registration survives Pi methods that throw during extension loading", async () => {
  const sent = [];
  let closed = false;
  const surface = new RemoteSurface({
    getSessionName: () => { throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."); },
    getInteractiveControl: () => { throw new TypeError("Cannot assign to read only property 'setSessionName' of object '#<Object>'"); },
  }, protocol, {
    surfaceToken: "surface-token",
    connect: async () => ({ send: (value) => sent.push(value), close: () => { closed = true; } }),
    clock: { now: () => 1_000, setTimeout: () => 1, clearTimeout, setInterval, clearInterval },
  });
  surface.context = { cwd: "/tmp/project" };
  await surface.connectNow();
  assert.equal(closed, false);
  assert.equal(sent[0]?.kind, "surface.register");
  assert.equal(sent[0]?.summary.title, "project");
  assert.deepEqual(sent[0]?.summary.capabilities, ["terminal-required"]);
  assert.equal(surface.emitSnapshot().kind, "surface.snapshot");
});

test("snapshot command inventory is exactly the attached Pi surface inventory", () => {
  const commands = [
    { name: "skill:review", description: "Review", category: "skill", remoteMode: "direct", privatePath: "/secret" },
    { name: "compact", description: "Compact", category: "builtin", remoteMode: "native-action" },
    { name: "login", description: "Login", category: "builtin", remoteMode: "terminal-only" },
  ];
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({ snapshot: () => ({}), listCommands: () => commands }),
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });

  assert.deepEqual(surface.snapshot().state.commands, commands.map(({ privatePath: _privatePath, ...command }) => command));
});

test("session_info_changed publishes a snapshot with the new session title", async () => {
  const sent = [];
  const surface = new RemoteSurface(
    { getInteractiveControl: () => undefined, getSessionName: () => "Protocol work" },
    protocol,
    {
      hostId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b4",
      liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
      surfaceInstanceId: "123e4567-e89b-42d3-a456-426614174000",
      surfaceToken: "surface-token",
      connect: async () => ({ send: (value) => sent.push(value), close() {} }),
      clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
    },
  );
  surface.context = context();
  await surface.connectNow();
  await surface.receive(registered);
  sent.length = 0;
  surface.observe("session_info_changed", { name: "Protocol work" }, context());
  assert.equal(sent.some((value) => value.kind === "surface.snapshot" && value.summary.title === "Protocol work"), true);
  assert.equal(sent.some((value) => value.kind === "surface.event" && value.type === "session.changed"), true);
});


const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174099";

function actionFrame(action, payload) {
  return {
    kind: "hub.action",
    protocol: "rubato.remote.v1",
    request: {
      protocol: "rubato.remote.v1",
      requestId: REQUEST_ID,
      hostId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b4",
      liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
      action,
      payload,
    },
  };
}

function branchWithThinking() {
  return [
    { id: "u1", type: "message", timestamp: "2026-08-31T01:00:00.000Z", message: { role: "user", content: "hello" } },
    { id: "t1", type: "message", timestamp: "2026-08-31T01:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "visible" }] } },
    { id: "think-entry", type: "thinking", thinking: "hidden raw" },
  ];
}

test("snapshot conversation never includes thinking text", () => {
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({ snapshot: () => ({}), listCommands: () => [] }),
    getSessionName: () => "Session",
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });
  surface.context = {
    cwd: "/tmp/project",
    sessionManager: {
      getBranch: branchWithThinking,
      getSessionName: () => "Session",
      getSessionId: () => "pi-session",
      getTree: () => [],
    },
  };
  const entries = surface.snapshot().state.entries;
  assert.equal(entries.some((entry) => entry.kind === "thinking" || String(entry.text ?? "").includes("secret") || String(entry.text ?? "").includes("hidden")), false);
  assert.deepEqual(entries.map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.text })), [
    { id: "u1", kind: "message", text: "hello" },
    { id: "t1", kind: "message", text: "visible" },
  ]);
});

test("snapshot carries engine requestTimeline when present", () => {
  const timeline = {
    schemaVersion: 1,
    runs: [{
      id: "run-1",
      status: "running",
      rootUserMessageId: "u1",
      startedAt: "2026-08-31T01:00:00.000Z",
      progressMessageCount: 1,
      toolCount: 0,
      failedToolCount: 0,
      steeringCount: 0,
    }],
    activeRequestRunId: "run-1",
    pendingInputs: [],
    hasOlder: false,
  };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({
      snapshot: () => ({ requestTimeline: timeline, sessionName: "Session" }),
      listCommands: () => [],
    }),
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });
  surface.context = context();
  const snapshot = surface.snapshot();
  assert.deepEqual(snapshot.state.timeline, timeline);
  assert.equal(snapshot.summary.presentation.activeRequest.id, "run-1");
});

test("conversation.page and input.queue.clear use control when present", async () => {
  const sent = [];
  const page = { entries: [{ id: "u1", kind: "message", role: "user", text: "hello", requestRunId: "run-1", inputId: "run-1", delivery: "submit" }], requestRuns: [], nextBefore: "older" };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({
      snapshot: () => ({}),
      readConversationPage: async (input) => {
        if (input.before !== undefined) {
          assert.equal(input.limit, 20);
          assert.equal(input.before, "cursor");
        }
        return page;
      },
      clearPendingInputs: () => ({ clearedIds: ["queued-1"] }),
    }),
  }, protocol, {
    hostId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b4",
    liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
    surfaceToken: "surface-token",
    connect: async () => ({ send: (value) => sent.push(value), close() {} }),
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  await surface.connectNow();
  await surface.receive(registered);
  sent.length = 0;
  await surface.receive(actionFrame("conversation.page", { before: "cursor", limit: 20 }));
  const pageResult = sent.find((value) => value.kind === "surface.action-result");
  assert.equal(pageResult.accepted, true);
  assert.deepEqual(pageResult.payload, page);
  sent.length = 0;
  await surface.receive(actionFrame("input.queue.clear", {}));
  const clearResult = sent.find((value) => value.kind === "surface.action-result");
  assert.deepEqual(clearResult.payload, { clearedIds: ["queued-1"] });
});

test("conversation.page fallback pages branch entries and rejects unknown cursors", async () => {
  const sent = [];
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({ snapshot: () => ({}) }),
  }, protocol, {
    hostId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b4",
    liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
    surfaceToken: "surface-token",
    connect: async () => ({ send: (value) => sent.push(value), close() {} }),
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  surface.context = {
    cwd: "/tmp/project",
    sessionManager: {
      getBranch: () => [
        { id: "u1", type: "message", message: { role: "user", content: "one" } },
        { id: "u2", type: "message", message: { role: "user", content: "two" } },
        { id: "u3", type: "message", message: { role: "user", content: "three" } },
      ],
      getTree: () => [],
    },
  };
  await surface.connectNow();
  await surface.receive(registered);
  sent.length = 0;
  await surface.receive(actionFrame("conversation.page", { limit: 2 }));
  const latest = sent.find((value) => value.kind === "surface.action-result");
  assert.deepEqual(latest.payload.entries.map((entry) => entry.id), ["u2", "u3"]);
  sent.length = 0;
  await surface.receive(actionFrame("conversation.page", { before: "missing", limit: 2 }));
  const invalid = sent.find((value) => value.kind === "surface.action-result");
  assert.equal(invalid.accepted, false);
  assert.equal(invalid.payload.error.code, "invalid_action");
});



test("presentation is derived from requestTimeline, never control.presentation", () => {
  const timeline = {
    schemaVersion: 1,
    runs: [{
      id: "run-1",
      status: "completed",
      rootUserMessageId: "u1",
      startedAt: "2026-08-31T01:00:00.000Z",
      completedAt: "2026-08-31T01:00:05.000Z",
      finalMessageId: "a1",
      progressMessageCount: 0,
      toolCount: 0,
      failedToolCount: 0,
      steeringCount: 0,
    }],
    pendingInputs: [{
      id: "q1",
      delivery: "followUp",
      textPreview: "later",
      textLength: 5,
      imageCount: 0,
      enqueuedAt: "2026-08-31T01:00:06.000Z",
      source: "remote",
    }],
    hasOlder: false,
  };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({
      snapshot: () => ({
        requestTimeline: timeline,
        presentation: { schemaVersion: 1, lastFinalResponsePreview: "stale control presentation", pendingFollowUpCount: 9, pendingSteerCount: 9 },
      }),
      listCommands: () => [],
      readConversationPage: () => ({
        entries: [{ id: "a1", kind: "message", role: "assistant", text: "Accessibility checks passed.", phase: "final", requestRunId: "run-1" }],
        requestRuns: timeline.runs,
      }),
    }),
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });
  const snapshot = surface.snapshot();
  assert.equal(snapshot.summary.presentation.lastFinalResponsePreview, "Accessibility checks passed.");
  assert.equal(snapshot.summary.presentation.lastFinalResponseAt, "2026-08-31T01:00:05.000Z");
  assert.equal(snapshot.summary.presentation.pendingFollowUpCount, 1);
  assert.equal(snapshot.summary.presentation.pendingSteerCount, 0);
  assert.equal(snapshot.summary.presentation.activeRequest, undefined);
  assert.equal(snapshot.state.entries[0].requestRunId, "run-1");
});

test("session.changed carries requestRun and pendingInputs after re-reading requestTimeline", () => {
  const running = {
    id: "run-1",
    status: "running",
    rootUserMessageId: "u1",
    startedAt: "2026-08-31T01:00:00.000Z",
    progressMessageCount: 0,
    toolCount: 0,
    failedToolCount: 0,
    steeringCount: 0,
  };
  const completed = { ...running, status: "completed", completedAt: "2026-08-31T01:00:05.000Z", finalMessageId: "a1" };
  let timeline = {
    schemaVersion: 1,
    runs: [running],
    activeRequestRunId: "run-1",
    pendingInputs: [],
    hasOlder: false,
  };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({ snapshot: () => ({ requestTimeline: timeline }), listCommands: () => [] }),
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });
  surface.rememberTimeline();
  timeline = {
    schemaVersion: 1,
    runs: [completed],
    pendingInputs: [{
      id: "q1",
      delivery: "steer",
      textPreview: "nudge",
      textLength: 5,
      imageCount: 0,
      enqueuedAt: "2026-08-31T01:00:06.000Z",
      source: "tui",
      targetRequestRunId: "run-1",
    }],
    hasOlder: false,
  };
  surface.observe("agent_settled", { settled: true });
  const changed = surface.buffer.drain().filter((record) => record.type === "session.changed").map((record) => record.payload);
  assert.equal(changed.some((payload) => payload.change === "requestRun" && payload.requestRun.status === "completed"), true);
  assert.equal(changed.some((payload) => payload.change === "pendingInputs" && payload.pendingInputs[0].id === "q1"), true);
  assert.equal(changed.every((payload) => payload.change === "requestRun" || payload.change === "pendingInputs" || payload.event), true);
});

test("agent_settled snapshot reads the already-completed control timeline", () => {
  const running = {
    id: "run-1",
    status: "running",
    rootUserMessageId: "u1",
    startedAt: "2026-08-31T01:00:00.000Z",
    progressMessageCount: 1,
    toolCount: 0,
    failedToolCount: 0,
    steeringCount: 0,
    lastProgressPreview: "working",
  };
  const completed = {
    ...running,
    status: "completed",
    completedAt: "2026-08-31T01:00:05.000Z",
    finalMessageId: "a1",
  };
  delete completed.lastProgressPreview;
  let settled = false;
  const page = {
    entries: [{ id: "a1", kind: "message", role: "assistant", text: "Done.", phase: "final", requestRunId: "run-1" }],
    requestRuns: [completed],
  };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({
      snapshot: () => settled
        ? { requestTimeline: { schemaVersion: 1, runs: [completed], pendingInputs: [], hasOlder: false } }
        : { requestTimeline: { schemaVersion: 1, runs: [running], activeRequestRunId: "run-1", pendingInputs: [], hasOlder: false } },
      listCommands: () => [],
      readConversationPage: () => page,
    }),
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });
  surface.rememberTimeline();
  settled = true;
  surface.observe("agent_settled", { settled: true });
  const snapshot = surface.buffer.drain().find((record) => record.kind === "surface.snapshot");
  assert.equal(snapshot.state.timeline.activeRequestRunId, undefined);
  assert.equal(snapshot.state.timeline.runs[0].status, "completed");
  assert.equal(Object.hasOwn(snapshot.summary, "presentation"), false);
  assert.equal(surface.snapshot().summary.presentation.lastFinalResponsePreview, "Done.");
  assert.equal(surface.snapshot().summary.presentation.lastFinalResponseAt, "2026-08-31T01:00:05.000Z");
  assert.equal(surface.snapshot().summary.presentation.activeRequest, undefined);
  assert.equal(snapshot.state.entries[0].text, "Done.");
});

test("v2 surfaces emit surface.summary on presentation change; v1 does not", async () => {
  const running = {
    id: "run-1",
    status: "running",
    rootUserMessageId: "u1",
    startedAt: "2026-08-31T01:00:00.000Z",
    progressMessageCount: 0,
    toolCount: 0,
    failedToolCount: 0,
    steeringCount: 0,
  };
  let timeline = {
    schemaVersion: 1,
    runs: [running],
    activeRequestRunId: "run-1",
    pendingInputs: [],
    hasOlder: false,
  };
  async function connectWith(version) {
    const sent = [];
    const proto = { ...protocol, REMOTE_PROTOCOL_CURRENT_VERSION: 2, REMOTE_PROTOCOL_MIN_VERSION: 1 };
    const surface = new RemoteSurface({
      getInteractiveControl: () => ({ snapshot: () => ({ requestTimeline: timeline }), listCommands: () => [] }),
    }, proto, {
      hostId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b4",
      liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
      surfaceToken: "surface-token",
      connect: async () => ({ send: (value) => sent.push(value), close() {} }),
      clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
    });
    await surface.connectNow();
    await surface.receive({
      ...registered,
      protocolRange: { min: 1, max: 2 },
      negotiation: { compatible: true, version },
    });
    sent.length = 0;
    timeline = {
      ...timeline,
      pendingInputs: [{
        id: "q1",
        delivery: "followUp",
        textPreview: "later",
        textLength: 5,
        imageCount: 0,
        enqueuedAt: "2026-08-31T01:00:06.000Z",
        source: "remote",
      }],
    };
    surface.observe("message_update", { message: { role: "assistant", content: "x" } });
    return sent;
  }
  const v2 = await connectWith(2);
  assert.equal(v2.some((value) => value.kind === "surface.summary" && value.summary.presentation.pendingFollowUpCount === 1), true);
  const v1 = await connectWith(1);
  assert.equal(v1.some((value) => value.kind === "surface.summary"), false);
});

test("message events allowlist text and never serialize thinking canaries", () => {
  const CANARY = "THINKING-CANARY-7f3a9c";
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({ snapshot: () => ({}), listCommands: () => [] }),
  }, protocol, { clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval } });
  const payload = surface.normalizeEvent("message_update", {
    message: {
      id: "m1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: CANARY },
        { type: "text", text: "visible" },
        { type: "toolCall", name: "bash", arguments: { cmd: CANARY } },
      ],
      usage: { secret: CANARY },
    },
    hidden: { thinking: CANARY },
  });
  assert.equal(JSON.stringify(payload).includes(CANARY), false);
  assert.equal(payload.event.message.content[0].text, "visible");
  surface.observe("message_update", {
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: CANARY }, { type: "text", text: "visible" }],
    },
  });
  const record = surface.buffer.drain().find((item) => item.type === "message.delta");
  assert.equal(record.type, "message.delta");
  assert.equal(JSON.stringify(record).includes(CANARY), false);
  assert.equal(JSON.stringify(record).includes("visible"), true);
});

test("summary zmxName is derived from this liveSessionId, never a leaked env name", () => {
  const previousLive = process.env.RUBATO_LIVE_SESSION_ID;
  const previousZmx = process.env.ZMX_SESSION;
  process.env.RUBATO_LIVE_SESSION_ID = "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5";
  process.env.ZMX_SESSION = "rubato-deadbeefcafe";
  try {
    const mismatched = new RemoteSurface({}, protocol, {
      liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
      clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
    });
    assert.equal(mismatched.summary().zmxName, undefined);
    assert.equal(mismatched.summary().managed, false);
    const matched = new RemoteSurface({}, protocol, {
      liveSessionId: "018f0f4c-9d2a-7a31-8b4d-6f708192a3b5",
      clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
    });
    assert.equal(matched.summary().zmxName, "rubato-018f0f4c9d2a");
    assert.equal(matched.summary().managed, true);
  } finally {
    if (previousLive === undefined) delete process.env.RUBATO_LIVE_SESSION_ID;
    else process.env.RUBATO_LIVE_SESSION_ID = previousLive;
    if (previousZmx === undefined) delete process.env.ZMX_SESSION;
    else process.env.ZMX_SESSION = previousZmx;
  }
});

test("only quit session_shutdown is a process-exit", () => {
  assert.equal(isProcessExitShutdown("quit"), true);
  assert.equal(isProcessExitShutdown("resume"), false);
  assert.equal(isProcessExitShutdown("reload"), false);
  assert.equal(isProcessExitShutdown("new"), false);
  assert.equal(isProcessExitShutdown("fork"), false);
  assert.equal(isProcessExitShutdown(undefined), false);
});

test("in-process session_shutdown does not emit live.exited", () => {
  const surface = new RemoteSurface({}, protocol, {
    buffer: { maxEvents: 10, maxBytes: 100_000 },
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  surface.observe("session_shutdown", { type: "session_shutdown", reason: "resume" });
  surface.observe("session_shutdown", { type: "session_shutdown", reason: "reload" });
  surface.observe("session_shutdown", { type: "session_shutdown", reason: "new" });
  assert.equal(surface.buffer.drain().some((record) => record.type === "live.exited"), false);
  surface.observe("session_shutdown", { type: "session_shutdown", reason: "quit" });
  const records = surface.buffer.drain();
  assert.equal(records.length, 1);
  assert.equal(records[0].type, "live.exited");
});

test("register summary never carries presentation even when a timeline exists", async () => {
  const sent = [];
  const timeline = {
    schemaVersion: 1,
    runs: [],
    pendingInputs: [],
    hasOlder: false,
  };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({ snapshot: () => ({ requestTimeline: timeline }), listCommands: () => [] }),
  }, protocol, {
    surfaceToken: "surface-token",
    connect: async () => ({ send: (value) => sent.push(value), close() {} }),
    clock: { now: () => 1_000, setTimeout, clearTimeout, setInterval, clearInterval },
  });
  await surface.connectNow();
  assert.equal(sent[0].kind, "surface.register");
  assert.equal(Object.hasOwn(sent[0].summary, "presentation"), false);
});

test("old protocol schemas drop presentation instead of aborting connect", async () => {
  const sent = [];
  let closed = false;
  const rejecting = {
    ...protocol,
    surfaceToHubFrameSchema: {
      parse(value) {
        if (value?.summary && Object.hasOwn(value.summary, "presentation")) {
          throw new Error("$.summary.presentation: is not allowed");
        }
        return value;
      },
    },
  };
  const surface = new RemoteSurface({
    getInteractiveControl: () => ({
      snapshot: () => ({
        requestTimeline: {
          schemaVersion: 1,
          runs: [],
          pendingInputs: [{ id: "q1", delivery: "followUp", textPreview: "later", textLength: 5, imageCount: 0, enqueuedAt: "2026-08-31T01:00:06.000Z", source: "remote" }],
          hasOlder: false,
        },
      }),
      listCommands: () => [],
    }),
  }, rejecting, {
    surfaceToken: "surface-token",
    connect: async () => ({ send: (value) => sent.push(value), close: () => { closed = true; } }),
    clock: { now: () => 1_000, setTimeout: () => 1, clearTimeout, setInterval, clearInterval },
  });
  await surface.connectNow();
  await surface.receive({ ...registered, negotiation: { compatible: true, version: 2 } });
  assert.equal(closed, false);
  assert.equal(sent[0].kind, "surface.register");
  assert.equal(Object.hasOwn(sent[0].summary, "presentation"), false);
  const snapshots = sent.filter((value) => value.kind === "surface.snapshot");
  assert.equal(snapshots.length > 0, true);
  assert.equal(Object.hasOwn(snapshots[0].summary, "presentation"), false);
  assert.equal(surface.presentationUnsupported, true);
});
