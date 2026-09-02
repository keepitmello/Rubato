// Rubato 고유 동작을 transport 에서 떼어낸 자리.
//
// 예전에는 계측·timing·정착이 삭제된 FX transport 구현 **안쪽**에 있었다. 그래서
// provider 를 직결로 바꾸는 순간 그 의미가 통째로 사라졌다 — statusline 의
// TTFT/wait/think, measurement log, 델타 후 재시도 금지, 도구를 든 사용자 중단의
// 정착이 전부 그 transport 전용 코드였다.
//
// 여기는 transport 를 구현하지 않는다. native `stream`/`streamSimple` 을 그대로
// 호출하고 그 stream 을 **위임(proxy)** 한다. 새 stream 을 만들어 event 만 다시
// 뿜으면 안 된다: Cursor 처럼 server-driven tool 을 실행하는 동안 원본의
// `hasPendingLocalWork()` 가 true 여야 agent loop 의 idle watchdog 이 살아 있는
// 요청을 끊지 않는데, 재방출 stream 은 그 제어면을 잃는다. `result()`, async
// iterator 의 `return`(취소 전파), `trackLocalWork()` 도 같은 이유로 위임한다.
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { cacheAudit, isAnthropicMessagesModel } from "./cache-audit.mjs";
import { senpiNested } from "./engine-paths.mjs";
import { measurementRecorder, normalizeProviderUsage } from "./measurement-recorder.mjs";
import { PROCESS_STARTED_AT } from "./process-start.mjs";
import { resolveCallIdentity } from "./speed-index-identity.mjs";
import { recordSpeedIndexCall, speedIndexStore } from "./speed-index-store.mjs";

// native Cursor 가 이미 실행한 tool block 은 pi-ai 가 **module-local** `Symbol()` 로
// 표지한다 (`utils/block-symbols.js`). `Symbol.for()` 로 같은 이름을 지어내도
// 그것은 **다른 심볼**이라 반드시 불일치한다 — 그러면 이미 실행된 tool 을
// 미실행으로 읽어 agent loop 가 다시 실행한다. 직입이 아니라 설치본에서
// 가지고 오는 이유가 그것이다.
const { isCursorExecResolved } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/utils/block-symbols.js")).href
);
export { isCursorExecResolved };

/** 엔진(agent-session TURN_RETRY_SUPPRESSION_PREFIX)이 재시도 금지로 읽는 접두사. */
export const NO_TURN_RETRY_PREFIX = "senpi:no-turn-retry:";

/** 한 logical model call 에 decorator 가 두 번 걸리지 않게 하는 표지. */
export const kRubatoStream = Symbol.for("rubato.stream.decorated");

/**
 * 이 요청이 이미 decorator 안에 있다는 표지. options 에 싫어 보낸다.
 *
 * 함수에 붙이는 표지(`kRubatoStream`)만으로는 **재진입**을 모른다: pinned
 * `provider-composer.js` 는 `streamSimple` 이 없으면 `stream` 으로 내려가고
 * (`provider-composer.js:256,265`), provider 구현이 자기 `api.streamSimple` 에서
 * `api.stream` 을 다시 부를 수도 있다. 둘 다 감싸있으면 한 logical call 에
 * `startCall`/`endCall` 이 두 번 찍힌다. options 를 토큰으로 쓰면 호출 그래프의
 * 모양에 관계없이 **가장 밖의 경계 하나**만 살아남는다. 심볼 키는 spread 를
 * 통과하므로 provider 가 `{...options}` 로 다시 만들어도 남는다.
 */
export const kRubatoCallActive = Symbol.for("rubato.stream.callActive");

function isTerminal(event) {
  return event?.type === "done" || event?.type === "error";
}

function terminalMessage(event) {
  return event?.type === "done" ? event.message : event?.error;
}

/**
 * 이 tool block 의 인자가 실행 가능한 상태인지 본다. 아무것도 바꾸지 않는다.
 *
 * `partialJson` 이 깨져 있으면 실행 가능하지 않다. 예전에는 parse 실패를 삼키고
 * `partialJson` 만 지웠는데, 그러면 인자가 `{}` 인 "완성된" tool call 이 되어
 * agent loop 가 그것을 실제로 실행했다 — 사용자가 인자를 다 보내지도 않은 도구를,
 * 빈 인자로. 잘린 인자는 실행 가능한 인자가 아니다.
 */
