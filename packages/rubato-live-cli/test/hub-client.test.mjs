import test from "node:test";
import assert from "node:assert/strict";
import { HubLifecycleClient, HubUnavailableError } from "../src/hub-client.mjs";

const SESSION = {
  liveSessionId: "018f0c7b-2f3b-7c4d-9e5f-1234567890ab",
  zmxName: "rubato-018f0c7b2f3b",
  managed: true,
  title: "Demo",
  cwd: "/tmp",
  lifecycle: "starting",
  pi: { sessionFile: "/tmp/session.jsonl" },
};

class FakeControl {
  constructor() { this.calls = []; this.sessions = [SESSION]; }
  async request(kind, fields = {}) {
    this.calls.push({ kind, fields });
    if (kind === "cli.health") return { healthy: true };
    if (kind === "cli.create") return { session: SESSION };
    if (kind === "cli.list") return { sessions: this.sessions };
    if (kind === "cli.resolve") return { session: SESSION };
    if (kind === "cli.kill") return { terminated: true };
    throw new Error(kind);
  }
}

test("terminal create sends process environment only through hub control and attaches its returned zmx identity", async () => {
  const control = new FakeControl();
  const attached = [];
  const lifecycle = new HubLifecycleClient({ control, zmx: { attach: (name) => attached.push(name) }, env: { SECRET: "terminal-only" } });
  const result = await lifecycle.create({ cwd: "/tmp", args: ["hello"] });
  assert.equal(result, SESSION);
  const create = control.calls.find((call) => call.kind === "cli.create");
  assert.deepEqual(create.fields.environment, { SECRET: "terminal-only" });
  assert.deepEqual(create.fields.rubatoArgs, ["hello"]);
  assert.deepEqual(attached, [SESSION.zmxName]);
});

test("attach resolves through hub and zmx-attaches the exact returned session", async () => {
  const control = new FakeControl();
  const attached = [];
  const lifecycle = new HubLifecycleClient({ control, zmx: { attach: (name) => attached.push(name) } });
  await lifecycle.attach("018f0c7b");
  assert.equal(control.calls.at(-1).kind, "cli.resolve");
  assert.deepEqual(attached, [SESSION.zmxName]);
});

test("Vault resume attaches the one matching hub summary without creating a duplicate", async () => {
  const control = new FakeControl();
  const attached = [];
  const lifecycle = new HubLifecycleClient({ control, zmx: { attach: (name) => attached.push(name) } });
  const result = await lifecycle.vaultResume("/tmp/session.jsonl");
  assert.equal(result.attached, true);
  assert.deepEqual(attached, [SESSION.zmxName]);
  assert.equal(control.calls.some((call) => call.kind === "cli.create"), false);
});

test("hub health failure kickstarts once and reports dispatcher fallback status", async () => {
  let kickstarts = 0;
  const lifecycle = new HubLifecycleClient({
    control: { request: async () => { throw new Error("down"); } },
    zmx: {},
    kickstart: () => { kickstarts += 1; },
    startupTimeoutMs: 0,
  });
  await assert.rejects(() => lifecycle.list(), (error) => error instanceof HubUnavailableError && error.code === "HUB_UNAVAILABLE");
  assert.equal(kickstarts, 1);
});
