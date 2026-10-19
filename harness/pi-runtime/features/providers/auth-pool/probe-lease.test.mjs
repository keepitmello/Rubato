import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialSlotRepository } from "./state-store.mjs";
import { streamWithCredentialRotation } from "./rotation-stream.mjs";
import { SETUP_TOKEN_ENV_NAME, SETUP_TOKEN_LANE, SETUP_TOKEN_SLOT_NAME, discoverSetupTokenSlots } from "./setup-token-slots.mjs";

// 실측(2026-10-19): 키체인 setup-token 계정의 한도 잠금이 끝난 뒤, `default` 를 쓰는 다른 세션
// 요청들이 목록을 뽑을 때마다 setup-token 에 30초짜리 시험 임대를 걸고 쓰지 않았다. 임대가
// 계속 갱신돼 잠금은 풀리지 않았고, setup-token 이 필요한 메인 모델 요청은 그 칸이 목록에서
// 빠져 "Account 'setup-token' is unavailable" 로만 실패했다.

const TOKEN = "sk-ant-oat-test";

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "rb-probe-lease-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repository = new CredentialSlotRepository(join(home, "state.json"));
  const revision = await repository.envCredentialRevision(SETUP_TOKEN_ENV_NAME, TOKEN);
  const now = Date.now();
  await repository.mutateSlotState("anthropic", SETUP_TOKEN_LANE, SETUP_TOKEN_SLOT_NAME, () => ({
    failureCount: 73,
    credentialRevision: revision,
    blockedUntil: now - 60_000,
    blockReason: "rate_limit",
  }));
  const extraSlots = await discoverSetupTokenSlots("anthropic", {}, { readClaudeSetupToken: async () => ({ token: TOKEN }) });
  const sources = {
    providerId: "anthropic",
    repository,
    env: () => undefined,
    credential: { type: "oauth", access: "a", refresh: "r", expires: now + 60_000 },
    discoverExtraSlots: async () => extraSlots,
  };
  return { repository, sources };
}

async function run(sources, options) {
  const used = [];
  const stream = streamWithCredentialRotation({
    sources,
    ...options,
    runAttempt: async (slot) => (async function* () { used.push(slot.name); yield { type: "done" }; })(),
  });
  for await (const _ of stream) { /* drain */ }
  return used;
}

async function setupTokenState(repository) {
  return (await repository.listSlots("anthropic", SETUP_TOKEN_LANE))[SETUP_TOKEN_SLOT_NAME];
}

test("a request on another account leaves no probe lease on the recovering setup-token", async (t) => {
  const { repository, sources } = await fixture(t);
  assert.deepEqual(await run(sources, { requiredSlotName: "default" }), ["default"]);
  assert.equal((await setupTokenState(repository)).lease, undefined);
});

test("a request that needs setup-token goes out while another request holds its probe lease", async (t) => {
  const { repository, sources } = await fixture(t);
  await repository.mutateSlotState("anthropic", SETUP_TOKEN_LANE, SETUP_TOKEN_SLOT_NAME, (current) => ({
    ...current, lease: { id: "someone-else", expiresAt: Date.now() + 30_000 },
  }));
  assert.deepEqual(await run(sources, { requiredSlotName: SETUP_TOKEN_SLOT_NAME }), [SETUP_TOKEN_SLOT_NAME]);
  const state = await setupTokenState(repository);
  assert.equal(state.failureCount, 0);
  assert.equal(state.blockedUntil, undefined);
  assert.equal(state.lease, undefined);
});

test("a free choice steps around an account another request is probing", async (t) => {
  const { repository, sources } = await fixture(t);
  await repository.mutateSlotState("anthropic", SETUP_TOKEN_LANE, SETUP_TOKEN_SLOT_NAME, (current) => ({
    ...current, lease: { id: "someone-else", expiresAt: Date.now() + 30_000 },
  }));
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(await run(sources, {}), ["default"]);
  }
});

test("a free choice that lands on a recovering account probes it with a lease", async (t) => {
  const { repository, sources } = await fixture(t);
  await repository.mutateSlotState("anthropic", "stored", "default", () => ({ blockReason: "auth_error", failureCount: 1 }));
  let leased;
  const stream = streamWithCredentialRotation({
    sources,
    runAttempt: async (slot) => {
      leased = (await setupTokenState(repository)).lease;
      return (async function* () { yield { type: "done" }; })();
    },
  });
  for await (const _ of stream) { /* drain */ }
  assert.ok(leased, "the account being tried carries the probe lease while it runs");
  assert.equal((await setupTokenState(repository)).lease, undefined);
});