function toolArgsResolution(tool) {
  const hasArgs = tool.arguments && Object.keys(tool.arguments).length > 0;
  // partialJson 이 없으면 provider 가 인자를 다 준 상태다. 인자 없는 도구(`{}`)도 완성이다.
  if (typeof tool.partialJson !== "string" || tool.partialJson.length === 0) return { complete: true };
  if (hasArgs) return { complete: true };
  try {
    return { complete: true, parsed: JSON.parse(tool.partialJson) };
  } catch {
    return { complete: false };
  }
}

/**
 * 사용자가 멈춘 턴에서 **완성된 미실행 tool call** 만 살려 `toolUse` 로 정착시킨다.
 *
 * 전송 실패를 같이 살리면 엔진이 성공한 턴으로 읽어 재시도도 폴백도 걸지 않고,
 * 잘린 인자로 도구가 그대로 실행된다. 그래서 호출하는 쪽이 `signal.aborted` 를
 * 확인한 뒤에만 부른다.
 *
 * native Cursor 가 이미 실행한 block(`kCursorExecResolved`)은 실행할 tool 이 아니다.
 * 그것만 남은 턴은 정착시키지 않는다 — 되살리면 agent loop 가 같은 tool 을 두 번
 * 실행한다.
 */
export function settleAbortedToolUse(message) {
  const tools = (message?.content ?? []).filter((part) => part?.type === "toolCall" && !isCursorExecResolved(part));
  if (tools.length === 0) return false;
  // 이 턴을 `toolUse` 로 넘기려면 **모든** tool block 이 실행 가능해야 한다.
  //
  // agent loop 는 exec-resolved 가 아닌 toolCall block 을 전부 실행한다
  // (`agent-loop.js:182,647` — 완성도 검사가 없다). 그래서 완성된 것 하나 때문에
  // 턴을 넘기면 같은 message 에 남은 잘린 block 도 빈 인자로 함께 실행된다.
  // 하나라도 미완성이면 턴 전체를 중단으로 남긴다 — 이것은 pinned 엔진이
  // `stopReason === "length"` 를 message 단위로 처리하는 것과 같은 결이다
  // (`failToolCallsFromTruncatedMessage`: 잘린 message 의 tool 을 개별로 고르지 않고
  // 전부 실패시킨다).
  //
  // 진단은 지우지 않는다: 잘린 block 의 `partialJson` 과 turn 의 `errorMessage` 가
  // 그대로 남아 무엇이 왜 실행되지 않았는지 읽을 수 있다.
  const resolutions = tools.map((tool) => toolArgsResolution(tool));
  // 거절할 턴에서는 아무것도 손대지 않는다. 판정을 먼저 끝내고 나서 확정한다.
  if (resolutions.some((resolution) => !resolution.complete)) return false;
  for (const [index, tool] of tools.entries()) {
    const { parsed } = resolutions[index];
    if (parsed !== undefined) tool.arguments = parsed;
    delete tool.partialJson;
  }
  if (message.stopReason === "pending" || message.stopReason === "aborted" || message.stopReason === "error") {
    message.stopReason = "toolUse";
  }
  delete message.errorMessage;
  return true;
}

/**
 * 계측용 body. measurement recorder 는 `body.prompt` 의 role 로 구간을 가른다
 * (system / tool / user / assistant). transport 가 실제 wire body 를 알려주면
 * (`options.onRubatoRequest`) 그것을 쓰고, 직결 provider 처럼 알려주지 않으면
 * context 에서 같은 모양을 만든다.
 */
