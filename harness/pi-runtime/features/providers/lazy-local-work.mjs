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
  const next = replaceOnce(sourceText, LAZY_NEEDLE, LAZY_REPLACEMENT, "lazy-local-work");
  return patchLazyBaiRoute(next);
}

// `lazyApi` 는 pi-ai 의 HTTP API(anthropic-messages, openai-completions, …)가 모두
// 지나는 입구다. ModelRuntime 경로도, compat `completeSimple` 경로도 여기로 온다.
// 모델을 불러오기 전에 b.ai 경계를 본다 — 걸리면 요청을 만들지 않고 에러 이벤트로
// 끝난다. 규칙은 `rubato-pi/src/bai-route.mjs` 가 소유한다.
const LAZY_IMPORT_NEEDLE = `import { AssistantMessageEventStream } from "../utils/event-stream.js";\n`;
const LAZY_IMPORT_REPLACEMENT = `${LAZY_IMPORT_NEEDLE}import { assertBaiRoute } from "../rubato-features/providers/src/bai-route.mjs";\n`;
const LAZY_API_NEEDLE = `        stream: (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
        streamSimple: (model, context, options) => lazyStream(model, async () => (await load()).streamSimple(model, context, options)),`;
const LAZY_API_REPLACEMENT = `        stream: (model, context, options) => lazyStream(model, async () => {
            assertBaiRoute(model);
            return (await load()).stream(model, context, options);
        }),
        streamSimple: (model, context, options) => lazyStream(model, async () => {
            assertBaiRoute(model);
            return (await load()).streamSimple(model, context, options);
        }),`;

export function patchLazyBaiRoute(sourceText) {
  const withImport = replaceOnce(sourceText, LAZY_IMPORT_NEEDLE, LAZY_IMPORT_REPLACEMENT, "lazy-bai-route-import");
  return replaceOnce(withImport, LAZY_API_NEEDLE, LAZY_API_REPLACEMENT, "lazy-bai-route");
}
