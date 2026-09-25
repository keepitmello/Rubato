import { classifyCredentialFailure, TURN_RETRY_SUPPRESSION_PREFIX } from "./classify.mjs";

export { TURN_RETRY_SUPPRESSION_PREFIX };

export class CredentialFailoverError extends Error {
  constructor(action, original, options) {
    const detail = original instanceof Error ? original.message : String(original);
    super(`${options.suppressTurnRetry ? TURN_RETRY_SUPPRESSION_PREFIX : ""}${detail}`, { cause: original });
    this.name = "CredentialFailoverError";
    this.action = action;
    this.original = original;
    this.suppressTurnRetry = options.suppressTurnRetry;
    this.retryAt = options.retryAt;
  }
}

const TERMINAL_BLOCK_REASONS = new Set(["auth_error", "account_disabled"]);

/**
 * 영구 차단을 남길 자리인가.
 *
 * `auth_error` 와 `account_disabled` 는 pool 안에서 되돌릴 길이 없다. 차단된 칸은
 * `isAvailable` 과 `select` 에서 빠지고 `acquireHalfOpenLease` 도 거절하므로, 차단을
 * 푸는 유일한 손잡이인 `onSuccess` 가 영영 실행되지 않는다. 계정이 여럿이면 그래도
 * 남는 계정으로 넘어가니 값을 하지만, **하나뿐이면 넘어갈 곳이 없다** — 그 기록은
 * provider 를 통째로 끄고 화면에서 사라지는 것 말고 하는 일이 없다.
 *
 * 실측(2026-09-18 `credential-pool-state.json`): Codex `default` 가 `failureCount: 1`,
 * `blockReason: "auth_error"` 로 굳어 있었는데 같은 자격증명으로 갱신을 돌리면 그냥
 * 성공했다. 한 번의 401 이 멀쩡한 단일 계정을 영구 퇴역시킨 것이다.
 *
 * 실패 자체는 그대로 호출자에게 올라가므로 사용자가 못 보고 지나치지 않는다.
 */
function shouldPersistBlock(block, slots) {
  return !(TERMINAL_BLOCK_REASONS.has(block?.reason) && slots.length <= 1);
}

function isAvailable(slot, now, stickyName) {
  if (stickyName !== undefined && slot.name === stickyName) return true;
  if (slot.blockReason === "auth_error" || slot.blockReason === "account_disabled") return false;
  if (slot.blockedUntil !== undefined && slot.blockedUntil > now) return false;
  return true;
}

function soonestRetryAt(slots, now) {
  const deadlines = slots
    .map((slot) => slot.blockedUntil)
    .filter((value) => value !== undefined && value > now);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

async function settle(stream) {
  const iterator = stream?.[Symbol.asyncIterator]?.();
  if (!iterator?.return) return;
  try { await iterator.return(undefined); } catch { /* keep original failure */ }
}

function isAbortedEvent(event) {
  return event?.reason === "aborted" || event?.error?.stopReason === "aborted";
}

/**
 * 이 실패를 다른 계정으로 넘길 수 없을 때, 던지지 않고 provider 의 종단 event 를 그대로 둔다.
 *
 * 사용자 중단과 출력이 이미 나간 뒤의 실패가 그렇다. 여기서 `Error` 로 다시 던지면
 * `lazyStream` 이 빈 `stopReason: "error"` 메시지를 새로 만든다 — 중단이 실패로 둔갑해
 * GUI 에 빨간 줄로 뜨고, 이미 나간 텍스트와 usage 가 사라진다(2026-09-25 Opus 재현).
 */
function passThroughTerminal(event, committedOutput) {
  const message = event.error;
  if (!isAbortedEvent(event) && committedOutput && message && typeof message.errorMessage === "string"
    && !message.errorMessage.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)) {
    message.errorMessage = `${TURN_RETRY_SUPPRESSION_PREFIX}${message.errorMessage}`;
  }
  return event;
}

function withErrorMessage(event, errorMessage) {
  const message = event.error;
  if (message && typeof message === "object") message.errorMessage = errorMessage;
  return event;
}

