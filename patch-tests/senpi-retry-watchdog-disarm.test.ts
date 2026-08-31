// Provider-timeout retry watchdog must not abort a live stream.
//
// Observed failure: first attempt hit stream-start timeout (90s); the retry
// spent most of that budget waiting, then began producing tokens, and the
// wall-clock watchdog aborted mid-stream → "Aborted after 1 retry attempt".
// Stream-start/idle guards already bound a live request; the watchdog is only
// for wedged continue() before the provider proves life.
import { describe, expect, test } from "bun:test";
import {
  createProviderTimeoutRetryPlan,
  runBoundedRetryContinuation,
} from "../node_modules/@code-yeongyu/senpi/dist/core/provider-timeout-retry.js";
import {
  clarifyProviderStallError,
  sanitizeTuiErrorMessage,
} from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/extension-error-format.js";

function stallMessage(errorMessage: string) {
  return {
    role: "assistant" as const,
    stopReason: "error" as const,
    errorMessage,
    content: [],
  };
}

describe("createProviderTimeoutRetryPlan", () => {
  test("keeps stream-start budget on the retry and reconciles the watchdog up to it", () => {
    const plan = createProviderTimeoutRetryPlan({
      message: stallMessage("Provider stream start timed out after 90000ms"),
      streamRetryTimeoutMs: 30_000,
      timeoutMs: 300_000,
      streamStartTimeoutMs: 90_000,
    });
    expect(plan.options.streamStartTimeoutMs).toBe(90_000);
    expect(plan.options.deferQueuedMessages).toBe(true);
    expect(plan.watchdogTimeoutMs).toBe(90_000);
  });

  test("ignores non-timeout errors", () => {
    const plan = createProviderTimeoutRetryPlan({
      message: stallMessage("429 rate_limit_error"),
      streamRetryTimeoutMs: 30_000,
      timeoutMs: 300_000,
      streamStartTimeoutMs: 90_000,
    });
    expect(plan.watchdogTimeoutMs).toBeUndefined();
    expect(plan.options).toEqual({});
  });
});

describe("runBoundedRetryContinuation", () => {
  test("aborts a wedged continuation that never goes live", async () => {
    const controller = new AbortController();
    let aborted = false;
    const started = Date.now();
    await runBoundedRetryContinuation({
      continueRun: () =>
        new Promise<void>((resolve) => {
          const onAbort = () => {
            aborted = true;
            resolve();
          };
          if (controller.signal.aborted) onAbort();
          else controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
      getActiveSignal: () => controller.signal,
      abortActive: () => controller.abort(),
      timeoutMs: 40,
      isLive: () => false,
    });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("disarms the watchdog once isLive flips true so a slow-then-live retry finishes", async () => {
    const controller = new AbortController();
    let live = false;
    let aborted = false;
    const finished = runBoundedRetryContinuation({
      continueRun: async () => {
        await Bun.sleep(30);
        live = true;
        // Outlive the watchdog budget; without disarm this would abort.
        await Bun.sleep(80);
      },
      getActiveSignal: () => controller.signal,
      abortActive: () => {
        aborted = true;
        controller.abort();
      },
      timeoutMs: 50,
      isLive: () => live,
    });
    await finished;
    expect(aborted).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("clarifyProviderStallError", () => {
  test("adds a rate-limit/overload hint for stream-start stalls without changing the anchor prefix", () => {
    const raw = "Provider stream start timed out after 90000ms";
    const clarified = clarifyProviderStallError(raw);
    expect(clarified.startsWith(raw)).toBe(true);
    expect(clarified).toContain("rate-limit");
    // Stored messages must stay exact for retry classifiers; display path only.
    expect(sanitizeTuiErrorMessage(raw)).toContain("rate-limit");
  });

  test("leaves ordinary errors alone", () => {
    expect(clarifyProviderStallError("429 rate_limit_error")).toBe("429 rate_limit_error");
  });
});
