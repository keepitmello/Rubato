// `withRubatoStream` 의 계약.
//
// 이 decorator 는 transport 가 아니다. native stream 을 그대로 위임하면서 Rubato
// 고유 의미(계측 한 번, timing, provider 실행 뒤 재시도 금지, 중단 정착)만 얹는다. 그래서
// 여기서 지키는 것은 "무엇을 더 하는가"보다 **무엇을 잃지 않는가**다.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { senpiDir, senpiNested } from "../../src/engine-paths.mjs";
import {
  kRubatoStream,
  measurementBodyFromContext,
  settleAbortedToolUse,
  withRubatoStream,
  wrapProviderStreams,
} from "../../src/rubato-stream.mjs";

// 실제 엔진이 쓰는 stream 구현으로 위임을 검사한다. 손으로 만든 대역은
// hasPendingLocalWork/result 의 실제 의미를 갖지 않는다.
const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/index.js")).href
);
// exec-resolved 표지는 pi-ai 의 module-local Symbol 이다. 테스트도 지어내지 않고
// 설치본에서 가져와야 "실제로 걸러지는가"를 검사한 것이 된다.
const { kCursorExecResolved } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/utils/block-symbols.js")).href
);
const { AgentSession } = await import(
  pathToFileURL(join(senpiDir, "dist/core/agent-session.js")).href
);

const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
const context = { messages: [] };

function recorderSpy() {
  const calls = { startCall: 0, firstOutput: 0, endCall: 0, endFields: [], reinsertions: [] };
  return {
    calls,
    activeTaskId: () => "task-1",
    startCall: () => { calls.startCall += 1; return { callId: "call-1" }; },
    firstOutput: () => { calls.firstOutput += 1; },
    endCall: (_callId, fields) => { calls.endCall += 1; calls.endFields.push(fields); },
    observeToolReinsertion: (fields) => { calls.reinsertions.push(fields); },
  };
}

function assistant(overrides = {}) {
  return { role: "assistant", content: [], stopReason: "pending", ...overrides };
}

/** 이벤트 목록을 그대로 흘리고 끝나는 native 대역. */
function scriptedStream(events, { result } = {}) {
  return () => {
    const stream = createAssistantMessageEventStream();
    ;(async () => {
      for (const event of events) stream.push(event);
      stream.end(result);
    })();
    return stream;
  };
}

