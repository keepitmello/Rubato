import assert from "node:assert/strict";
import test from "node:test";

import { createLineReader, createRpcWaiter } from "../smoke/rpc-waiter.mjs";

// 실 vendor 스모크 러너가 세션과 주고받는 큐다. 러너 자신이 검증 도구이므로 여기가 틀리면
// 모든 gate 판정이 흔들린다. 실제로 두 방향으로 틀릴 수 있고, 둘 다 겪었다:
//
//   - 백로그를 안 보면 이미 온 응답을 영원히 기다린다 → 통과한 gate 를 FAIL 로 적는다
//   - 집은 것을 소비하지 않으면 다음 턴이 앞 턴의 종료를 집는다 → 깨진 gate 를 PASS 로 적는다
//
// 두 번째가 더 위험하다. 그래서 둘을 같이 고정한다.

test("구독보다 먼저 온 레코드도 받는다", async () => {
  const wait = createRpcWaiter();
  // 응답이 먼저 도착한다 — 앞선 대기가 시간을 넘겨 fallback 으로 넘어간 상황이다.
  wait.push({ type: "response", command: "get_state", id: "st" });
  const got = await wait((rec) => rec.type === "response" && rec.command === "get_state", 1000, "get_state");
  assert.equal(got.id, "st");
});

test("한 레코드는 한 번만 소비된다 — 다음 턴이 앞 턴의 종료를 집지 않는다", async () => {
  const wait = createRpcWaiter();
  const isEnd = (rec) => rec.type === "agent_end" && rec.willRetry !== true;

  wait.push({ type: "agent_end", turn: 1 });
  const first = await wait(isEnd, 1000, "agent_end:1");
  assert.equal(first.turn, 1);

  // 2턴째는 1턴의 종료를 다시 집어서는 안 된다. 집으면 3턴 이어짐 gate 가 거짓 통과한다.
  await assert.rejects(wait(isEnd, 50, "agent_end:2"), /timeout waiting for agent_end:2/);

  // 실제 2턴 종료가 오면 그것을 받는다.
  const secondP = wait(isEnd, 1000, "agent_end:2");
  wait.push({ type: "agent_end", turn: 2 });
  assert.equal((await secondP).turn, 2);
});

test("라이브로 건넨 레코드는 백로그에 남지 않는다", async () => {
  const wait = createRpcWaiter();
  const isEnd = (rec) => rec.type === "agent_end";
  const pending = wait(isEnd, 1000, "agent_end");
  wait.push({ type: "agent_end", turn: 1 });
  await pending;
  // 같은 레코드를 백로그에서 또 꺼낼 수 있으면 두 번 소비된다.
  await assert.rejects(wait(isEnd, 50, "agent_end:again"), /timeout/);
});

test("willRetry 인 종료는 매치하지 않고 백로그에 남는다", async () => {
  const wait = createRpcWaiter();
  wait.push({ type: "agent_end", willRetry: true });
  await assert.rejects(
    wait((rec) => rec.type === "agent_end" && rec.willRetry !== true, 50, "agent_end"),
    /timeout/,
  );
});

test("대기 중 취소된 것은 큐를 막지 않는다", async () => {
  const wait = createRpcWaiter();
  await assert.rejects(wait((rec) => rec.type === "never", 30, "never"), /timeout/);
  // 시간을 넘긴 대기자가 남아 있으면 뒤 레코드를 그것이 삼킨다.
  wait.push({ type: "response", command: "get_state" });
  const got = await wait((rec) => rec.command === "get_state", 1000, "get_state");
  assert.equal(got.command, "get_state");
});

test("줄 단위 판독기는 쪼개진 청크와 깨진 줄을 견딘다", async () => {
  const wait = createRpcWaiter();
  const read = createLineReader(wait.push);
  read('{"type":"a"}\n{"type"');
  read(':"b"}\nnot json\n{"type":"c"}\r\n');
  const a = await wait((rec) => rec.type === "a", 100, "a");
  const b = await wait((rec) => rec.type === "b", 100, "b");
  const c = await wait((rec) => rec.type === "c", 100, "c");
  assert.deepEqual([a.type, b.type, c.type], ["a", "b", "c"]);
});