export function measurementBodyFromContext(context = {}) {
  const prompt = [];
  if (typeof context.systemPrompt === "string" && context.systemPrompt.length > 0) {
    prompt.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages ?? []) {
    if (message?.role === "user") prompt.push({ role: "user", content: message.content });
    else if (message?.role === "assistant") prompt.push({ role: "assistant", content: message.content });
    else if (message?.role === "toolResult") {
      // pi-ai 의 `ToolResultMessage` 는 `toolCallId`/`toolName` 을 **message 에** 단다
      // (types.d.ts:422-426). content 만 옮기면 `observeToolReinsertion` 이 신원을
      // 못 보고 재삽입 관측이 전부 익명이 된다. part 에 실어 신원을 지킨다.
      prompt.push({
        role: "tool",
        content: (message.content ?? []).map((part) => ({
          ...part,
          ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
          ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
        })),
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
        ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
      });
    }
  }
  return {
    prompt,
    ...(Array.isArray(context.tools) && context.tools.length > 0 ? { tools: context.tools } : {}),
  };
}

/**
 * 한 logical model call 의 계측·timing·정착 상태.
 *
 * retry 는 provider attempt 를 늘리는 것이고 logical call 은 하나다. 그래서
 * `startCall == 1`, `firstOutput <= 1`, `endCall == 1` 을 여기서 지킨다.
 */
function createCallState(model, options, modelId) {
  const monotonic = options.monotonic ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  let recorder = options.measurementRecorder;
  if (recorder === undefined) {
    try { recorder = measurementRecorder(options.env ?? process.env); } catch {}
  }
  let speedStore = options.speedIndexStore;
  if (speedStore === undefined && options.env) {
    try { speedStore = speedIndexStore(options.env); } catch { speedStore = undefined; }
  }
  const state = {
    monotonic,
    recorder,
    model,
    options,
    identity: resolveCallIdentity(model, options),
    speedIndexStore: speedStore,
    speedRecorded: false,
    sentAtMs: monotonic(),
    sentAtWallMs: wallNow(),
    processStartedAt: options.processStartedAt ?? PROCESS_STARTED_AT,
    firstOutputAtMs: undefined,
    firstReasoningAtMs: undefined,
    firstTextAtMs: undefined,
    emittedDelta: false,
    // recorder 내부 dedupe 에 기대지 않는다. 계약은 "logical call 당 최대 한 번"이고,
    // 그 계약을 지키는 주체가 이 decorator 다.
    firstOutputRecorded: false,
    callId: undefined,
    started: false,
    ended: false,
    settled: false,
  };

  state.startCall = (body) => {
    if (state.started) return;
    state.started = true;
    const taskId = options.taskId ?? state.recorder?.activeTaskId?.(options.sessionId);
    let measurement;
    try {
      measurement = state.recorder?.startCall({
        taskId,
        sessionId: options.sessionId,
        provider: model?.provider,
        model: modelId,
        body,
      });
    } catch {}
    state.callId = measurement?.callId;
    // 재삽입된 tool result 를 관측한다. body 를 만든 자리에서만 알 수 있다.
    for (const message of body?.prompt ?? []) {
      if (message?.role !== "tool") continue;
      for (const part of message.content ?? []) {
        try {
          state.recorder?.observeToolReinsertion({
            taskId,
            sessionId: options.sessionId,
            callId: state.callId,
            toolCallId: part?.toolCallId,
            toolName: part?.toolName,
          });
        } catch {}
      }
    }
  };

  state.endCall = (fields) => {
    if (!state.callId || state.ended) return;
    state.ended = true;
    try { state.recorder?.endCall(state.callId, fields); } catch {}
  };

  state.emitSpeedIndex = (message, terminalStatus, endedAtMs, extra = {}) => {
    if (state.speedRecorded || !state.speedIndexStore) return;
    state.speedRecorded = true;
    try {
      recordSpeedIndexCall({
        store: state.speedIndexStore,
        model: state.model,
        options: state.options,
        state,
        message,
        terminalStatus,
        endedAtMs,
        isCursorExecResolved,
        aborted: extra.aborted === true,
      });
    } catch {}
  };

  /**
   * 종단 event 를 보지 못한 채 끝난 호출을 정확히 한 번 닫는다. 취소, `next()`
   * reject, 종단 event 없는 소진이 그 경로다. 이미 정착했으면 아무것도 하지 않는다.
   */
  state.closeUnsettled = (status, error) => {
    if (state.settled || state.ended) return;
    state.settled = true;
    state.endCall({
      status,
      ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    });
    state.emitSpeedIndex(undefined, status);
  };

  return state;
}