async function drain(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("한 logical call 에 startCall/endCall 이 각각 한 번이다 — streamSimple 이 내부에서 stream 을 불러도", async () => {
  // pinned provider-composer 는 streamSimple 이 없으면 stream 으로 내려가고,
  // provider 구현이 자기 streamSimple 에서 자기 stream 을 다시 부를 수도 있다.
  // 둘 다 감싸도 계측은 가장 밖의 경계 하나만 소유해야 한다.
  const recorder = recorderSpy();
  const api = {};
  api.stream = (m, c, options) => scriptedStream([
    { type: "start", partial: assistant() },
    { type: "text_delta", contentIndex: 0, delta: "hi" },
    { type: "done", reason: "stop", message: assistant({ stopReason: "stop", content: [{ type: "text", text: "hi" }] }) },
  ])(m, c, options);
  // 내부 재진입: streamSimple 이 감싸진 stream 을 그대로 다시 부른다.
  api.streamSimple = (m, c, options) => wrapped.api.stream(m, c, options);

  const provider = { id: "openai-codex", api };
  const wrapped = wrapProviderStreams(provider);

  const events = await drain(wrapped.api.streamSimple(model, context, { measurementRecorder: recorder, sessionId: "s1" }));

  assert.equal(events.at(-1).type, "done");
  assert.equal(recorder.calls.startCall, 1, "logical call 하나에 model.send 는 한 번이다");
  assert.equal(recorder.calls.endCall, 1, "logical call 하나에 model.end 는 한 번이다");
  assert.equal(recorder.calls.firstOutput, 1, "firstOutput 은 recorder 가 한 번만 기록한다");
});

test("같은 함수를 두 번 감싸면 같은 함수다", () => {
  const once = withRubatoStream(scriptedStream([]));
  assert.equal(withRubatoStream(once), once);
  assert.equal(once[kRubatoStream], true);
});

test("이미 감싼 provider 를 다시 등록하면 실패한다", () => {
  const provider = { id: "xai", api: { stream: scriptedStream([]), streamSimple: scriptedStream([]) } };
  const wrapped = wrapProviderStreams(provider);
  assert.throws(() => wrapProviderStreams(wrapped), /already wrapped/);
});

test("pinned native provider 모양(top-level stream, api 없음)을 감싼다", async () => {
  // 진짜 `openaiCodexProvider()`·`xaiProvider()` 는 `stream`/`streamSimple` 을
  // provider 객체에 바로 달고 나오고 `api` 필드가 없다. 그 모양을 그대로 둔다.
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "stop" });
  const native = {
    id: "openai-codex",
    name: "OpenAI Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    headers: { "user-agent": "pinned" },
    auth: { oauth: { name: "ChatGPT" } },
    getModels: () => [{ id: "gpt-5.6-sol" }],
    refreshModels: async () => [],
    filterModels: (models) => models,
    stream: scriptedStream([{ type: "done", reason: "stop", message }], { result: message }),
    streamSimple: scriptedStream([{ type: "done", reason: "stop", message }], { result: message }),
  };
  assert.equal(native.api, undefined, "전제: pinned native provider 는 api 필드가 없다");

  const wrapped = wrapProviderStreams(native);

  // 감싸는 것이 provider 의 정체를 바꾸지 않는다.
  assert.equal(wrapped.id, "openai-codex");
  assert.equal(wrapped.name, "OpenAI Codex");
  assert.equal(wrapped.baseUrl, "https://chatgpt.com/backend-api");
  assert.deepEqual(wrapped.headers, { "user-agent": "pinned" });
  assert.equal(wrapped.auth, native.auth);
  assert.equal(wrapped.refreshModels, native.refreshModels);
  assert.equal(wrapped.filterModels, native.filterModels);
  assert.deepEqual(wrapped.getModels(), [{ id: "gpt-5.6-sol" }]);
  assert.equal(wrapped.api, undefined, "없던 api 필드를 지어내지 않는다");

  // 둘 다 감쌌고, 원본과 다른 함수다.
  assert.notEqual(wrapped.streamSimple, native.streamSimple);
  assert.notEqual(wrapped.stream, native.stream);
  assert.equal(wrapped.streamSimple[kRubatoStream], true);
  assert.equal(wrapped.stream[kRubatoStream], true);

  // 그리고 실제로 돌면 계측이 한 번 붙는다.
  await drain(wrapped.streamSimple(model, context, { measurementRecorder: recorder, env: {} }));
  assert.equal(recorder.calls.startCall, 1);
  assert.equal(recorder.calls.endCall, 1);

  assert.throws(() => wrapProviderStreams(wrapped), /already wrapped/, "native 모양도 재등록을 막는다");
});

test("createProvider 모양(api.stream)도 그대로 감싼다", () => {
  const provider = { id: "rubato-engine", api: { stream: scriptedStream([]), streamSimple: scriptedStream([]) } };
  const wrapped = wrapProviderStreams(provider);
  assert.equal(wrapped.api.stream[kRubatoStream], true);
  assert.equal(wrapped.api.streamSimple[kRubatoStream], true);
});

test("stream 면이 없는 provider 는 사유를 말하고 실패한다", () => {
  assert.throws(() => wrapProviderStreams({ id: "kiro" }), /exposes no stream to wrap/);
});

test("timing 은 성공 턴에만 붙고 벽시계/단조시계를 주입받는다", async () => {
  const times = [100, 350, 350, 600];
  const message = assistant({ stopReason: "stop" });
  const inner = scriptedStream([
    { type: "start", partial: message },
    { type: "text_delta", contentIndex: 0, delta: "hi" },
    { type: "done", reason: "stop", message },
  ]);
  const last = (await drain(withRubatoStream(inner)(model, context, {
    env: {},
    monotonic: () => times.shift(),
    wallNow: () => 1_700_000_000_000,
    processStartedAt: 1234,
  }))).at(-1);
  assert.deepEqual(last.message.timing, {
    sentAt: 1_700_000_000_000,
    processStartedAt: 1234,
    ttftMs: 250,
    waitMs: 250,
    modelDurationMs: 500,
  });
});

