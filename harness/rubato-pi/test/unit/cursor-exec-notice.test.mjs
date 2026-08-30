import assert from "node:assert/strict";
import test from "node:test";

import { cursorExecUnresolvedNotice, registerCursorExecNotice } from "../../src/cursor-exec-notice.mjs";

// journal 은 `executing` 중 죽은 호출을 `unknown` 으로 정착시키고 자동 재실행하지 않는다.
// 그 판정은 정확하지만 그것만으로는 아무도 모른다 — 같은 `toolCallId` 가 우연히 재전달될
// 때까지 보이지 않는다. 이 알림이 그 창을 닫는다. 세션 시작 경로에 붙는 코드이므로 조용히
// 깨지면 아무도 모르고, 그래서 시험이 필요하다.

function recordingPi() {
  const handlers = new Map();
  return { on: (name, handler) => handlers.set(name, handler), handlers };
}

function ctxWith(sessionId, notified) {
  return {
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message, level) => notified.push({ message, level }) },
  };
}

test("미해결 항목이 있으면 세션 시작에 한 줄 알린다", async () => {
  const pi = recordingPi();
  const notified = [];
  registerCursorExecNotice(pi, { notice: async () => "one tool call is unresolved" });
  await pi.handlers.get("session_start")({}, ctxWith("s1", notified));
  assert.equal(notified.length, 1);
  assert.equal(notified[0].message, "one tool call is unresolved");
  // 잘못한 사람이 없으므로 warning 이 아니다.
  assert.equal(notified[0].level, "info");
});

test("미해결이 없으면 아무 말도 하지 않는다", async () => {
  const pi = recordingPi();
  const notified = [];
  registerCursorExecNotice(pi, { notice: async () => undefined });
  await pi.handlers.get("session_start")({}, ctxWith("s1", notified));
  assert.deepEqual(notified, []);
});

test("같은 세션에서 두 번 알리지 않는다", async () => {
  const pi = recordingPi();
  const notified = [];
  registerCursorExecNotice(pi, { notice: async () => "unresolved" });
  const ctx = ctxWith("s1", notified);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(notified.length, 1);
});

test("한 프로세스의 다른 세션은 각자 한 번 본다", async () => {
  const pi = recordingPi();
  const notified = [];
  registerCursorExecNotice(pi, { notice: async () => "unresolved" });
  await pi.handlers.get("session_start")({}, ctxWith("s1", notified));
  await pi.handlers.get("session_start")({}, ctxWith("s2", notified));
  assert.equal(notified.length, 2);
});

test("journal 모듈이 없어도 세션을 막지 않는다", async () => {
  const message = await cursorExecUnresolvedNotice({
    load: async () => {
      throw new Error("no journal module");
    },
  });
  assert.equal(message, undefined);
});

test("시작 알림은 도구 호출 없이 죽은 executing 을 정착시켜 말한다", async () => {
  let settleCalls = 0;
  let unresolvedCalls = 0;
  const message = await cursorExecUnresolvedNotice({
    load: async () => ({
      createCursorExecJournal: () => ({
        settleAndListUnresolved() {
          settleCalls += 1;
          return {
            unreadable: false,
            settled: [{ state: "unknown", toolName: "bash" }],
            unresolved: [{ state: "unknown", toolName: "bash" }],
          };
        },
        unresolved() {
          unresolvedCalls += 1;
          return [];
        },
      }),
      formatCursorExecUnresolvedNotice(entries) {
        return entries.length === 0 ? undefined : `unresolved:${entries[0].toolName}`;
      },
    }),
  });
  assert.equal(message, "unresolved:bash");
  assert.equal(settleCalls, 1);
  assert.equal(unresolvedCalls, 0);
});

test("읽을 수 없는 journal 은 실행을 막는 사실을 한 줄로 말한다", async () => {
  const message = await cursorExecUnresolvedNotice({
    load: async () => ({
      createCursorExecJournal: () => ({
        settleAndListUnresolved() {
          return { unreadable: true, reason: "the exec journal is present but is not valid JSON", settled: [], unresolved: [] };
        },
      }),
      formatCursorExecUnreadableNotice(reason) {
        return `unreadable:${reason}`;
      },
    }),
  });
  assert.equal(message, "unreadable:the exec journal is present but is not valid JSON");
});

test("pi 가 on 을 주지 않으면 조용히 지나간다", () => {
  assert.doesNotThrow(() => registerCursorExecNotice({}, { notice: async () => "x" }));
  assert.doesNotThrow(() => registerCursorExecNotice(undefined, { notice: async () => "x" }));
});
