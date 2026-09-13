function replaceOnce(sourceText, before, after, label) {
  const first = sourceText.indexOf(before);
  if (first === -1 || sourceText.indexOf(before, first + before.length) !== -1) {
    throw new Error(`[providers:${label}] expected stock anchor exactly once`);
  }
  return sourceText.slice(0, first) + after + sourceText.slice(first + before.length);
}

const EVENT_STREAM_NEEDLE = `    result() {
        return this.finalResultPromise;
    }
}
export class AssistantMessageEventStream extends EventStream {`;

const EVENT_STREAM_REPLACEMENT = `    result() {
        return this.finalResultPromise;
    }
    setLocalWorkDelegate(delegate) {
        this.localWorkDelegate = delegate;
    }
    async trackLocalWork(work) {
        const delegate = this.localWorkDelegate;
        if (delegate && typeof delegate.trackLocalWork === "function") {
            return delegate.trackLocalWork(work);
        }
        this.localWorkDepth = (this.localWorkDepth ?? 0) + 1;
        try {
            return await work;
        }
        finally {
            this.localWorkDepth--;
        }
    }
    hasPendingLocalWork() {
        const delegate = this.localWorkDelegate;
        if (delegate && typeof delegate.hasPendingLocalWork === "function") {
            return delegate.hasPendingLocalWork() || (this.localWorkDepth ?? 0) > 0;
        }
        return (this.localWorkDepth ?? 0) > 0;
    }
}
export class AssistantMessageEventStream extends EventStream {`;

const LAZY_NEEDLE = `export function lazyStream(model, setup) {
    const outer = new AssistantMessageEventStream();
    setup()
        .then((inner) => forwardStream(outer, inner))`;

const LAZY_REPLACEMENT = `export function lazyStream(model, setup) {
    const outer = new AssistantMessageEventStream();
    setup()
        .then((inner) => {
            outer.setLocalWorkDelegate(inner);
            return forwardStream(outer, inner);
        })`;

export function patchEventStreamLocalWork(sourceText) {
  return replaceOnce(sourceText, EVENT_STREAM_NEEDLE, EVENT_STREAM_REPLACEMENT, "event-stream-local-work");
}

export function patchLazyLocalWork(sourceText) {
  return replaceOnce(sourceText, LAZY_NEEDLE, LAZY_REPLACEMENT, "lazy-local-work");
}