test("provider tool 실행이 없는 오류는 text delta 뒤에도 재시도 가능하다", async () => {
  const before = assistant({ stopReason: "error", errorMessage: "terminated" });
  const beforeLast = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: before },
    { type: "error", reason: "error", error: before },
  ]))(model, context, { env: {} }))).at(-1);
  assert.equal(beforeLast.error.errorMessage, "terminated");
  assert.equal(beforeLast.error.timing, undefined, "실패한 시도는 표시 timing 을 갖지 않는다");

  const after = assistant({ stopReason: "error", errorMessage: "terminated" });
  const afterLast = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: after },
    { type: "text_delta", contentIndex: 0, delta: "안녕" },
    { type: "error", reason: "error", error: after },
  ]))(model, context, { env: {} }))).at(-1);
  assert.equal(afterLast.error.errorMessage, "terminated");
});

test("사고나 text delta 뒤 WebSocket 오류는 실제 AgentSession 제한 재시도로 넘어간다", async () => {
  const thinking = assistant({ stopReason: "error", errorMessage: "WebSocket error" });
  const thinkingLast = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: thinking },
    { type: "thinking_delta", contentIndex: 0, delta: "생각" },
    { type: "error", reason: "error", error: thinking },
  ]))(model, context, { env: {} }))).at(-1);
  assert.equal(thinkingLast.error.errorMessage, "WebSocket error");

  const afterText = assistant({ stopReason: "error", errorMessage: "WebSocket error" });
  const afterTextLast = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: afterText },
    { type: "thinking_delta", contentIndex: 0, delta: "생각" },
    { type: "text_delta", contentIndex: 1, delta: "안녕" },
    { type: "error", reason: "error", error: afterText },
  ]))(model, context, { env: {} }))).at(-1);
  assert.equal(afterTextLast.error.errorMessage, "WebSocket error");
  assert.equal(
    AgentSession.prototype._isRetryableError.call(
      { model: { contextWindow: 200_000 } },
      {
        ...afterTextLast.error,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    ),
    true,
    "decorator가 접두사를 빼면 실제 AgentSession이 제한 재시도를 맡아야 한다",
  );
});

test("Cursor tool 실행 표지는 future projector가 terminal block을 잃어도 latch에 남는다", async () => {
  // pinned Cursor는 partial과 terminal에 같은 message 객체를 쓴다. split-object는
  // 앞으로 stream projector가 block을 다시 만들더라도 fail-open하지 않게 하는 계약이다.
  const executed = {
    type: "toolCall",
    id: "t1",
    name: "read_file",
    arguments: { path: "/tmp/a" },
    [kCursorExecResolved]: true,
  };
  const partial = assistant({ content: [executed] });
  const message = assistant({
    stopReason: "error",
    errorMessage: "WebSocket error",
  });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial },
    { type: "toolcall_start", contentIndex: 0, partial },
    { type: "toolcall_end", contentIndex: 0, toolCall: executed, partial },
    { type: "error", reason: "error", error: message },
  ]))(model, context, { env: {} }))).at(-1);

  assert.equal(last.error.errorMessage, "senpi:no-turn-retry:WebSocket error");
  assert.equal(
    AgentSession.prototype._isRetryableError.call(
      { model: { contextWindow: 200_000 } },
      {
        ...last.error,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    ),
    false,
    "provider가 이미 실행한 tool은 실제 AgentSession에서도 재시도하면 안 된다",
  );
});