/**
 * Senpi's current main agent loop does not tag provider calls with a stream kind.
 * A non-empty tool registry is the positive evidence that this is the normal
 * reasoning/tool loop. Title, compaction, branch-summary, and /btw contexts have
 * no tools and therefore remain fail-closed auxiliary calls. Explicit tags still
 * win for tests and future engine versions.
 */
export function resolveSpeedIndexStreamKind(context, options = {}) {
  if (typeof options.streamKind === "string" && options.streamKind.length > 0) {
    return options.streamKind;
  }
  return Array.isArray(context?.tools) && context.tools.length > 0 ? "main" : "auxiliary";
}

function isReplayableContent(event) {
  // 재시도가 화면에 같은 내용을 두 번 그리게 되는 델타만 센다.
  // 사고 델타만 나간 턴에서 WebSocket 이 끊기면 엔진이 같은 턴을 다시
  // 보내야 한다 — 접두사를 붙이면 재시도·폴백이 둘 다 막혀 턴이 그대로 죽는다.
  // Codex 는 그 다음 시도에서 SSE 로 넘어간다.
  return event.type === "text_start" || event.type === "text_delta" || event.type === "text_end"
    || event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end";
}

function observeDelta(state, event) {
  if (isReplayableContent(event)) state.emittedDelta = true;
  // TTFT 는 빈 start/end 프레임이 아니라 사용자가 실제로 볼 첫 내용이다.
  const isContentDelta = event.type === "text_delta" ||
    event.type === "thinking_delta" || event.type === "toolcall_delta";
  if (isContentDelta && state.firstOutputAtMs === undefined) state.firstOutputAtMs = state.monotonic();
  // 빈 reasoning delta 는 사고 시계를 시작하지 않는다. Anthropic 은 display 가
  // "omitted" 일 때 내용 없는 reasoning 블록을 먼저 열 수 있는데, 그걸 사고 시작으로
  // 세면 업스트림 대기 시간이 think 로 옮겨가 delay 가 0 에 가까워진다.
  if (event.type === "thinking_delta" && state.firstReasoningAtMs === undefined && event.delta) {
    state.firstReasoningAtMs = state.monotonic();
  }
  if (event.type === "text_delta" && state.firstTextAtMs === undefined && event.delta) {
    state.firstTextAtMs = state.monotonic();
  }
}

function attachTiming(state, message) {
  const endedAtMs = state.monotonic();
  // reasoning 이 없으면 think 구간 자체가 없다. 그때 waitMs 는 첫 텍스트까지의
  // 시간이고, 상태줄은 think 를 아예 그리지 않는다 — `think 0ms` 는 거짓말이다.
  const phaseStartMs = state.firstReasoningAtMs ?? state.firstTextAtMs;
  message.timing = {
    sentAt: state.sentAtWallMs,
    processStartedAt: state.processStartedAt,
    ...(state.firstOutputAtMs === undefined ? {} : { ttftMs: state.firstOutputAtMs - state.sentAtMs }),
    ...(phaseStartMs === undefined ? {} : { waitMs: phaseStartMs - state.sentAtMs }),
    ...(state.firstReasoningAtMs === undefined || state.firstTextAtMs === undefined
      ? {}
      : { thinkMs: state.firstTextAtMs - state.firstReasoningAtMs }),
    modelDurationMs: endedAtMs - state.sentAtMs,
  };
  state.emitSpeedIndex(message, message.stopReason, endedAtMs);
}

/**
 * 종단 event 하나를 정착시킨다. 반환한 event 가 소비자에게 간다.
 *
 * 종료 정착표(설계 문서)를 여기서 지킨다:
 * - 텍스트·도구 델타 전 오류 → 그대로 error, 재시도 허용
 * - 사고만 나간 오류 → 그대로 error, 재시도 허용 (사고는 재시도가 두 번 그리지 않는다)
 * - 텍스트·도구 델타 후 오류 → `senpi:no-turn-retry:` 로 재시도 금지
 * - 사용자 중단 + 완성된 미실행 tool → `toolUse` done
 * - 전송 실패는 도구가 있어도 성공으로 바꾸지 않는다
 */
