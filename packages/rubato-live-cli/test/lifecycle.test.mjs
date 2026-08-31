import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveLifecycle } from "../src/lifecycle.mjs";

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab";

class MemoryStore {
  constructor() { this.sessions = []; }
  hostId() { return HOST_ID; }
  list() { return structuredClone(this.sessions); }
  replace(sessions) { this.sessions = structuredClone(sessions); }
  upsert(session) {
    const index = this.sessions.findIndex((entry) => entry.liveSessionId === session.liveSessionId);
    if (index >= 0) this.sessions[index] = structuredClone(session);
    else this.sessions.push(structuredClone(session));
    return session;
  }
  remove(id) { this.sessions = this.sessions.filter((entry) => entry.liveSessionId !== id); }
}

class FakeHandoff {
  async prepare(payload) {
    this.payload = payload;
    return { descriptorPath: "/tmp/rubato-descriptor", consumed: Promise.resolve(), cancel() {} };
  }
}

class FakeZmx {
  constructor(handoff) {
    this.binary = "/pinned/zmx";
    this.handoff = handoff;
    this.sessions = new Map();
    this.runs = [];
    this.attaches = [];
    this.kills = [];
    this.nextPid = 4100;
  }
  runDetached(name, command) {
    const pid = this.nextPid++;
    this.runs.push({ name, command, pid, payload: structuredClone(this.handoff.payload) });
    this.sessions.set(name, { pid, labels: this.handoff.payload.labels });
  }
  setLabels(name, labels) { this.sessions.get(name).labels = labels; }
  attach(name) {
    const pid = this.sessions.get(name)?.pid;
    if (!pid) throw new Error("missing fake zmx session");
    this.attaches.push({ name, pid });
  }
  kill(name) { this.kills.push(name); this.sessions.delete(name); }
  reconcile() {
    return [...this.sessions].map(([zmxName, value]) => ({
      liveSessionId: value.labels.rubato_live_id,
      hostId: value.labels.rubato_host_id,
      zmxName,
      managed: true,
      pid: value.pid,
    }));
  }
}

function fixture(t, env = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rubato-live-lifecycle-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const handoff = new FakeHandoff();
  const zmx = new FakeZmx(handoff);
  const store = new MemoryStore();
  const lifecycle = new LiveLifecycle({
    zmx,
    store,
    handoff,
    launcherPath: "/rubato/rubato-pi.sh",
    bootstrapPath: "/rubato/rubato-live-bootstrap.mjs",
    nodePath: "/node24",
    env,
    buildId: "abc123",
  });
  return { cwd, handoff, zmx, store, lifecycle };
}

test("detached create hands environment over memory and records protocol identifiers", async (t) => {
  const { cwd, handoff, zmx, lifecycle } = fixture(t);
  const sessionFile = join(cwd, "session.jsonl");
  const session = await lifecycle.create({
    cwd,
    detach: true,
    args: ["--session", sessionFile],
    environment: { PATH: "/bin", SECRET_TOKEN: "not-on-disk" },
  });
  assert.equal(zmx.runs.length, 1);
  assert.equal(zmx.attaches.length, 0);
  assert.equal(session.sessionFile, sessionFile);
  assert.equal(handoff.payload.env.SECRET_TOKEN, "not-on-disk");
  assert.equal(handoff.payload.liveSessionId, session.liveSessionId);
  assert.equal(handoff.payload.zmxName, session.zmxName);
  assert.equal(handoff.payload.labels.rubato_live_id, session.liveSessionId);
  assert.match(zmx.runs[0].command, /^exec '\/node24' '\/rubato\/rubato-live-bootstrap\.mjs' '\/tmp\/rubato-descriptor'$/);
});

test("create then attach reaches the same live PID and session file", async (t) => {
  const { cwd, zmx, lifecycle } = fixture(t);
  const sessionFile = join(cwd, "session.jsonl");
  const session = await lifecycle.create({ cwd, detach: true, args: ["--session", sessionFile] });
  const createdPid = zmx.runs[0].pid;
  const attached = lifecycle.attach(session.liveSessionId.slice(0, 13));
  assert.equal(attached.sessionFile, sessionFile);
  assert.deepEqual(zmx.attaches.at(-1), { name: session.zmxName, pid: createdPid });
});

test("restart reconciliation rebuilds managed inventory from zmx labels", async (t) => {
  const { cwd, handoff, zmx, lifecycle } = fixture(t);
  const created = await lifecycle.create({ cwd, detach: true });
  const restarted = new LiveLifecycle({
    zmx,
    store: new MemoryStore(),
    handoff,
    launcherPath: "/rubato/rubato-pi.sh",
    bootstrapPath: "/rubato/rubato-live-bootstrap.mjs",
  });
  const [reconciled] = restarted.list();
  assert.equal(reconciled.liveSessionId, created.liveSessionId);
  assert.equal(reconciled.zmxName, created.zmxName);
  assert.equal(reconciled.pid, zmx.runs[0].pid);
});

test("Vault resume attaches first and never duplicates a matching process", async (t) => {
  const { cwd, zmx, lifecycle } = fixture(t);
  const sessionFile = join(cwd, "session.jsonl");
  const session = await lifecycle.create({ cwd, detach: true, args: ["--session", sessionFile] });
  const before = zmx.runs.length;
  const result = await lifecycle.vaultResume(sessionFile);
  assert.equal(result.attached, true);
  assert.equal(result.session.liveSessionId, session.liveSessionId);
  assert.equal(zmx.runs.length, before);
  assert.equal(zmx.attaches.at(-1).name, session.zmxName);
});

test("Vault fork always allocates another live process", async (t) => {
  const { cwd, zmx, lifecycle } = fixture(t);
  const sessionFile = join(cwd, "session.jsonl");
  const first = await lifecycle.create({ cwd, detach: true, args: ["--session", sessionFile] });
  const forked = await lifecycle.vaultFork(sessionFile, { cwd, detach: true });
  assert.notEqual(forked.liveSessionId, first.liveSessionId);
  assert.deepEqual(zmx.runs.at(-1).payload.argv, ["--fork", sessionFile]);
});

test("a nested zmx session can only create detached and attach uses the existing client path", async (t) => {
  const { cwd, lifecycle, zmx } = fixture(t, { ZMX_SESSION: "rubato-parent0000" });
  await assert.rejects(() => lifecycle.create({ cwd }), /new --detach/);
  const detached = await lifecycle.create({ cwd, detach: true });
  lifecycle.attach(detached.liveSessionId);
  assert.equal(zmx.runs.length, 1);
  assert.equal(zmx.attaches.length, 1);
});