test("사용자 중단 + 완성된 미실행 tool 은 toolUse 로 정착한다", async () => {
  const signal = AbortSignal.abort();
  const message = assistant({
    stopReason: "error",
    errorMessage: "aborted",
    content: [{ type: "toolCall", id: "t1", name: "ls", arguments: {}, partialJson: '{"path":"/tmp"}' }],
  });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "error", reason: "aborted", error: message },
  ]))(model, context, { env: {}, signal }))).at(-1);
  assert.equal(last.type, "done");
  assert.equal(last.message.stopReason, "toolUse");
  assert.deepEqual(last.message.content[0].arguments, { path: "/tmp" });
  assert.equal(last.message.errorMessage, undefined);
  assert.equal(last.message.timing, undefined, "중단 턴은 성공 턴의 속도를 덮지 않는다");
});

test("중단이 아닌 전송 실패는 도구가 있어도 성공으로 바꾸지 않는다", async () => {
  const message = assistant({
    stopReason: "error",
    errorMessage: "terminated",
    content: [{ type: "toolCall", id: "t1", name: "ls", arguments: {}, partialJson: '{"path":"/tm' }],
  });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/tm' },
    { type: "error", reason: "error", error: message },
  ]))(model, context, { env: {} }))).at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.error.errorMessage, "terminated");
  assert.equal(last.error.content[0].partialJson, '{"path":"/tm', "잘린 tool을 성공으로 정착시키면 안 된다");
  assert.equal(
    AgentSession.prototype._isRetryableError.call(
      { model: { contextWindow: 200_000 } },
      {
        ...last.error,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    ),
    true,
    "실행되지 않은 일반 toolCall은 실제 AgentSession의 제한 재시도로 넘어가야 한다",
  );
});

test("pi-ai 가 표지한 exec-resolved block 은 실행할 tool 로 세지 않는다", () => {
  // 표지는 설치본의 module-local Symbol 이다. 우리가 Symbol.for 로 지어낸 것은
  // 절대 일치하지 않으므로, 여기서 실제 표지를 그대로 얹어 검사한다.
  const resolved = { type: "toolCall", id: "t1", name: "read_file", arguments: { path: "/a" }, [kCursorExecResolved]: true };
  const message = assistant({ stopReason: "aborted", errorMessage: "aborted", content: [resolved] });
  assert.equal(settleAbortedToolUse(message), false, "이미 실행된 tool 은 되살릴 대상이 아니다");
  assert.equal(message.stopReason, "aborted");
  assert.equal(message.errorMessage, "aborted");

  const mixed = assistant({
    stopReason: "aborted",
    content: [resolved, { type: "toolCall", id: "t2", name: "bash", arguments: { cmd: "ls" } }],
  });
  assert.equal(settleAbortedToolUse(mixed), true, "미실행 tool 이 하나라도 있으면 정착한다");
  assert.equal(mixed.stopReason, "toolUse");
});

test("exec-resolved block 만 남은 중단은 toolUse 로 바뀌지 않는다", async () => {
  const signal = AbortSignal.abort();
  const message = assistant({
    stopReason: "aborted",
    errorMessage: "aborted",
    content: [{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "/a" }, [kCursorExecResolved]: true }],
  });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "error", reason: "aborted", error: message },
  ]))(model, context, { env: {}, signal }))).at(-1);
  assert.equal(last.type, "error", "실행할 tool 이 없는 턴을 성공으로 넘기면 agent loop 가 같은 tool 을 다시 실행한다");
  assert.equal(last.error.stopReason, "aborted", "toolUse 로 재분료하지 않는다");
  assert.ok(last.error.errorMessage, "errorMessage 를 지우면 엔진이 성공으로 읽는다");
  assert.ok(
    last.error.errorMessage.startsWith("senpi:no-turn-retry:"),
    "사용자가 멈춘 턴은 재시도 대상이 아니다",
  );
});

test("델타 전 중단도 재시도하지 않고, provider 가 error 로 라벨해도 aborted 로 남는다", async () => {
  // 중단은 전송 실패가 아니다. 델타가 없었다는 이유로 재시도를 허용하면
  // 엔진이 사용자가 지운 직업을 부족함 없이 다시 보낼 수 있다.
  const signal = AbortSignal.abort();
  const message = assistant({ stopReason: "error", errorMessage: "Request was aborted" });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ]))(model, context, { env: {}, signal }))).at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.error.stopReason, "aborted");
  assert.equal(last.error.errorMessage, "senpi:no-turn-retry:Request was aborted");
});