function settleTerminal(state, options, event) {
  if (state.settled) return event;
  state.settled = true;
  const message = terminalMessage(event);
  if (!message) {
    state.endCall({ status: "unknown" });
    state.emitSpeedIndex(undefined, "unknown");
    return event;
  }
  const rawError = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  // signal 이 이미 정리됐거나 provider 가 스스로 중단을 라벨한 경우 둘 다 중단이다.
  // 한쪽만 보면 result() 경로와 iteration 경로의 정착이 갈린다.
  const aborted = options.signal?.aborted === true || message.stopReason === "aborted";

  if (event.type === "error" && aborted && settleAbortedToolUse(message)) {
    state.endCall({ status: message.stopReason, usage: normalizeProviderUsage(message.providerUsage) });
    state.emitSpeedIndex(message, message.stopReason, undefined, { aborted: true });
    return { type: "done", reason: message.stopReason, message };
  }

  state.endCall({
    status: message.stopReason,
    ...(event.type === "error" && rawError ? { error: rawError } : {}),
    usage: normalizeProviderUsage(message.providerUsage),
  });

  if (event.type === "error") {
    state.emitSpeedIndex(message, aborted ? (message.stopReason ?? "aborted") : (message.stopReason ?? "error"), undefined, { aborted });
    // 사용자가 멈춘 턴은 재시도 대상이 아니다. 실행할 tool 이 없어 `toolUse` 로
    // 정착하지 못한 턴(인자가 부족한 턴, exec-resolved 만 남은 턴)도 같다.
    // 델타가 없었다는 이유로 재시도를 허용하면 엔진이 사용자가 지운 일을 그대로
    // 다시 보낸다. provider 가 중단을 `error` 로 라벨해도 중단은 중단이므로
    // stopReason 도 거기에 맞춰 둔다.
    if (aborted) {
      if (message.stopReason === "error" || message.stopReason === "pending") message.stopReason = "aborted";
      const reason = rawError ?? "aborted";
      message.errorMessage = reason.startsWith(NO_TURN_RETRY_PREFIX) ? reason : `${NO_TURN_RETRY_PREFIX}${reason}`;
      return event;
    }
    // 이미 화면에 나간 텍스트·도구가 있으면 같은 턴을 다시 보낼 수 없다 —
    // 업스트림은 이미 토큰을 태웠고, 재시도하면 같은 텍스트가 두 번 나온다.
    // 사고만 나간 경우는 여기 오지 않는다: 재시도가 사고를 다시 그리더라도
    // 실패한 턴은 엔진이 걷어내고, Codex 는 SSE 로 넘어간다.
    if (state.emittedDelta && rawError && !rawError.startsWith(NO_TURN_RETRY_PREFIX)) {
      message.errorMessage = `${NO_TURN_RETRY_PREFIX}${rawError}`;
    }
    return event;
  }

  // 에러와 사용자 중단은 직전 성공 턴의 속도를 덮지 않는다. 도구가 살아 있는
  // 사용자 중단도 성공한 모델 응답은 아니므로 timing 을 붙이지 않는다.
  if (!aborted) attachTiming(state, message);
  return event;
}

/** iteration 없이 `result()` 만 기다린 소비자도 계측·정착을 받는다. */
function settleResult(state, options, message) {
  if (state.settled || !message) return message;
  state.ensureStarted();
  // 중단도 error 경로로 정착시킨다. `done` 으로 보내면 abort 정착·재시도 금지가
  // iteration 경로와 달라져, result() 만 기다린 소비자에게는 중단이 성공으로 보인다.
  const kind = message.stopReason === "error" || message.stopReason === "aborted" || options.signal?.aborted === true
    ? "error"
    : "done";
  settleTerminal(state, options, kind === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message });
  return message;
}

