import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTIGRAVITY_LINEAGE_STATE_CAP,
  ANTIGRAVITY_PROFILE_STATE_CAP,
  ANTIGRAVITY_STATE_TTL_MS,
  ANTIGRAVITY_UNKNOWN_BRANCH,
  AntigravityStateCapError,
  AntigravityStateClosedError,
  createAntigravityLineageTracker,
  createAntigravityStateStore,
  nextAntigravityEnvelope,
} from "../../src/antigravity-state.mjs";

const key = Object.freeze({
  profileId: "/tmp/rubato-antigravity-test-profile",
  providerId: "google-antigravity",
  modelId: "gemini-3.7-flash",
  sessionId: "session-a",
  branchId: "leaf-a",
  conversationGeneration: 0,
});

function deferred() {
  let resolve;
  let settled = false;
  const promise = new Promise((done) => {
    resolve = (value) => {
      settled = true;
      done(value);
    };
  });
  return { promise, resolve, get settled() { return settled; } };
}

test("정상 turn 세 개가 같은 envelope state를 이어 쓴다", async () => {
  const store = createAntigravityStateStore();
  const seen = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    await store.run(key, async (state) => {
      const envelope = nextAntigravityEnvelope(state, turn);
      seen.push({ state, envelope });
      state.lastExecutionId = `response-${turn}`;
    });
  }

  assert.equal(new Set(seen.map((entry) => entry.state)).size, 1, "정상 종료가 state를 버렸다");
  assert.deepEqual(seen.map((entry) => entry.envelope.labels.last_step_index), ["1", "2", "3"]);
  assert.deepEqual(seen.map((entry) => entry.envelope.labels.last_execution_id), [undefined, "response-1", "response-2"]);
  assert.equal(store.size(key.profileId), 1);
});

test("A 실행 중 B가 취소돼도 C는 A를 추월하지 않는다", async () => {
  const store = createAntigravityStateStore();
  const releaseA = deferred();
  const order = [];
  const a = store.run(key, async () => {
    order.push("A:start");
    await releaseA.promise;
    order.push("A:end");
  });

  await Promise.resolve();
  const controller = new AbortController();
  const b = store.run(key, async () => order.push("B:ran"), { signal: controller.signal });
  const bOutcome = b.then(() => "resolved", (error) => error.name);
  const c = store.run(key, async () => order.push("C:ran"));
  controller.abort();

  assert.equal(await bOutcome, "AbortError", "줄에서 취소된 B가 즉시 끝나지 않았다");
  assert.deepEqual(order, ["A:start"], "C가 A와 나란히 실행됐다");
  releaseA.resolve();
  await Promise.all([a, c]);
  assert.deepEqual(order, ["A:start", "A:end", "C:ran"]);
});

test("live lineage를 drop하면 tombstone이 새 admission을 막는다", async () => {
  const store = createAntigravityStateStore();
  const release = deferred();
  const active = store.run(key, async () => release.promise);
  await Promise.resolve();

  assert.equal(store.drop(key), true);
  assert.equal(store.admits(key), false);
  await assert.rejects(store.run(key, async () => {}), AntigravityStateClosedError);
  release.resolve();
  await active;
  assert.equal(store.size(key.profileId), 0, "마지막 lease 뒤 tombstone이 남았다");
});

test("clear도 live state를 즉시 지우지 않고 tombstone으로 닫는다", async () => {
  const store = createAntigravityStateStore();
  const release = deferred();
  const active = store.run(key, async () => release.promise);
  await Promise.resolve();
  store.clear();
  assert.equal(store.size(), 1);
  assert.equal(store.admits(key), false);
  release.resolve();
  await active;
  assert.equal(store.size(), 0);
});