test("중단이 아닌 델타 전 전송 실패는 여전히 재시도 가능한 error 다", async () => {
  const message = assistant({ stopReason: "error", errorMessage: "terminated" });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ]))(model, context, { env: {} }))).at(-1);
  assert.equal(last.error.stopReason, "error");
  assert.equal(last.error.errorMessage, "terminated");
});

test("result() 는 원본 결과를 돌려주고 계측은 여전히 한 번이다", async () => {
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "stop" });
  const stream = withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "done", reason: "stop", message },
  ], { result: message }))(model, context, { measurementRecorder: recorder, env: {} });
  await drain(stream);
  assert.equal(await stream.result(), message);
  assert.equal(recorder.calls.endCall, 1);
});

test("iteration 없이 result() 만 기다린 소비자도 계측을 받는다", async () => {
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "stop" });
  const stream = withRubatoStream(scriptedStream([
    { type: "done", reason: "stop", message },
  ], { result: message }))(model, context, { measurementRecorder: recorder, env: {} });
  assert.equal(await stream.result(), message);
  assert.equal(recorder.calls.startCall, 1);
  assert.equal(recorder.calls.endCall, 1);
});

test("stream 제어면과 options 가 원본으로 그대로 간다", async () => {
  let seen;
  const inner = (m, c, options) => {
    seen = options;
    return scriptedStream([{ type: "done", reason: "stop", message: assistant({ stopReason: "stop" }) }])(m, c, options);
  };
  const signal = new AbortController().signal;
  const execHandlers = { read_file: () => {} };
  const onToolResult = () => {};
  const onPayload = (body) => body;
  const stream = withRubatoStream(inner)(model, context, {
    env: {},
    signal,
    execHandlers,
    onToolResult,
    onPayload,
    sessionId: "session-9",
    thinkingSelection: "xhigh",
  });
  await drain(stream);
  assert.equal(seen.signal, signal);
  assert.equal(seen.execHandlers, execHandlers);
  assert.equal(seen.onToolResult, onToolResult);
  assert.equal(seen.onPayload, onPayload);
  assert.equal(seen.sessionId, "session-9");
  assert.equal(seen.thinkingSelection, "xhigh", "provider 고유 옵션(xhigh)도 손대지 않는다");
});

test("async iterator 의 return 이 원본으로 전파된다", async () => {
  let returned = false;
  const inner = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: assistant() });
    const base = stream[Symbol.asyncIterator]();
    stream[Symbol.asyncIterator] = () => ({
      next: () => base.next(),
      return: async () => { returned = true; return { value: undefined, done: true }; },
    });
    return stream;
  };
  const stream = withRubatoStream(inner)(model, context, { env: {} });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  assert.equal(returned, true, "취소가 원본에 닿지 않으면 provider 요청이 살아남는다");
});

test("hasPendingLocalWork/trackLocalWork 가 원본에 위임된다 — 도구가 idle 기한보다 오래 걸려도", async () => {
  // 새 stream 을 만들어 event 만 재방출하면 이 제어면이 사라지고, agent loop 의
  // idle watchdog 이 살아 있는 요청을 끊는다. 그래서 위임을 직접 검사한다.
  const inner = createAssistantMessageEventStream();
  const stream = withRubatoStream(() => inner)(model, context, { env: {} });

  assert.equal(stream.hasPendingLocalWork(), false);

  // 도구 실행은 "언제 끝날지 모르는 일"이다. sleep 으로 흉내내면 시간에 기대는
  // 테스트가 되므로, 명시적으로 풀어 주는 promise 로 잡는다.
  const { promise, resolve } = Promise.withResolvers();
  const tracked = stream.trackLocalWork(promise);

  assert.equal(stream.hasPendingLocalWork(), true, "decorator 를 통해 본 상태가 원본과 같아야 한다");
  assert.equal(inner.hasPendingLocalWork(), true, "trackLocalWork 가 원본의 깊이를 올려야 한다");

  // idle 기한을 0 으로 두어 **이미 지난** 기한을 만든다. 도구는 아직 안 끝났다.
  // watchdog 이 이 시점에 끊지 않는 것이 이 gate 다.
  let aborted = false;
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((next) => setTimeout(next, 0));
    if (!stream.hasPendingLocalWork()) aborted = true;
  }
  assert.equal(aborted, false, "도구가 도는 동안 idle 기한이 지나도 요청을 끊지 않는다");

  resolve("tool output");
  assert.equal(await tracked, "tool output", "trackLocalWork 의 결과가 그대로 돌아온다");
  assert.equal(stream.hasPendingLocalWork(), false);
});