function decorateStream(inner, state, options) {
  const iterate = () => {
    const iterator = inner[Symbol.asyncIterator]();
    return {
      next: async () => {
        let step;
        try {
          step = await iterator.next();
        } catch (error) {
          // provider 가 종단 event 대신 reject 로 끝내는 경로. 그대로 올리되
          // 열린 logical call 은 닫는다 — 안 닫으면 task 가 incomplete 로 정착한다.
          state.closeUnsettled("error", error);
          throw error;
        }
        // iterator 가 종단 event 없이 소진된 경우도 열린 채로 두지 않는다.
        if (step.done) {
          state.closeUnsettled("unknown");
          return step;
        }
        const event = step.value;
        if (isTerminal(event)) {
          state.ensureStarted();
          // 계측 종료는 종단 event 가 소비자에게 가기 **전**에 찍는다. 반대로 두면
          // 엔진이 다음 호출을 시작한 뒤 model.end 가 찍혀 구간이 겹친다.
          return { value: settleTerminal(state, options, event), done: false };
        }
        if (event?.type !== "start") {
          state.ensureStarted();
          observeDelta(state, event);
          if (state.callId && !state.firstOutputRecorded) {
            state.firstOutputRecorded = true;
            try { state.recorder?.firstOutput(state.callId, { outputType: event.type }); } catch {}
          }
        }
        return step;
      },
      // 취소 전파. 원본 iterator 의 return 을 그대로 부른다 — 여기서 끊으면
      // provider 쪽 abort 가 일어나지 않는다. 다만 취소로 끝난 호출도 logical call
      // 로서는 끝난 것이므로, 종단 event 를 못 본 채 닫힌 계측을 여기서 정착시킨다.
      return: async (value) => {
        try {
          return iterator.return ? await iterator.return(value) : { value, done: true };
        } finally {
          state.closeUnsettled("cancelled");
        }
      },
      throw: async (error) => {
        try {
          return iterator.throw ? await iterator.throw(error) : await Promise.reject(error);
        } finally {
          state.closeUnsettled("error", error);
        }
      },
    };
  };

  return new Proxy(inner, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return iterate;
      if (property === kRubatoStream) return true;
      if (property === "result") {
        return () => Promise.resolve(target.result()).then((message) => settleResult(state, options, message));
      }
      // receiver 를 proxy 로 넘기면 private field 를 쓰는 getter/method 가 터진다
      // (`#queue` 는 proxy 가 아니라 실제 stream 에만 있다). 원본을 receiver 로 준다.
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      if (property === kRubatoStream) return true;
      return Reflect.has(target, property);
    },
  });
}

/**
 * native `stream`/`streamSimple` 을 감싼다. 같은 함수에 두 번 걸면 같은 함수를
 * 돌려준다 — event, recorder call, 취소 handler 가 겹치지 않는다.
 *
 * `modelId` 는 계측 이름을 provider 마다 다르게 만들 수 있는 자리다. 기본값은
 * native `model.id` 다.
 */
export function withRubatoStream(inner, { modelId = (model) => model?.id, reportsRequest = false, speedIndexStore: defaultSpeedIndexStore } = {}) {
  if (typeof inner !== "function") throw new TypeError("withRubatoStream needs a stream function");
  if (inner[kRubatoStream]) return inner;

  const decorated = (model, context, options = {}) => {
    // 이미 같은 logical call 이라면 그대로 통과시킨다. 여기서 한 번 더 감으면
    // event, recorder call, 취소 handler 가 겹친다.
    if (options[kRubatoCallActive]) return inner(model, context, options);
    const state = createCallState(model, {
      ...options,
      streamKind: resolveSpeedIndexStreamKind(context, options),
      speedIndexStore: options.speedIndexStore ?? defaultSpeedIndexStore,
    }, modelId(model));
    // transport 가 실제 wire body 를 알려주면 그것으로 계산을 시작한다. 알려주지
    // 않는 직결 provider 는 context 에서 만든 body 로 시작한다.
    const innerOptions = {
      ...options,
      [kRubatoCallActive]: true,
      onResolvedCall: (identity) => {
        if (identity && typeof identity === "object") {
          state.identity = { ...state.identity, ...identity };
        }
        options.onResolvedCall?.(identity);
      },
      onRubatoRequest: (body) => {
        state.startCall(body);
        options.onRubatoRequest?.(body);
      },
    };
    // Anthropic 직결 경로의 캐시 실사: SDK 가 부르는 fetch 를 감싸 최종 body 와 원시
    // usage/diagnostics 를 남긴다 (`RUBATO_CACHE_AUDIT_DIR`). 다른 provider 는 그대로.
    if (isAnthropicMessagesModel(model)) {
      let audit;
      try { audit = options.cacheAudit ?? cacheAudit(options.env ?? process.env); } catch {}
      if (audit) {
        innerOptions.fetch = audit.wrapFetch(options.fetch, {
          sessionId: options.sessionId,
          model: modelId(model),
          provider: model?.provider,
        });
      }
    }
    // wire body 를 알려주지 않는 provider 는 요청을 보내기 전에 시작해야 model.send
    // 시각이 실제 전송 시점이다. 알려주는 transport 만 첫 event 까지 기다린다.
    state.ensureStarted = () => {
      if (!state.started) state.startCall(measurementBodyFromContext(context));
    };
    if (!reportsRequest) state.ensureStarted();
    let stream;
    try {
      stream = inner(model, context, innerOptions);
    } catch (error) {
      // setup 이 동기적으로 던지면 stream 자체가 없다 — 종단 event 도, 그것을
      // 보고 닫을 기회도 없다. 그러나 `model.send` 는 이미 찍혔으므로 여기서
      // 닫지 않으면 logical call 이 열린 상태로 남았고(recorder 의
      // `pending_model_calls`), 그 task 는 incomplete 로 정착한다.
      state.endCall({ status: "error", error: error instanceof Error ? error.message : String(error) });
      // 오류 객체는 가공하지 않고 그대로 올린다. decorator 는 진단을 바꾸지 않는다.
      throw error;
    }
    return decorateStream(stream, state, options);
  };
  Object.defineProperty(decorated, kRubatoStream, { value: true });
  Object.defineProperty(decorated, "name", { value: `withRubatoStream(${inner.name || "anonymous"})` });
  return decorated;
}

