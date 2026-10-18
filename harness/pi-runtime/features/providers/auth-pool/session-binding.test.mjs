import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CredentialSlotRepository } from "./state-store.mjs";
import { streamWithCredentialRotation } from "./rotation-stream.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "rb-session-binding-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, "state.json");
}

test("concurrent first requests with separate runtimes and opposing choices share one assignment", async (t) => {
  const path = fixture(t);
  const used = [];
  const run = async (random) => {
    const stream = streamWithCredentialRotation({
      affinityKey: "thread", affinityStore: new Map(), random: () => random,
      sources: {
        providerId: "anthropic", repository: new CredentialSlotRepository(path),
        loadBalancing: true, policy: { affinity: false }, env: () => undefined,
        credential: { type: "api_key", accounts: [{ name: "a", key: "a" }, { name: "b", key: "b" }] },
      },
      runAttempt: async (slot) => (async function* () { used.push(slot.name); yield { type: "done" }; })(),
    });
    for await (const _ of stream) { /* drain */ }
  };
  await Promise.all(Array.from({ length: 8 }, (_, i) => run(i % 2 ? 0.99 : 0)));
  assert.equal(used.length, 8);
  assert.equal(new Set(used).size, 1);
  const repository = new CredentialSlotRepository(path);
  assert.deepEqual(await repository.sessionBinding("anthropic", "thread"), { name: used[0], lane: "stored" });
  await repository.mutateSlotState("anthropic", "stored", used[0], () => ({ failureCount: 1 }));
  assert.equal((await new CredentialSlotRepository(path).sessionBinding("anthropic", "thread")).name, used[0]);
  assert.ok(!readFileSync(path, "utf8").includes('"thread"'), "session ids are not stored in plain text");
});

function childBind(path, name) {
  return new Promise((resolve, reject) => {
    const code = `
      import { CredentialSlotRepository } from ${JSON.stringify(new URL("./state-store.mjs", import.meta.url).href)};
      const bound = await new CredentialSlotRepository(process.argv[1]).bindSessionSlot(
        "anthropic", "thread", () => ({ name: process.argv[2], lane: "stored" }));
      console.log(bound.name);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, path, name]);
    let out = "", err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.on("error", reject);
    child.on("close", (status) => status === 0 ? resolve(out.trim()) : reject(new Error(err)));
  });
}

test("first assignment wins across processes and survives process exit", async (t) => {
  const path = fixture(t);
  const results = await Promise.all(["a", "b", "c", "d"].map((name) => childBind(path, name)));
  assert.equal(new Set(results).size, 1);
  assert.equal(await childBind(path, "later"), results[0]);
});

test("an unavailable or removed account fails closed, including an empty pool", async (t) => {
  const repository = new CredentialSlotRepository(fixture(t));
  await repository.bindSessionSlot("anthropic", "thread", () => ({ name: "removed", lane: "stored" }));
  let attempts = 0;
  const stream = streamWithCredentialRotation({
    affinityKey: "thread", affinityStore: new Map(),
    sources: { providerId: "anthropic", repository, env: () => undefined },
    runAttempt: async () => { attempts++; },
  });
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } }, /No credential slots available/);
  assert.equal(attempts, 0);
  assert.equal((await repository.sessionBinding("anthropic", "thread")).name, "removed");
});

test("corrupt persisted state fails closed rather than assigning another account", async (t) => {
  const path = fixture(t);
  writeFileSync(path, "{truncated");
  await assert.rejects(new CredentialSlotRepository(path).bindSessionSlot(
    "anthropic", "thread", () => ({ name: "other", lane: "stored" })), /refusing to reassign/);
  assert.equal(readFileSync(path, "utf8"), "{truncated");
});
