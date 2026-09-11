import { AssistantMessageEventStream } from "./cursor-event-stream.mjs";

function errorMessage(model, error) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

class CursorLazyStream extends AssistantMessageEventStream {
  #source;
  #iteratorReady;
  #resolveIterator;
  #cancel;

  constructor() {
    super();
    this.#iteratorReady = new Promise((resolve) => {
      this.#resolveIterator = resolve;
    });
  }

  bind(source, iterator) {
    this.#source = source;
    this.#resolveIterator(iterator);
  }

  failBinding() {
    this.#resolveIterator(undefined);
  }

  hasPendingLocalWork() {
    return this.#source?.hasPendingLocalWork?.() === true;
  }

  [Symbol.asyncIterator]() {
    const outer = super[Symbol.asyncIterator]();
    return {
      next: () => outer.next(),
      return: async () => {
        this.#cancel ??= this.#iteratorReady.then((iterator) => iterator?.return?.());
        await this.#cancel;
        return { value: undefined, done: true };
      },
    };
  }
}

async function forward(target, source, iterator) {
  target.bind(source, iterator);
  for (;;) {
    const event = await iterator.next();
    if (event.done) break;
    target.push(event.value);
  }
  target.end(typeof source.result === "function" ? await source.result() : undefined);
}

export function lazyStream(model, setup) {
  const outer = new CursorLazyStream();
  Promise.resolve()
    .then(setup)
    .then(async (source) => forward(outer, source, source[Symbol.asyncIterator]()))
    .catch((error) => {
      outer.failBinding();
      const message = errorMessage(model, error);
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    });
  return outer;
}

export function lazyApi(load) {
  return {
    stream: (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
    streamSimple: (model, context, options) => lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
  };
}
