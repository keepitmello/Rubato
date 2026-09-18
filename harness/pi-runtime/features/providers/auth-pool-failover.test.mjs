import assert from "node:assert/strict";
import test from "node:test";
import { runCredentialFailover } from "./auth-pool/failover.mjs";

// 회귀: 401 한 번이 유일한 계정을 영구 퇴역시켰다. auth_error 는 pool 이 스스로
// 풀 수 없고(차단된 칸은 선택되지 않으니 onSuccess 가 못 돈다), 넘어갈 다른 계정도
// 없으면 그 기록은 provider 를 끄는 일만 한다.
//
// 실측: `credential-pool-state.json` 의 Codex `default` 가 `failureCount: 1`,
// `blockReason: "auth_error"` 로 굳어 있었는데 같은 자격증명으로 갱신을 돌리면
// 그냥 성공했다.
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

  await assert.rejects(
    async () => { for await (const _event of run([{ name: "default" }])) { /* drain */ } },
    /Unauthorized/,
  );
  assert.deepEqual(blocked, [], "계정이 하나면 차단을 남기지 않는다");

  await assert.rejects(
    async () => { for await (const _event of run([{ name: "default" }, { name: "login-2" }])) { /* drain */ } },
    /Unauthorized/,
  );
  assert.deepEqual(blocked, ["default:auth_error"], "넘어갈 계정이 있으면 그대로 차단한다");
});

// 429 는 되돌릴 수 있는 차단이므로 계정이 하나여도 그대로 기록한다.
test("a rate limit still records a cooldown on a single credential", async () => {
  const blocked = [];
  await assert.rejects(async () => {
    for await (const _event of runCredentialFailover({
      listSlots: async () => [{ name: "default" }],
      select: (candidates) => candidates[0],
      runAttempt: async () => {
        const error = new Error("Too Many Requests");
        error.status = 429;
        throw error;
      },
      isCommittedOutput: () => false,
      persistBlock: async (slot, block) => { blocked.push(`${slot.name}:${block.reason}`); },
    })) {
      /* drain */
    }
  }, /Too Many Requests/);
  assert.deepEqual(blocked, ["default:rate_limit"]);
});