test("setup 이 동기적으로 던져도 logical call 은 한 번 닫힌다 — 오류는 그대로 올라간다", async () => {
  // 이 경로에는 종단 event 가 없다. 그래서 iteration 이 닫아 주는 자리도 없고,
  // 여기서 닫지 않으면 recorder 에 model.send 만 남아 task 가 incomplete 로 정착한다
  // (measurement-recorder 의 `pending_model_calls`).
  const recorder = recorderSpy();
  const boom = new Error("provider setup failed");
  const inner = () => { throw boom; };
  let thrown;
  try {
    withRubatoStream(inner)(model, context, { measurementRecorder: recorder, env: {} });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, boom, "오류 객체를 가공하지 않고 그대로 올린다");
  assert.equal(recorder.calls.startCall, 1);
  assert.equal(recorder.calls.endCall, 1, "열린 logical call 을 닫지 않으면 task 가 incomplete 로 끝난다");
  assert.equal(recorder.calls.endFields[0].status, "error");
  assert.equal(recorder.calls.endFields[0].error, "provider setup failed");
});

test("중단 + 잘린 인자만 남은 턴은 실행 가능한 tool 로 바뀌지 않는다", () => {
  // 예전에는 JSON.parse 실패를 삼키고 partialJson 만 지워서, 인자가 `{}` 인
  // "완성된" tool call 이 됐다. agent loop 는 그것을 실제로 실행한다 — 사용자가
  // 인자를 다 보내지도 않은 도구를 빈 인자로.
  const message = assistant({
    stopReason: "aborted",
    errorMessage: "aborted",
    content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {}, partialJson: '{"cmd":"rm -r' }],
  });
  assert.equal(settleAbortedToolUse(message), false, "잘린 인자는 실행 가능한 인자가 아니다");
  assert.equal(message.stopReason, "aborted", "성공 턴으로 바뀌면 안 된다");
  assert.equal(message.errorMessage, "aborted", "errorMessage 를 지우면 엔진이 성공으로 읽는다");
  assert.equal(message.content[0].partialJson, '{"cmd":"rm -r', "미완성 표지를 지우지 않는다");
  assert.deepEqual(message.content[0].arguments, {}, "잘린 JSON 을 인자로 승격하지 않는다");
});

test("완성된 tool 과 잘린 tool 이 섞인 중단 턴은 전체가 중단으로 남는다", () => {
  // agent loop 는 exec-resolved 가 아닌 toolCall block 을 **전부** 실행한다
  // (agent-loop.js:182,647 — 완성도 검사가 없다). 완성된 것 하나 때문에 턴을
  // 넘기면 같은 message 에 남은 잘린 block 도 빈 인자로 함께 실행된다.
  const message = assistant({
    stopReason: "aborted",
    errorMessage: "aborted",
    content: [
      { type: "toolCall", id: "t1", name: "ls", arguments: {}, partialJson: '{"path":"/tmp"}' },
      { type: "toolCall", id: "t2", name: "bash", arguments: {}, partialJson: '{"cmd":"rm -r' },
    ],
  });
  assert.equal(settleAbortedToolUse(message), false, "미완성 block 이 하나라도 있으면 턴을 넘기지 않는다");
  assert.equal(message.stopReason, "aborted");
  assert.equal(message.errorMessage, "aborted");

  // 거절한 턴은 아무것도 손대지 않는다 — 진단이 그대로 남아야 무엇이 왜 실행되지
  // 않았는지 읽을 수 있고, 부분 확정 상태가 다음 턴으로 새지 않는다.
  assert.deepEqual(message.content[0].arguments, {}, "거절한 턴에서는 완성된 것도 확정하지 않는다");
  assert.equal(message.content[0].partialJson, '{"path":"/tmp"}');
  assert.deepEqual(message.content[1].arguments, {});
  assert.equal(message.content[1].partialJson, '{"cmd":"rm -r');
});

