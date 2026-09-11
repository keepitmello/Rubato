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

function isAvailable(slot, now) {
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
    const candidates = slots.filter((slot) => !attempted.has(slot.name) && isAvailable(slot, now()));
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
      await options.persistBlock(slot, action.block);
      attempted.add(slot.name);
      const failure = new CredentialFailoverError(action, error, { suppressTurnRetry: committedOutput });
      lastError = failure;
      await options.onRotate?.({ slot, block: action.block, attempt: attempted.size, committedOutput });
      if (committedOutput) throw failure;
    }
  }
}
