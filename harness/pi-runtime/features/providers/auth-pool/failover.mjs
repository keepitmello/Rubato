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
    let attemptStream;
    try {
      attemptStream = await options.runAttempt(slot);
      for await (const event of attemptStream) {
        const failure = options.errorFromEvent?.(event);
        if (failure !== undefined) throw failure;
        committedOutput ||= options.isCommittedOutput(event);
        yield event;
      }
      await options.onSuccess?.(slot);
      return;
    } catch (error) {
      if (attemptStream) await settle(attemptStream);
      const failureCount = (slot.failureCount ?? 0) + (retriesBySlot.get(slot.name) ?? 0);
      const action = classify(error, { failureCount });
      lastOriginal = error;
      if (action.kind === "retry_same" && !committedOutput) {
        const used = (retriesBySlot.get(slot.name) ?? 0) + 1;
        retriesBySlot.set(slot.name, used);
        if (used < action.maxAttempts) continue;
        throw new CredentialFailoverError(action, error, { suppressTurnRetry: false });
      }
      if (action.kind !== "failover") {
        throw new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
      }
      if (shouldPersistBlock(action.block, slots)) await options.persistBlock(slot, action.block);
      await options.onRotate?.({ slot, block: action.block, attempt: attempted.size, committedOutput });
      throw new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
    }
  }
}