test("완성된 tool 만 있는 중단 턴은 toolUse 로 넘어가고 미완성 표지가 남지 않는다", () => {
  const message = assistant({
    stopReason: "aborted",
    content: [
      { type: "toolCall", id: "t1", name: "ls", arguments: {}, partialJson: '{"path":"/tmp"}' },
      { type: "toolCall", id: "t2", name: "pwd", arguments: {} },
    ],
  });
  assert.equal(settleAbortedToolUse(message), true);
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content[0].arguments, { path: "/tmp" });
  // toolUse 턴에는 미완성 block 이 하나도 없어야 한다.
  for (const part of message.content) {
    assert.equal(part.partialJson, undefined, `${part.id} 에 미완성 표지가 남았다`);
  }
});

test("exec-resolved + 잘린 tool 이 섞여도 실행 가능한 턴이 되지 않는다", () => {
  const message = assistant({
    stopReason: "aborted",
    errorMessage: "aborted",
    content: [
      { type: "toolCall", id: "t1", name: "read_file", arguments: { path: "/a" }, [kCursorExecResolved]: true },
      { type: "toolCall", id: "t2", name: "bash", arguments: {}, partialJson: '{"cmd":"rm -r' },
    ],
  });
  assert.equal(settleAbortedToolUse(message), false);
  assert.equal(message.stopReason, "aborted");
});

test("중단 + 잘린 인자만 남은 턴은 error 로 정착하고 재시도를 막는다", async () => {
  const signal = AbortSignal.abort();
  const message = assistant({
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {}, partialJson: '{"cmd":"rm -r' }],
  });
  const last = (await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "error", reason: "aborted", error: message },
  ]))(model, context, { env: {}, signal }))).at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.error.stopReason, "aborted");
  assert.ok(last.error.errorMessage.startsWith("senpi:no-turn-retry:"));
});

test("직결 context 의 toolResult 신원(toolCallId/toolName)이 계측 body 에 남는다", async () => {
  // pi-ai 의 ToolResultMessage 는 이 둘을 message 에 단다. content 만 옮기면
  // observeToolReinsertion 이 신원을 못 보고 재삽입 관측이 전부 익명이 된다.
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "stop" });
  const directContext = {
    systemPrompt: "you are rubato",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "toolResult",
        toolCallId: "call_abc",
        toolName: "read_file",
        content: [{ type: "text", text: "file body" }],
        isError: false,
      },
    ],
  };
  await drain(withRubatoStream(scriptedStream([
    { type: "done", reason: "stop", message },
  ]))(model, directContext, { measurementRecorder: recorder, sessionId: "s-direct", env: {} }));

  assert.equal(recorder.calls.reinsertions.length, 1, "재삽입된 tool result 를 한 번 관측한다");
  assert.equal(recorder.calls.reinsertions[0].toolCallId, "call_abc");
  assert.equal(recorder.calls.reinsertions[0].toolName, "read_file");

  // 계측 body 자체에도 신원이 남아야 한다.
  const body = measurementBodyFromContext(directContext);
  const toolItem = body.prompt.find((item) => item.role === "tool");
  assert.equal(toolItem.toolCallId, "call_abc");
  assert.equal(toolItem.toolName, "read_file");
  assert.equal(toolItem.content[0].toolCallId, "call_abc");
  assert.equal(toolItem.content[0].toolName, "read_file");
});

