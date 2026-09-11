export class CursorRetryableStreamError extends Error {
    constructor(message, retryCause, options) {
        super(message, options);
        this.name = "CursorRetryableStreamError";
        this.retryCause = retryCause;
    }
}
export function isCursorRetryableStreamError(error) {
    return error instanceof CursorRetryableStreamError;
}
export function cursorStreamRetryDelayMs(options) {
    if (options.fixedDelayMs !== undefined)
        return Math.max(0, options.fixedDelayMs);
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const backoffMs = Math.min(baseDelayMs * 2 ** options.attempt, 60_000);
    const jitter = Math.floor(backoffMs * 0.2 * (options.random ?? Math.random)());
    return backoffMs + jitter;
}
export function shouldRetryCursorStream(options) {
    return (!options.sawTurnEnded &&
        !options.aborted &&
        options.retries < options.maxRetries &&
        isCursorRetryableStreamError(options.error));
}
export async function waitForCursorStreamRetry(delayMs, signal) {
    if (delayMs <= 0 || signal?.aborted)
        return;
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=stream-retry.js.map