/**
 * provider 하나의 stream 면을 감싼다.
 *
 * pinned pi-ai 의 `openaiCodexProvider()`·`xaiProvider()` 는 `stream`/`streamSimple` 을
 * **provider 객체 자체에** 달고 나온다 (`api` 필드가 아예 없다). `api: { stream }` 은
 * `createProvider()` 로 만든 provider 의 모양이다. 두 모양이 다 살아 있으니 둘 다
 * 다룬다 — 한 축만 보면 native 등록이 "감쌀 api 가 없다"로 죽거나, 감쌌다고 받은
 * 것이 실은 생판 원본으로 나간다.
 *
 * agent loop 가 부르는 `streamSimple` 이 canonical entry 다. `stream` 도 같은
 * decorator 를 받지만, 한 요청이 둘을 겹쳐 지나가도 `kRubatoCallActive` 표지가 있어
 * 계측은 가장 밖의 경계 하나만 소유한다. 이미 감싼 provider 를 다시 등록하는 것은
 * 실패시킨다 — 조용히 통과하면 어디서 두 번 감쌌는지 알 수 없다.
 */
export function wrapProviderStreams(provider, wrapOptions) {
  if (provider?.[kRubatoStream]) {
    throw new Error(`provider ${provider?.id} is already wrapped with the Rubato stream decorator`);
  }
  const wrapPair = (source) => ({
    ...(typeof source?.stream === "function" ? { stream: withRubatoStream(source.stream, wrapOptions) } : {}),
    ...(typeof source?.streamSimple === "function"
      ? { streamSimple: withRubatoStream(source.streamSimple, wrapOptions) }
      : {}),
  });

  // native 모양: provider 에 직접 달린 stream 면.
  const top = wrapPair(provider);
  // createProvider 모양: `api` 안에 달린 stream 면.
  const nested = provider?.api ? wrapPair(provider.api) : undefined;

  if (Object.keys(top).length === 0 && (!nested || Object.keys(nested).length === 0)) {
    throw new Error(
      `provider ${provider?.id} exposes no stream to wrap ` +
      "(looked for stream/streamSimple on the provider and on provider.api)",
    );
  }

  // 나머지 필드(id, name, baseUrl, headers, auth, getModels, refreshModels,
  // filterModels …)는 그대로 실어 보낸다. 감싸는 것이 provider 의 정체를 바꾸면
  // catalog·인증 경로가 같이 흔들린다.
  const wrapped = {
    ...provider,
    ...top,
    ...(nested ? { api: { ...provider.api, ...nested } } : {}),
  };
  Object.defineProperty(wrapped, kRubatoStream, { value: true, enumerable: false });
  return wrapped;
}
