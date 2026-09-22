import assert from "node:assert/strict";
import test from "node:test";
import { runCredentialFailover } from "./auth-pool/failover.mjs";
import { listRotationSlots, streamWithCredentialRotation } from "./auth-pool/rotation-stream.mjs";
import { CredentialSlotRepository } from "./auth-pool/state-store.mjs";
import { requiredAccountSlotName, wireAccountModel } from "./auth-pool/runtime-pool.mjs";
import { invokeProviderStream } from "./auth-pool/runtime-pool.mjs";

test("429 does not hop to another credential slot", async () => {
  const used = [];
  await assert.rejects(async () => {
    for await (const _event of runCredentialFailover({
      listSlots: async () => [{ name: "a" }, { name: "b" }],
      select: (candidates) => candidates[0],
      runAttempt: async (slot) => {
        used.push(slot.name);
        const error = new Error("Too Many Requests");
        error.status = 429;
        throw error;
      },
      isCommittedOutput: () => false,
      persistBlock: async () => {},
    })) {
      /* drain */
    }
  }, /Too Many Requests/);
  assert.deepEqual(used, ["a"]);
});

test("unwrapped providers record speed; already wrapped providers are not wrapped again", () => {
  const calls = [];
  const raw = function streamSimple(model, _context, options) {
    calls.push(["raw", model.id, options?.tag]);
    return "raw";
  };
  const prepared = { provider: { streamSimple: raw }, model: { id: "deepseek-v4.1-flash" } };
  const wrap = (source, store) => function wrapped(model, context, options) {
    calls.push(["wrap", store, model.id]);
    return source.call(this, model, context, options);
  };
  assert.equal(invokeProviderStream(prepared, "streamSimple", {}, "store", wrap), "raw");
  assert.deepEqual(calls, [["wrap", "store", "deepseek-v4.1-flash"], ["raw", "deepseek-v4.1-flash", undefined]]);
  calls.length = 0;
  prepared.provider[Symbol.for("rubato.stream.decorated")] = true;
  assert.equal(invokeProviderStream(prepared, "streamSimple", {}, "store", wrap), "raw");
  assert.deepEqual(calls, [["raw", "deepseek-v4.1-flash", undefined]]);
  calls.length = 0;
  delete prepared.provider[Symbol.for("rubato.stream.decorated")];
  assert.equal(invokeProviderStream(prepared, "streamSimple", {}, undefined, wrap), "raw");
  assert.deepEqual(calls, [["raw", "deepseek-v4.1-flash", undefined]]);
});

test("a 401 does not permanently retire the only credential", async () => {
  const blocked = [];
  const attempt = async () => {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  };
  const run = (slots) => runCredentialFailover({
    listSlots: async () => slots,
    select: (candidates) => candidates[0],
    runAttempt: attempt,
    isCommittedOutput: () => false,
    persistBlock: async (slot, block) => { blocked.push(`${slot.name}:${block.reason}`); },
  });
  await assert.rejects(async () => { for await (const _ of run([{ name: "default" }])) { /* drain */ } }, /Unauthorized/);
  assert.deepEqual(blocked, [], "계정이 하나면 차단을 남기지 않는다");

  await assert.rejects(
    async () => { for await (const _ of run([{ name: "default" }, { name: "login-2" }])) { /* drain */ } },
    /Unauthorized/,
  );
  assert.deepEqual(blocked, ["default:auth_error"], "넘어갈 계정이 있으면 그대로 차단한다");
});

test("session affinity stays on the first slot after 429; a new session can use the other", async () => {
  const used = [];
  const repository = new CredentialSlotRepository();
  const store = new Map();
  const sources = {
    providerId: "xai",
    credential: {
      type: "api_key",
      key: "key-a",
      accounts: [
        { name: "default", source: "login", key: "key-a" },
        { name: "login-2", source: "login", key: "key-b" },
      ],
    },
    env: () => undefined,
    repository,
    policy: {},
  };
  const failName = { current: undefined };
  const run = (sessionId) => streamWithCredentialRotation({
    sources,
    affinityStore: store,
    affinityKey: sessionId,
    runAttempt: async (slot) => {
      used.push(`${sessionId}:${slot.name}`);
      if (failName.current === undefined) failName.current = slot.name;
      if (slot.name === failName.current) {
        const error = new Error("Too Many Requests");
        error.status = 429;
        throw error;
      }
      return (async function* () {
        yield { type: "start" };
        yield { type: "text", text: "ok" };
      })();
    },
  });

  await assert.rejects(async () => {
    for await (const _event of run("s1")) { /* drain */ }
  }, /Too Many Requests/);
  await assert.rejects(async () => {
    for await (const _event of run("s1")) { /* drain */ }
  }, /Too Many Requests/);
  const events = [];
  for await (const event of run("s2")) events.push(event);
  assert.equal(used[0].split(":")[1], used[1].split(":")[1]);
  assert.notEqual(used[2].split(":")[1], used[0].split(":")[1]);
  assert.equal(events.at(-1).text, "ok");
});

