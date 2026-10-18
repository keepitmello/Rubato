import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAccountLoadBalancing } from "../provider-switch.mjs";
import { streamWithCredentialPool } from "./runtime-pool.mjs";
import { ANTHROPIC_SUB_PICKER_IDS } from "../../../../rubato-pi/src/picker-catalog.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "rb-load-balancing-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const modelId = ANTHROPIC_SUB_PICKER_IDS[0];
  const authPath = join(home, "auth.json");
  const setupPath = join(home, "setup-token");
  writeFileSync(setupPath, "sk-ant-oat-test\n");
  const state = {
    credential: { type: "oauth", access: "oauth", refresh: "r", expires: Date.now() + 999_999 },
    primaryExhausted: true, measurements: 0, failure: undefined, used: [],
  };
  const windows = (usedPercent) => [{
    id: "five_hour", usedPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), windowDurationMins: 300,
  }];
  const createRuntime = () => ({
    credentials: { read: async () => state.credential, store: { authPath } },
    _rubatoQuotaUsage: async () => {
      state.measurements++;
      return {
        default: { windows: windows(state.primaryExhausted ? 20 : 100) },
        "setup-token": { windows: windows(state.primaryExhausted ? 100 : 20) },
      };
    },
    _rubatoUsageObserver: null,
    prepareRequest: async (model, options) => ({
      model, options,
      provider: { stream: async function* (wired, _context, opts) {
        state.used.push({ model: wired.id, account: opts.slotName ?? "setup-token" });
        if (state.failure) throw state.failure;
        yield { type: "done" };
      } },
    }),
  });
  const call = async (sessionId, { id = modelId, runtime = current, affinityKey } = {}) => {
    const stream = await streamWithCredentialPool(runtime, "stream", { provider: "anthropic", id }, {}, {
      sessionId, affinityKey,
      env: { HOME: home, RUBATO_CLAUDE_SETUP_TOKEN_FILE: setupPath, RUBATO_CLAUDE_ACCOUNT: home },
    });
    for await (const _ of stream) { /* drain */ }
    return state.used.at(-1).account;
  };
  const current = createRuntime();
  return { home, modelId, state, call, createRuntime };
}

test("only new sessions are balanced; turns, quota changes, pins and toggle changes never reassign", async (t) => {
  const { home, modelId, state, call } = fixture(t);
  assert.equal(await call("manual"), "setup-token");
  assert.equal(state.measurements, 0);
  setAccountLoadBalancing("anthropic", true, { home });
  assert.equal(await call("manual"), "setup-token", "enabling does not move existing sessions");
  assert.equal(state.measurements, 0);
  assert.equal(await call("balanced"), "default", "only a new session uses the available account");
  assert.equal(state.measurements, 1);
  state.primaryExhausted = false;
  assert.equal(await call("balanced"), "default", "quota reversal does not move a session");
  assert.equal(await call("balanced", { id: ANTHROPIC_SUB_PICKER_IDS[1] }), "default", "changing models keeps the same account");
  assert.equal(await call("another"), "setup-token", "a new session can use the other account");
  assert.equal(state.measurements, 2);
  assert.equal(await call("explicit", { id: `${modelId}-sub` }), "default");
  assert.equal(state.used.at(-1).model, modelId, "wire model has no account suffix");
  assert.equal(state.measurements, 2, "explicit account selection does not query the allocator");
  state.credential.pinned = "setup-token";
  assert.equal(await call("balanced"), "default", "new pins affect only new sessions");
  assert.equal(await call("pinned"), "setup-token");
  setAccountLoadBalancing("anthropic", false, { home });
  assert.equal(await call("balanced"), "default", "turning off does not move an existing session");
  assert.equal(await call("new-off"), "setup-token");
  delete state.credential.pinned;
  assert.equal(await call("new-sub", { id: `${modelId}-sub` }), "default");
  await assert.rejects(call("manual", { id: `${modelId}-sub` }), /Start a new session/);
});

test("recreated runtimes and changing cache affinity retain the persisted thread account", async (t) => {
  const { home, state, call, createRuntime } = fixture(t);
  setAccountLoadBalancing("anthropic", true, { home });
  assert.equal(await call("thread", { affinityKey: "cache-a" }), "default");
  state.primaryExhausted = false;
  const restarted = createRuntime();
  assert.equal(await call("thread", { runtime: restarted, affinityKey: "cache-b" }), "default");
  assert.equal(state.measurements, 1, "resuming does not query quota or allocate again");
  assert.equal(await call("new-thread", { runtime: restarted }), "setup-token");
});

test("429, retry, reset and missing credentials never move a bound session to its healthy sibling", async (t) => {
  const { home, state, call, createRuntime } = fixture(t);
  setAccountLoadBalancing("anthropic", true, { home });
  state.failure = Object.assign(new Error("Too Many Requests"), { status: 429 });
  await assert.rejects(call("limited"), /Too Many Requests/);
  await assert.rejects(call("limited", { runtime: createRuntime() }), /Too Many Requests/);
  assert.deepEqual(state.used.map((entry) => entry.account), ["default", "default"]);
  state.primaryExhausted = false;
  state.failure = undefined;
  assert.equal(await call("limited", { runtime: createRuntime() }), "default", "reset retries the same account");
  state.credential = undefined;
  const before = state.used.length;
  await assert.rejects(call("limited", { runtime: createRuntime() }), /Account 'default' is unavailable/);
  assert.equal(state.used.length, before, "a removed account fails without using the remaining one");
});

test("a session is bound even with only one account, before a second account is added", async (t) => {
  const { state, call } = fixture(t);
  const stored = state.credential;
  state.credential = undefined;
  assert.equal(await call("single"), "setup-token");
  state.credential = stored;
  state.credential.pinned = "default";
  assert.equal(await call("single"), "setup-token");
  assert.equal(await call("new-pinned"), "default");
});

test("automatic assignment refuses requests without a session identity", async (t) => {
  const { home, state, call } = fixture(t);
  setAccountLoadBalancing("anthropic", true, { home });
  await assert.rejects(call(undefined), /requires a session id/);
  assert.deepEqual(state.used, []);
});
