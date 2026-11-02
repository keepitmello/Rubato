import assert from "node:assert/strict";
import test from "node:test";
import { KEYCHAIN_REUSE_MS, forgetKeychainSecrets, readKeychainSecretShared } from "../../src/keychain-secret.mjs";

function counter(answer = "secret") {
  const calls = [];
  return { calls, read: async (request) => { calls.push(request); return typeof answer === "function" ? answer() : answer; } };
}

test("one Keychain read serves every caller for a while, per service and account", async () => {
  forgetKeychainSecrets();
  let clock = 1_000;
  const now = () => clock;
  const { calls, read } = counter();
  const answers = await Promise.all(Array.from({ length: 100 }, () => readKeychainSecretShared({ service: "s", read, now })));
  assert.deepEqual(new Set(answers), new Set(["secret"]));
  assert.equal(calls.length, 1);
  await readKeychainSecretShared({ service: "s", account: "me", read, now });
  await readKeychainSecretShared({ service: "other", read, now });
  assert.equal(calls.length, 3);
  clock += KEYCHAIN_REUSE_MS;
  await readKeychainSecretShared({ service: "s", read, now });
  assert.equal(calls.length, 4);
  forgetKeychainSecrets();
  await readKeychainSecretShared({ service: "s", read, now });
  assert.equal(calls.length, 5);
});

test("a missing item is remembered too, and a failed read is asked again", async () => {
  forgetKeychainSecrets();
  const missing = counter(() => undefined);
  assert.equal(await readKeychainSecretShared({ service: "none", read: missing.read }), undefined);
  assert.equal(await readKeychainSecretShared({ service: "none", read: missing.read }), undefined);
  assert.equal(missing.calls.length, 1);
  let fail = true;
  const flaky = counter(() => { if (fail) throw new Error("locked"); return "ok"; });
  await assert.rejects(readKeychainSecretShared({ service: "flaky", read: flaky.read }), /locked/);
  fail = false;
  assert.equal(await readKeychainSecretShared({ service: "flaky", read: flaky.read }), "ok");
  assert.equal(flaky.calls.length, 2);
});

test("one caller giving up does not cancel the read the others wait on", async () => {
  forgetKeychainSecrets();
  let release;
  const { calls, read } = counter(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const abandoned = readKeychainSecretShared({ service: "slow", read, signal: controller.signal });
  const waiting = readKeychainSecretShared({ service: "slow", read });
  controller.abort();
  await assert.rejects(abandoned, (error) => error.name === "AbortError");
  await new Promise((resolve) => setImmediate(resolve));
  release("value");
  assert.equal(await waiting, "value");
  assert.equal(calls.length, 1);
  await assert.rejects(readKeychainSecretShared({ service: "slow", read, signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
});