test("lineage tracker는 session start leaf를 seed하고 tree와 generation을 분리한다", () => {
  const tracker = createAntigravityLineageTracker();
  assert.equal(tracker.branchOf("s"), ANTIGRAVITY_UNKNOWN_BRANCH);
  tracker.seed("s", "leaf-1");
  assert.equal(tracker.branchOf("s"), "leaf-1");
  assert.equal(tracker.generationOf("s"), 0);
  tracker.onTree("s", "leaf-2");
  assert.equal(tracker.branchOf("s"), "leaf-2");
  assert.equal(tracker.generationOf("s"), 1);
  tracker.onGenerationChange("s");
  assert.equal(tracker.generationOf("s"), 2);
});

function keyAt(overrides) {
  return { ...key, ...overrides };
}

function snapshotIds(state) {
  return { sessionId: state.sessionId, lastExecutionId: state.lastExecutionId };
}

// Design: "profile 전체 64개, lineage당 4개를 상한으로 하고 … 상한을 넘으면 기존 state를 추측하지 않고 fail closed한다."
test("profile 64개와 lineage 4개 상한은 기존 state를 재사용하지 않고 fail closed한다", async () => {
  const store = createAntigravityStateStore();
  const existing = [];
  for (let i = 0; i < ANTIGRAVITY_PROFILE_STATE_CAP; i += 1) {
    await store.run(keyAt({ sessionId: `cap-session-${i}` }), async (state) => {
      state.lastExecutionId = `exec-${i}`;
      existing.push(snapshotIds(state));
    });
  }
  const beforeOverflow = existing.map((entry) => entry.sessionId);
  await assert.rejects(
    store.run(keyAt({ sessionId: "cap-session-overflow" }), async (state) => {
      existing.push(snapshotIds(state));
    }),
    (error) => error instanceof AntigravityStateCapError && error.scope === "profile" && error.cap === ANTIGRAVITY_PROFILE_STATE_CAP,
  );
  assert.equal(store.size(key.profileId), ANTIGRAVITY_PROFILE_STATE_CAP);
  assert.equal(existing.length, ANTIGRAVITY_PROFILE_STATE_CAP, "overflow 호출이 기존 sessionId를 재사용했다");
  assert.deepEqual(existing.map((entry) => entry.sessionId), beforeOverflow);
  await store.run(keyAt({ sessionId: "cap-session-0" }), async (state) => {
    assert.equal(state.sessionId, existing[0].sessionId);
    assert.equal(state.lastExecutionId, existing[0].lastExecutionId);
  });

  const lineageStore = createAntigravityStateStore();
  const lineageExisting = [];
  for (let i = 0; i < ANTIGRAVITY_LINEAGE_STATE_CAP; i += 1) {
    await lineageStore.run(keyAt({ branchId: `leaf-${i}`, conversationGeneration: i }), async (state) => {
      state.lastExecutionId = `lineage-exec-${i}`;
      lineageExisting.push(snapshotIds(state));
    });
  }
  const lineageBefore = lineageExisting.map((entry) => ({ sessionId: entry.sessionId, lastExecutionId: entry.lastExecutionId }));
  await assert.rejects(
    lineageStore.run(keyAt({ branchId: "leaf-overflow", conversationGeneration: ANTIGRAVITY_LINEAGE_STATE_CAP }), async (state) => {
      lineageExisting.push(snapshotIds(state));
    }),
    (error) => error instanceof AntigravityStateCapError && error.scope === "session lineage" && error.cap === ANTIGRAVITY_LINEAGE_STATE_CAP,
  );
  assert.equal(lineageStore.size(key.profileId), ANTIGRAVITY_LINEAGE_STATE_CAP);
  assert.equal(lineageExisting.length, ANTIGRAVITY_LINEAGE_STATE_CAP, "lineage overflow가 기존 lastExecutionId를 재사용했다");
  assert.deepEqual(
    lineageExisting.map((entry) => ({ sessionId: entry.sessionId, lastExecutionId: entry.lastExecutionId })),
    lineageBefore,
  );
  await lineageStore.run(keyAt({ branchId: "leaf-0", conversationGeneration: 0 }), async (state) => {
    assert.equal(state.sessionId, lineageExisting[0].sessionId);
    assert.equal(state.lastExecutionId, lineageExisting[0].lastExecutionId);
  });
});