test("iterator return(취소)이 열린 logical call 을 정확히 한 번 닫는다", async () => {
  const recorder = recorderSpy();
  const inner = createAssistantMessageEventStream();
  const stream = withRubatoStream(() => inner)(model, context, { measurementRecorder: recorder, env: {} });
  inner.push({ type: "start", partial: assistant() });
  inner.push({ type: "text_delta", contentIndex: 0, delta: "hi" });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.return();
  assert.equal(recorder.calls.startCall, 1);
  assert.equal(recorder.calls.endCall, 1, "취소로 끝난 호출도 닫아야 task 가 incomplete 로 안 끝난다");
  assert.equal(recorder.calls.endFields[0].status, "cancelled");
  await iterator.return();
  assert.equal(recorder.calls.endCall, 1, "두 번 닫지 않는다");
});

test("next() reject 가 오류를 그대로 올리면서 logical call 을 닫는다", async () => {
  const recorder = recorderSpy();
  const boom = new Error("socket hang up");
  const inner = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: assistant() });
    const base = stream[Symbol.asyncIterator]();
    let served = false;
    stream[Symbol.asyncIterator] = () => ({
      next: async () => {
        if (!served) { served = true; return base.next(); }
        throw boom;
      },
    });
    return stream;
  };
  const stream = withRubatoStream(inner)(model, context, { measurementRecorder: recorder, env: {} });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  let thrown;
  try { await iterator.next(); } catch (error) { thrown = error; }
  assert.equal(thrown, boom, "오류 객체를 가공하지 않는다");
  assert.equal(recorder.calls.endCall, 1);
  assert.equal(recorder.calls.endFields[0].status, "error");
  assert.equal(recorder.calls.endFields[0].error, "socket hang up");
});

test("result() 만 기다린 중단 턴도 재시도를 막는다", async () => {
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "aborted", errorMessage: "Request was aborted" });
  const stream = withRubatoStream(scriptedStream([
    { type: "error", reason: "aborted", error: message },
  ], { result: message }))(model, context, { measurementRecorder: recorder, env: {} });
  const settled = await stream.result();
  assert.equal(settled.stopReason, "aborted");
  assert.ok(
    settled.errorMessage.startsWith("senpi:no-turn-retry:"),
    `iteration 경로와 정착이 갈리면 안 된다: ${settled.errorMessage}`,
  );
  assert.equal(recorder.calls.endCall, 1);
});

test("firstOutput 은 recorder 내부 dedupe 없이도 한 번만 기록된다", async () => {
  // recorder 대역은 dedupe 를 하지 않는다. 계약을 지키는 주체가 decorator 임을 본다.
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "stop" });
  await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "thinking_delta", contentIndex: 0, delta: "생각" },
    { type: "text_delta", contentIndex: 1, delta: "a" },
    { type: "text_delta", contentIndex: 1, delta: "b" },
    { type: "toolcall_delta", contentIndex: 2, delta: "{" },
    { type: "done", reason: "stop", message },
  ]))(model, context, { measurementRecorder: recorder, env: {} }));
  assert.equal(recorder.calls.firstOutput, 1, "logical call 당 최대 한 번이다");
});

test("start 프레임은 첫 출력으로 세지 않는다", async () => {
  const recorder = recorderSpy();
  const message = assistant({ stopReason: "stop" });
  await drain(withRubatoStream(scriptedStream([
    { type: "start", partial: message },
    { type: "done", reason: "stop", message },
  ]))(model, context, { measurementRecorder: recorder, env: {} }));
  assert.equal(recorder.calls.firstOutput, 0, "frame opener 만 있었던 호출은 첫 출력이 없다");
});

test("push/end 같은 원본 메서드가 private field 를 잃지 않는다", async () => {
  const inner = createAssistantMessageEventStream();
  const stream = withRubatoStream(() => inner)(model, context, { env: {} });
  const message = assistant({ stopReason: "stop" });
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  assert.deepEqual((await drain(stream)).map((event) => event.type), ["start", "done"]);
});
