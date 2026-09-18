import assert from "node:assert/strict";
import test from "node:test";
import { runCredentialFailover } from "./auth-pool/failover.mjs";
import { listRotationSlots, streamWithCredentialRotation } from "./auth-pool/rotation-stream.mjs";
import { CredentialSlotRepository } from "./auth-pool/state-store.mjs";

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
