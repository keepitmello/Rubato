import assert from "node:assert/strict";
import test from "node:test";
import { runCredentialFailover, TURN_RETRY_SUPPRESSION_PREFIX } from "./auth-pool/failover.mjs";

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

// 회귀(2026-09-25): GUI 에서 Opus 턴을 멈추면 pool 이 provider 의 중단 event 를 Error 로
// 다시 던졌고, lazyStream 이 그걸 빈 `stopReason: "error"` 메시지로 새로 만들었다. 중단이
// 빨간 실패 줄로 뜨고, 이미 나간 텍스트가 사라지고, 재시도 금지 접두사가 두 번 붙었다.
test("a terminal event the pool cannot fail over passes through with its message intact", async () => {
  const drain = async (stream) => { const out = []; for await (const event of stream) out.push(event); return out; };
  const run = (terminal) => runCredentialFailover({
    listSlots: async () => [{ name: "sub" }, { name: "setup-token" }],
    select: (candidates) => candidates[0],
    runAttempt: async () => (async function* () {
      yield { type: "start" };
      yield { type: "text_delta", delta: "안녕" };
      yield terminal;
    })(),
    isCommittedOutput: (event) => event.type !== "start",
    errorFromEvent: (event) => (event.type === "error" ? new Error(event.error.errorMessage) : undefined),
    persistBlock: async () => {},
  });

  const aborted = { role: "assistant", content: [{ type: "text", text: "안녕" }], stopReason: "aborted", errorMessage: `${TURN_RETRY_SUPPRESSION_PREFIX}Request was aborted` };
  const abortedLast = (await drain(run({ type: "error", reason: "aborted", error: aborted }))).at(-1);
  assert.equal(abortedLast.error, aborted, "provider 가 정착시킨 메시지를 새로 만들지 않는다");
  assert.equal(abortedLast.error.stopReason, "aborted");
  assert.equal(abortedLast.error.errorMessage, `${TURN_RETRY_SUPPRESSION_PREFIX}Request was aborted`);

  const failed = { role: "assistant", content: [{ type: "text", text: "안녕" }], stopReason: "error", errorMessage: "terminated" };
  const failedLast = (await drain(run({ type: "error", reason: "error", error: failed }))).at(-1);
  assert.equal(failedLast.error.content[0].text, "안녕");
  assert.equal(failedLast.error.errorMessage, `${TURN_RETRY_SUPPRESSION_PREFIX}terminated`, "출력 뒤 실패는 접두사를 한 번만 받는다");
});