// Design: "30분 idle TTL … 붙잡고 있는 호출이 있으면 절대 지우지 않는다."
test("30분 idle TTL은 빈 항목만 회수하고 live·waiter는 보호한다", async () => {
  let nowMs = 1_000;
  const store = createAntigravityStateStore({ now: () => nowMs });
  const idleKey = keyAt({ sessionId: "idle" });
  const liveKey = keyAt({ sessionId: "live" });
  const waiterKey = keyAt({ sessionId: "waiter" });

  let idleSessionId;
  await store.run(idleKey, async (state) => { idleSessionId = state.sessionId; });
  assert.equal(store.size(idleKey.profileId), 1);

  const holdLive = deferred();
  const live = store.run(liveKey, async () => holdLive.promise);
  await Promise.resolve();

  const holdFirst = deferred();
  const first = store.run(waiterKey, async () => holdFirst.promise);
  await Promise.resolve();
  const holdWaiter = deferred();
  const waiter = store.run(waiterKey, async () => holdWaiter.promise);
  await Promise.resolve();

  nowMs += ANTIGRAVITY_STATE_TTL_MS + 1;
  // 다른 key 의 run 이 acquire 에서 sweep 을 탄다. idle 만 사라지고 live·waiter 는 남는다.
  await store.run(keyAt({ sessionId: "probe" }), async () => {});
  assert.equal(store.size(idleKey.profileId), 3, "idle 항목이 남았거나 live/waiter가 회수됐다");
  assert.equal(store.sweep(idleKey.profileId), 0, "live 또는 waiter 항목이 TTL sweep 에 회수됐다");
  await store.run(idleKey, async (state) => {
    assert.notEqual(state.sessionId, idleSessionId, "TTL 뒤에도 옛 idle sessionId 가 재사용됐다");
  });

  holdLive.resolve();
  holdFirst.resolve();
  holdWaiter.resolve();
  await Promise.all([live, first, waiter]);
});

// Design: "같은 session의 두 branch를 병렬 실행해도 state가 서로 섞이지 않는다."
test("같은 session의 두 branch는 병렬로 돌고 envelope와 lastExecutionId를 공유하지 않는다", async () => {
  const store = createAntigravityStateStore();
  const leafA = keyAt({ branchId: "leaf-a" });
  const leafB = keyAt({ branchId: "leaf-b" });
  const aEntered = deferred();
  const bEntered = deferred();
  const release = deferred();

  const a = store.run(leafA, async (state) => {
    aEntered.resolve();
    // B 가 이미 fn 안에 들어와야 직렬화가 아님을 증명한다. 같은 lineage 면 여기서 영원히 막힌다.
    await bEntered.promise;
    state.lastExecutionId = "exec-a";
    const envelope = nextAntigravityEnvelope(state, 1);
    await release.promise;
    return { sessionId: envelope.sessionId, lastExecutionId: state.lastExecutionId };
  });
  const b = store.run(leafB, async (state) => {
    bEntered.resolve();
    await aEntered.promise;
    state.lastExecutionId = "exec-b";
    const envelope = nextAntigravityEnvelope(state, 1);
    await release.promise;
    return { sessionId: envelope.sessionId, lastExecutionId: state.lastExecutionId };
  });

  await Promise.race([
    Promise.all([aEntered.promise, bEntered.promise]),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("한 branch가 다른 branch의 차례를 기다렸다")), 1000);
    }),
  ]);
  assert.equal(aEntered.settled && bEntered.settled, true, "한 branch가 다른 branch의 차례를 기다렸다");
  release.resolve();
  const [aResult, bResult] = await Promise.all([a, b]);
  assert.notEqual(aResult.sessionId, bResult.sessionId);
  assert.notEqual(aResult.lastExecutionId, bResult.lastExecutionId);
  assert.equal(aResult.lastExecutionId, "exec-a");
  assert.equal(bResult.lastExecutionId, "exec-b");
});
