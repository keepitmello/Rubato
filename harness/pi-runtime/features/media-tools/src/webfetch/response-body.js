export async function discardBody(body, maxBytes, signal) {
    body.on?.("error", () => { });
    try {
        if (typeof body.dump === "function") {
            await body.dump(signal ? { limit: 1024, signal } : { limit: 1024 });
            return;
        }
        await drainBody(body, maxBytes, signal);
    }
    catch {
        // no-excuse-ok: catch - discard failures are not actionable for the caller.
    }
    finally {
        body.destroy();
    }
}
async function drainBody(body, maxBytes, signal) {
    let drained = 0;
    const iterator = body[Symbol.asyncIterator]();
    while (true) {
        const result = await nextChunk(iterator, signal);
        if (!result || result.done)
            return;
        drained += toUint8Array(result.value).length;
        if (drained > maxBytes)
            return;
    }
}
async function nextChunk(iterator, signal) {
    if (!signal)
        return iterator.next();
    if (signal.aborted)
        return undefined;
    let resolveAbort = () => { };
    const aborted = new Promise((resolve) => {
        resolveAbort = () => resolve(undefined);
    });
    const onAbort = () => resolveAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await Promise.race([iterator.next(), aborted]);
    }
    finally {
        signal.removeEventListener("abort", onAbort);
    }
}
export function toUint8Array(chunk) {
    if (chunk instanceof Uint8Array)
        return chunk;
    if (typeof chunk === "string")
        return new TextEncoder().encode(chunk);
    throw new Error("Unexpected response body chunk");
}
//# sourceMappingURL=response-body.js.map