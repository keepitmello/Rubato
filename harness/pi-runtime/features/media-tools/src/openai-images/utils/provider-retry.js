import { appendRetryAfterMsMarker, extract429RetryAfterMs } from "./retry-hint.js";
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DIGITALOCEAN_STREAM_FAILURE_MESSAGE = "Upstream error from DigitalOcean: stream failed";
function isProviderError(error) {
    if (!(error instanceof Error))
        return false;
    if (error.message === DIGITALOCEAN_STREAM_FAILURE_MESSAGE)
        return true;
    if (!("status" in error) || !("headers" in error))
        return false;
    return ((error.status === undefined || typeof error.status === "number") &&
        (error.headers === undefined || error.headers instanceof Headers));
}
/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error) {
    const shouldRetry = error.headers?.get("x-should-retry");
    if (shouldRetry === "true")
        return true;
    if (shouldRetry === "false")
        return false;
    if (error.status === undefined)
        return true;
    return (error.status === 408 ||
        error.status === 409 ||
        error.status === 429 ||
        (typeof error.status === "number" && error.status >= 500));
}
function validateServerRetryDelayMs(delayMs, maxRetryDelayMs, providerErrorMessage) {
    const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (maxDelayMs > 0 && delayMs > maxDelayMs) {
        const message = `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`;
        const error = Object.assign(new Error(appendRetryAfterMsMarker(message, delayMs)), {
            retryAfterMs: delayMs,
        });
        throw error;
    }
    return delayMs;
}
function getRetryDelayMs(error, retryIndex, maxRetryDelayMs) {
    const hintMs = extract429RetryAfterMs({
        status: 429,
        headers: error.headers,
        bodyText: "",
    });
    if (hintMs !== undefined) {
        return validateServerRetryDelayMs(hintMs, maxRetryDelayMs, error.message);
    }
    const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
    return exponentialDelay * (1 - Math.random() * 0.25);
}
function createAbortError() {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    return error;
}
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timeout);
            reject(createAbortError());
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, Math.max(0, ms));
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest(request, options = {}) {
    const maxRetries = options.maxRetries ?? 0;
    let retriesRemaining = maxRetries;
    for (;;) {
        try {
            // Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
            return await request();
        }
        catch (error) {
            if (options.signal?.aborted)
                throw createAbortError();
            if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error))
                throw error;
            const retryIndex = maxRetries - retriesRemaining;
            retriesRemaining--;
            await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
        }
    }
}
async function* replayPrefetchedStream(first, iterator) {
    if (first.done)
        return;
    let completed = false;
    let providerFailed = false;
    try {
        yield first.value;
        for (;;) {
            let next;
            try {
                next = await iterator.next();
            }
            catch (error) {
                providerFailed = true;
                throw error;
            }
            if (next.done) {
                completed = true;
                return;
            }
            yield next.value;
        }
    }
    finally {
        if (!completed && !providerFailed) {
            await iterator.return?.();
        }
    }
}
export async function retryProviderStreamRequest(request, options = {}) {
    return retryProviderRequest(async () => {
        const attempt = await request();
        const iterator = attempt.stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        return {
            stream: replayPrefetchedStream(first, iterator),
            metadata: attempt.metadata,
        };
    }, options);
}