export async function* runCredentialFailover(options) {
  const now = options.now ?? Date.now;
  const classify = options.classify ?? classifyCredentialFailure;
  const attempted = new Set();
  const retriesBySlot = new Map();
  let lastError;
  let lastOriginal;
  while (true) {
    const slots = await options.listSlots();
    const stickyName = options.stickySlotName?.();
    const candidates = slots.filter((slot) => !attempted.has(slot.name) && isAvailable(slot, now(), stickyName));
    if (candidates.length === 0) {
      const retryAt = soonestRetryAt(slots, now());
      throw lastError !== undefined && lastOriginal !== undefined
        ? new CredentialFailoverError(lastError.action, lastOriginal, {
          suppressTurnRetry: lastError.suppressTurnRetry,
          ...(retryAt === undefined ? {} : { retryAt }),
        })
        : new CredentialFailoverError({ kind: "fail_request" }, new Error("No credential slots available"), {
          suppressTurnRetry: false,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
    }
    const slot = options.select(candidates);
    let committedOutput = false;
    // 소비자에게 event 를 하나라도(`start` 포함) 넘겼는가. 커밋(텍스트·도구)과는 다른
    // 질문이다: agent loop 는 `start` 마다 partial 을 context 에 하나씩 넣으므로
    // (pi-agent-core agent-loop.js streamAssistantResponse), 무엇이든 넘긴 뒤 같은
    // 호출 안에서 다시 시도하면 부분 메시지가 context 에 두 번 남는다.
    let yieldedOutput = false;
    let terminalEvent;
    let attemptStream;
    try {
      attemptStream = await options.runAttempt(slot);
      for await (const event of attemptStream) {
        const failure = options.errorFromEvent?.(event);
        if (failure !== undefined) {
          if (!committedOutput && !isAbortedEvent(event)) {
            terminalEvent = event;
            throw failure;
          }
          if (!isAbortedEvent(event)) {
            const action = classify(failure, { failureCount: (slot.failureCount ?? 0) + (retriesBySlot.get(slot.name) ?? 0) });
            if (action.kind === "failover") {
              if (shouldPersistBlock(action.block, slots)) await options.persistBlock(slot, action.block);
              await options.onRotate?.({ slot, block: action.block, attempt: attempted.size, committedOutput });
            }
          }
          yield passThroughTerminal(event, committedOutput);
          return;
        }
        committedOutput ||= options.isCommittedOutput(event);
        yieldedOutput = true;
        yield event;
      }
      await options.onSuccess?.(slot);
      return;
    } catch (error) {
      if (attemptStream) await settle(attemptStream);
      const failureCount = (slot.failureCount ?? 0) + (retriesBySlot.get(slot.name) ?? 0);
      const action = classify(error, { failureCount });
      lastOriginal = error;
      let failure;
      if (action.kind === "retry_same" && !committedOutput && !yieldedOutput) {
        const used = (retriesBySlot.get(slot.name) ?? 0) + 1;
        retriesBySlot.set(slot.name, used);
        if (used < action.maxAttempts) continue;
        failure = new CredentialFailoverError(action, error, { suppressTurnRetry: false });
      } else if (action.kind !== "failover") {
        failure = new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
      } else {
        if (shouldPersistBlock(action.block, slots)) await options.persistBlock(slot, action.block);
        await options.onRotate?.({ slot, block: action.block, attempt: attempted.size, committedOutput });
        failure = new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
      }
      // 커밋 전 실패도 provider 가 error event 로 끝냈으면 그 메시지를 돌려준다. 던지면
      // lazyStream 이 빈 메시지(`content: []`, usage 0)를 새로 만들어, 이미 나간 사고와
      // 실패한 시도의 usage 가 세션에서 사라진다(2026-09-25 핫스팟 세션). provider 가
      // event 없이 던진 경우만 원래 메시지가 없으니 그대로 던진다.
      if (terminalEvent !== undefined) {
        yield withErrorMessage(terminalEvent, failure.message);
        return;
      }
      throw failure;
    }
  }
}
