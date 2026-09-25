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

// 2026-09-25 핫스팟 세션: 연결이 10초씩 막히고 스트림이 사고 도중 끊겼다. 아래는 그 회선에서
// 계정 풀이 지켜야 하는 것들이다 — 커밋은 텍스트·도구만, 같은 호출 안의 즉시 재시도는
// 아무것도 안 나갔을 때만, 넘길 수 없는 실패는 provider 의 원래 메시지로.
const { isCommittedOutput } = await import("./auth-pool/rotation-stream.mjs");

function assistantError(errorMessage, content = []) {
  return {
    role: "assistant",
    content,
    stopReason: "error",
    errorMessage,
    usage: { input: 1200, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 1203 },
  };
}

function scriptedPool(attempts) {
  let calls = 0;
  const stream = runCredentialFailover({
    listSlots: async () => [{ name: "sub" }],
    select: (candidates) => candidates[0],
    runAttempt: async () => {
      const events = attempts[calls];
      calls += 1;
      return (async function* () { for (const event of events) yield event; })();
    },
    isCommittedOutput,
    errorFromEvent: (event) => (event.type === "error" ? new Error(event.error.errorMessage) : undefined),
    persistBlock: async () => {},
  });
  return { stream, calls: () => calls };
}

async function drainEvents(stream) {
  const out = [];
  for await (const event of stream) out.push(event);
  return out;
}

test("사고만 나오고 끊긴 턴은 접두사 없이 원래 메시지로 끝나 세션 재시도에 맡겨진다", async () => {
  const thinking = [{ type: "thinking", thinking: "생각 중" }];
  const failed = assistantError("terminated", thinking);
  const pool = scriptedPool([[
    { type: "start" },
    { type: "thinking_delta", delta: "생각 중" },
    { type: "error", reason: "error", error: failed },
  ]]);
  const events = await drainEvents(pool.stream);
  const last = events.at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.error, failed, "provider 메시지를 새로 만들지 않는다");
  assert.equal(last.error.errorMessage, "terminated", "사고는 커밋이 아니므로 재시도 금지 접두사가 없다");
  assert.deepEqual(last.error.content, thinking, "이미 나간 사고가 남는다");
  assert.equal(last.error.usage.input, 1200, "실패한 시도의 usage 가 남는다");
  assert.equal(pool.calls(), 1, "이미 event 를 넘겼으므로 같은 호출 안에서 다시 시도하지 않는다");
});

test("텍스트가 나간 뒤 끊긴 턴은 재시도 금지 접두사를 단다", async () => {
  const pool = scriptedPool([[
    { type: "start" },
    { type: "text_delta", delta: "안녕" },
    { type: "error", reason: "error", error: assistantError("terminated", [{ type: "text", text: "안녕" }]) },
  ]]);
  const last = (await drainEvents(pool.stream)).at(-1);
  assert.equal(last.error.errorMessage, `${TURN_RETRY_SUPPRESSION_PREFIX}terminated`);
  assert.equal(pool.calls(), 1);
});

test("아무것도 안 나간 연결 실패는 같은 계정으로 즉시 한 번 더 시도한다", async () => {
  const pool = scriptedPool([
    [{ type: "error", reason: "error", error: assistantError("Connection error.") }],
    [{ type: "start" }, { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } }],
  ]);
  const events = await drainEvents(pool.stream);
  assert.equal(pool.calls(), 2);
  assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
});

test("start 만 나간 뒤의 실패는 즉시 재시도하지 않는다 — context 에 부분 메시지가 두 번 남지 않게", async () => {
  const failed = assistantError("Request timed out.");
  const pool = scriptedPool([
    [{ type: "start" }, { type: "error", reason: "error", error: failed }],
    [{ type: "start" }, { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop" } }],
  ]);
  const events = await drainEvents(pool.stream);
  assert.equal(pool.calls(), 1);
  assert.deepEqual(events.map((event) => event.type), ["start", "error"], "start 는 한 번뿐이다");
  assert.equal(events.at(-1).error, failed);
  assert.equal(events.at(-1).error.errorMessage, "Request timed out.");
});

test("즉시 재시도를 다 써도 마지막 시도의 원래 메시지로 끝난다", async () => {
  const second = assistantError("Request timed out.");
  const pool = scriptedPool([
    [{ type: "error", reason: "error", error: assistantError("Request timed out.") }],
    [{ type: "error", reason: "error", error: second }],
  ]);
  const events = await drainEvents(pool.stream);
  assert.equal(pool.calls(), 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].error, second, "lazyStream 이 빈 메시지를 새로 만들지 않도록 던지지 않는다");
  assert.equal(events[0].error.usage.input, 1200);
});
