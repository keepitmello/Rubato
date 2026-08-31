import { replaceOnce } from "./misc-replace.mjs";

const METHODS_NEEDLE = "    setCancellationHandler(handler) {\n        this.cancellationHandler = handler;\n    }\n    [Symbol.asyncIterator]() {";

const METHODS_REPLACEMENT = "    setCancellationHandler(handler) {\n        this.cancellationHandler = handler;\n    }\n    /**\n     * The lazy stream is what callers hold, but the local-work bookkeeping lives\n     * on the inner provider stream created behind setup. The agent loop re-arms its\n     * idle deadline from the stream it holds (pi-agent-core agent-loop.js:\n     * `stream?.hasPendingLocalWork?.()`), so without this delegation a\n     * server-driven tool run that outlasts the idle bound looks like a dead\n     * request and a healthy stream gets torn down.\n     */\n    setLocalWorkDelegate(delegate) {\n        this.localWorkDelegate = delegate;\n    }\n    trackLocalWork(work) {\n        const delegate = this.localWorkDelegate;\n        if (delegate && typeof delegate.trackLocalWork === \"function\") {\n            return delegate.trackLocalWork(work);\n        }\n        return super.trackLocalWork(work);\n    }\n    hasPendingLocalWork() {\n        const delegate = this.localWorkDelegate;\n        if (delegate && typeof delegate.hasPendingLocalWork === \"function\") {\n            return delegate.hasPendingLocalWork() || super.hasPendingLocalWork();\n        }\n        return super.hasPendingLocalWork();\n    }\n    [Symbol.asyncIterator]() {";

const SETUP_NEEDLE = "        return cancellation;\n    });\n    Promise.all([inner, iterator])";

const SETUP_REPLACEMENT = "        return cancellation;\n    });\n    // Point local-work questions at the real provider stream as soon as setup\n    // resolves. Setup itself emits no events, so there is no window where the\n    // agent loop would consult a stale delegate.\n    void inner.then((source) => outer.setLocalWorkDelegate(source), () => {});\n    Promise.all([inner, iterator])";

export function isPiAiLazyUrl(url) {
  return url.includes("@earendil-works/pi-ai/dist/api/lazy.js");
}

/**
 * Baseline pi-ai lazy.js: delegate trackLocalWork / hasPendingLocalWork.
 *
 * @param {string} source
 * @returns {string}
 */
export function injectPiAiLazy(source) {
  let next = replaceOnce(source, METHODS_NEEDLE, METHODS_REPLACEMENT, "lazy local-work methods");
  return replaceOnce(next, SETUP_NEEDLE, SETUP_REPLACEMENT, "lazy local-work delegate setup");
}
