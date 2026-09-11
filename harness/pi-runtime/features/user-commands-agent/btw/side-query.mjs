export const SIDE_QUERY_INSTRUCTION = [
  "The user is asking a side question about the conversation so far, outside the main task.",
  "Answer it directly and concisely from the context above.",
  "Do not continue any task, do not modify anything, and do not treat this as new work.",
].join(" ");

export const DEFAULT_ESTABLISHMENT_TIMEOUT_MS = 30_000;

export function getSideQueryPromptContextWindow(model) {
  const windowSize = model?.contextWindow;
  const maxTokens = model?.maxTokens;
  if (typeof windowSize !== "number" || !Number.isFinite(windowSize) || windowSize <= 0) return undefined;
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) return windowSize;
  return Math.max(1, windowSize - maxTokens);
}

export function buildSideQueryContext(input) {
  const systemPrompt = input.systemPrompt + "\n\n" + SIDE_QUERY_INSTRUCTION;
  const messages = [...input.history, { role: "user", content: input.question, timestamp: Date.now() }];
  return { systemPrompt, messages, tools: [] };
}

export async function runSideQuery(deps, context, callbacks = {}) {
  callbacks.signal?.throwIfAborted?.();
  const streamFn = deps.streamFn;
  if (typeof streamFn !== "function") throw new Error("/btw requires a model stream");
  const establishment = new AbortController();
  const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, establishment.signal]) : establishment.signal;
  const timeoutMs = deps.establishmentTimeoutMs ?? DEFAULT_ESTABLISHMENT_TIMEOUT_MS;
  const timeoutError = new Error("/btw provider did not produce an event within " + Math.round(timeoutMs / 1000) + "s");
  let timer;
  try {
    const options = {
      apiKey: deps.auth.apiKey,
      headers: deps.auth.headers,
      extraBody: deps.auth.extraBody,
      sessionId: deps.sessionId + ":btw:" + crypto.randomUUID(),
      reasoning: deps.thinkingLevel,
      signal,
    };
    timer = setTimeout(() => establishment.abort(timeoutError), timeoutMs);
    timer.unref?.();
    const stream = await streamFn(deps.model, context, options);
    let established = false;
    let replyText = "";
    for await (const event of stream) {
      if (!established && event.type !== "start") {
        established = true;
        clearTimeout(timer);
        timer = undefined;
      }
      if (event.type === "text_delta") {
        replyText += event.delta;
        callbacks.onTextDelta?.(event.delta);
      } else if (event.type === "done") {
        break;
      } else if (event.type === "error") {
        throw new Error(event.error?.errorMessage || "Side query failed");
      }
    }
    signal.throwIfAborted?.();
    return { replyText };
  } catch (error) {
    if (establishment.signal.aborted && !callbacks.signal?.aborted) throw timeoutError;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