test("stored oauth plus setup-token list as one pool", async () => {
  const slots = await listRotationSlots({
    providerId: "anthropic",
    credential: {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
      accounts: [{ name: "default", source: "login", access: "a", refresh: "r", expires: 1 }],
    },
    env: () => undefined,
    repository: new CredentialSlotRepository(),
    discoverExtraSlots: async () => [{
      name: "setup-token",
      lane: "setup-token",
      envVarName: "claude-setup-token",
      key: "sk-ant-oat-test",
      source: "setup-token",
    }],
  }, { acquireLeases: false });
  assert.deepEqual(slots.map((slot) => `${slot.lane}:${slot.name}`), ["stored:default", "setup-token:setup-token"]);
});

test("pinned setup-token wins over stored oauth in the same pool", async () => {
  const slots = await listRotationSlots({
    providerId: "anthropic",
    credential: {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
      pinned: "setup-token",
      accounts: [{ name: "default", source: "login", access: "a", refresh: "r", expires: 1 }],
    },
    env: () => undefined,
    repository: new CredentialSlotRepository(),
    discoverExtraSlots: async () => [{
      name: "setup-token",
      lane: "setup-token",
      envVarName: "claude-setup-token",
      key: "sk-ant-oat-test",
      source: "setup-token",
    }],
  }, { acquireLeases: false });
  const setup = slots.find((slot) => slot.name === "setup-token");
  const stored = slots.find((slot) => slot.name === "default");
  assert.equal(setup.pinned, true);
  assert.equal(stored.pinned, false);
});

test("sub model ids wire to the base model and require the sub account", () => {
  const model = { provider: "anthropic", id: "claude-opus-5-sub" };
  assert.equal(wireAccountModel(model).id, "claude-opus-5");
  assert.equal(wireAccountModel({ provider: "openai-codex", id: "gpt-5.6-sol-sub" }).id, "gpt-5.6-sol");
  assert.equal(requiredAccountSlotName(model, [{ name: "sub" }, { name: "setup-token", lane: "setup-token" }]), "sub");
  assert.equal(requiredAccountSlotName({ provider: "anthropic", id: "claude-opus-5" }, [{ name: "sub" }, { name: "setup-token", lane: "setup-token" }]), "setup-token");
  assert.equal(requiredAccountSlotName({ provider: "xai", id: "grok-4.7-sub" }, [{ name: "default" }, { name: "login-2" }]), "login-2");
  assert.equal(requiredAccountSlotName({ provider: "anthropic", id: "claude-opus-5" }, [{ name: "default" }]), undefined);
});

test("requiredSlotName beats pin and session affinity", async () => {
  const used = [];
  const repository = new CredentialSlotRepository();
  const sources = {
    providerId: "anthropic",
    credential: {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
      pinned: "setup-token",
      accounts: [{ name: "sub", source: "login", access: "a", refresh: "r", expires: 1 }],
    },
    env: () => undefined,
    repository,
    policy: {},
    discoverExtraSlots: async () => [{
      name: "setup-token",
      lane: "setup-token",
      envVarName: "claude-setup-token",
      key: "sk-ant-oat-test",
      source: "setup-token",
    }],
  };
  const events = [];
  for await (const event of streamWithCredentialRotation({
    sources,
    affinityStore: new Map(),
    affinityKey: "s1",
    requiredSlotName: "sub",
    runAttempt: async (slot) => {
      used.push(slot.name);
      return (async function* () {
        yield { type: "start" };
        yield { type: "text", text: "ok" };
      })();
    },
  })) events.push(event);
  assert.deepEqual(used, ["sub"]);
  assert.equal(events.at(-1).text, "ok");
});

// 회귀: 성공이 failureCount 를 되돌리지 않아 지수 백오프가 영영 줄지 않았다.
// 실측(2026-09-22 `credential-pool-state.json`): anthropic `setup-token` 슬롯이
// `failureCount: 12` 로 굳어 있었고, 그 상태에서는 429 한 번이 곧바로 상한 48시간을
// 다시 잠갔다. 그 슬롯에 하드로 묶인 fable·opus·sonnet·haiku 가 통째로 죽었다.
test("a successful call clears the consecutive-failure count", async () => {
  const repository = new CredentialSlotRepository();
  const token = "sk-ant-oat-test";
  const revision = await repository.envCredentialRevision("claude-setup-token", token);
  await repository.mutateSlotState("anthropic", "setup-token", "setup-token", () => ({
    failureCount: 12,
    credentialRevision: revision,
    blockedUntil: 1,
    blockReason: "rate_limit",
  }));
  const sources = {
    providerId: "anthropic",
    credential: undefined,
    env: () => undefined,
    repository,
    policy: {},
    discoverExtraSlots: async () => [{
      name: "setup-token",
      lane: "setup-token",
      envVarName: "claude-setup-token",
      key: token,
      source: "setup-token",
    }],
  };
  const events = [];
  for await (const event of streamWithCredentialRotation({
    sources,
    affinityStore: new Map(),
    affinityKey: "s1",
    requiredSlotName: "setup-token",
    runAttempt: async () => (async function* () {
      yield { type: "start" };
      yield { type: "text", text: "ok" };
    })(),
  })) events.push(event);
  assert.equal(events.at(-1).text, "ok");

  const state = await repository.listSlots("anthropic", "setup-token");
  assert.equal(state["setup-token"].failureCount, 0, "성공한 호출은 연속 실패 횟수를 0 으로 되돌린다");
  assert.equal(state["setup-token"].blockedUntil, undefined);
  assert.equal(state["setup-token"].blockReason, undefined);
});
