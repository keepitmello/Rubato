import test from "node:test";
import assert from "node:assert/strict";
import { RemoteSurface, SurfaceEventBuffer } from "../../src/extensions/remote-surface.mjs";

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
