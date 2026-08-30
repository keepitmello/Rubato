/**
 * Rubato Engine in-process Antigravity transport.
 *
 * This adapter intentionally owns only the Cloud Code Assist wire dialect.
 * Provider registration, OAuth locking, and session lineage live in
 * antigravity-route.mjs.
 */

import { pathToFileURL } from "node:url";
import { senpiNested } from "./engine-paths.mjs";

const { createAssistantMessageEventStream } = await import(
  pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/utils/event-stream.js")).href
);
const {
  convertMessages: convertGoogleMessages,
} = await import(pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/api/google-shared.js")).href);
import { nextAntigravityEnvelope } from "./antigravity-state.mjs";

export const ANTIGRAVITY_API = "rubato-antigravity";
export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_PROJECT_ENV = "RUBATO_ANTIGRAVITY_PROJECT";

const WIRE_MODELS = Object.freeze({
  "gemini-3.7-flash": Object.freeze({
    default: "gemini-3.7-flash-low",
    minimal: "gemini-3.7-flash-low",
    low: "gemini-3.7-flash-low",
    medium: "gemini-3.7-flash-medium",
    high: "gemini-3.7-flash-high",
  }),
  "gemini-3.1-pro": Object.freeze({
    default: "gemini-3.1-pro-low",
    low: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
  }),
});

export function resolveAntigravityWireModel(modelId, reasoning) {
  const table = WIRE_MODELS[modelId];
  if (!table) throw new Error(`Unknown Antigravity model: ${modelId}`);
  return table[reasoning] ?? table.default;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function antigravityUsage(metadata = {}) {
  const cacheRead = finiteNonNegative(metadata.cachedContentTokenCount);
  const input = Math.max(0, finiteNonNegative(metadata.promptTokenCount) - cacheRead);
  const reasoning = finiteNonNegative(metadata.thoughtsTokenCount);
  const output = finiteNonNegative(metadata.candidatesTokenCount) + reasoning;
  const reportedTotal = metadata.totalTokenCount;
  const totalTokens = Number.isFinite(reportedTotal) && reportedTotal >= 0
    ? reportedTotal
    : input + output + cacheRead;

  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emptyAssistant(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: antigravityUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function normalizeEnv(env) {
  if (!env) return {};
  if (env instanceof Map) return Object.fromEntries(env);
  return env;
}

function resolveProject(options) {
  const env = normalizeEnv(options?.env);
  const project = env[ANTIGRAVITY_PROJECT_ENV];
  if (typeof project !== "string" || project.trim().length === 0) {
    throw new Error(`Antigravity credential is missing ${ANTIGRAVITY_PROJECT_ENV}`);
  }
  return project.trim();
}

function systemInstruction(context) {
  if (typeof context.systemPrompt !== "string" || context.systemPrompt.length === 0) return undefined;
  return { role: "user", parts: [{ text: context.systemPrompt }] };
}

function toolDeclarations(context) {
  if (!Array.isArray(context.tools) || context.tools.length === 0) return undefined;
  return [{
    functionDeclarations: context.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];
}

/**
 * 우리가 아는 Antigravity 능력을 descriptor 에 보장한다.
 *
 * 상류가 준 값을 존중하되, 없으면 채운다. 덮어쓰지 않는 이유는 catalog 가 우리보다 최신일
 * 수 있기 때문이고, 채우는 이유는 없는 값으로 pinned encoder 가 죽기 때문이다.
 */
export function withAntigravityCapabilities(model) {
  if (Array.isArray(model?.input) && model.input.length > 0) return model;
  return { ...model, input: ["text", "image"] };
}

export function buildAntigravityRequest(model, context, options = {}, state = undefined) {
  if (!state) throw new Error("Antigravity conversation state is missing");
  const envelope = nextAntigravityEnvelope(state);
  const wireModel = resolveAntigravityWireModel(model.id, options.reasoning);
  const generationConfig = {
    maxOutputTokens: options.maxTokens ?? model.maxTokens,
  };
  if (typeof options.temperature === "number") generationConfig.temperature = options.temperature;

  const request = {
    // `model` 을 그대로 넘기지 않는다. pinned encoder 의 `toolResult` 분기는
    // `model.input.includes("image")` 를 **가드 없이** 읽는다(`api/google-shared.js:206`).
    // 그래서 catalog 가 `input` 없는 descriptor 를 주면 도구 결과를 실으려는 순간
    // TypeError 로 턴이 통째로 빈다 — 실제로 겪었고, 원인은 같은 모델 id 를 들고 있는
    // 다른 lane 의 catalog 였다. 그 lane 을 끄는 것과 별개로, 우리 능력 선언은 우리가
    // 책임진다. 여기서 채우면 상류 descriptor 가 무엇이든 이 경로는 성립한다.
    contents: convertGoogleMessages(withAntigravityCapabilities(model), context, { preserveThinking: true }),
    sessionId: envelope.sessionId,
    labels: envelope.labels,
    generationConfig,
  };
  const instruction = systemInstruction(context);
  if (instruction) request.systemInstruction = instruction;
  const tools = toolDeclarations(context);
  if (tools) request.tools = tools;

  return {
    project: resolveProject(options),
    requestId: envelope.requestId,
    request,
    model: wireModel,
    userAgent: "antigravity",
    requestType: "agent",
  };
}

export function parseAntigravitySse(body) {
  if (!body) throw new Error("Antigravity response has no body");
  const decoder = new TextDecoder();

  return (async function* () {
    let buffer = "";
    for await (const raw of body) {
      buffer += decoder.decode(raw, { stream: true });
      while (true) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary < 0) break;
        const match = buffer.slice(boundary).match(/^(\r?\n){2}/)?.[0] ?? "\n\n";
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match.length);
        yield parseFrame(frame);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      // A complete SSE record must terminate with a blank line. Accepting a tail
      // makes a truncated JSON object look like a clean provider stop.
      throw new Error("Antigravity stream ended with an incomplete SSE frame");
    }
  })();
}

function parseFrame(frame) {
  const data = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine.length === 0 || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    const value = colon < 0 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
  }
  if (data.length === 0) throw new Error("Antigravity SSE frame has no data field");
  const value = data.join("\n");
  if (value === "[DONE]") return { done: true };
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Malformed Antigravity SSE JSON: ${error.message}`, { cause: error });
  }
}

function finishCurrent(stream, output, current) {
  if (!current) return;
  const contentIndex = output.content.length - 1;
  if (current.type === "text") {
    stream.push({ type: "text_end", contentIndex, content: current.text, partial: output });
  } else {
    stream.push({ type: "thinking_end", contentIndex, content: current.thinking, partial: output });
  }
}

function stopReason(reason, hasToolCalls) {
  const normalized = String(reason ?? "").toUpperCase();
  if (hasToolCalls && normalized === "STOP") return "toolUse";
  if (normalized === "STOP" || normalized === "MAX_TOKENS") return normalized === "STOP" ? "stop" : "length";
  return "error";
}

function candidateEnvelope(chunk) {
  if (chunk && typeof chunk === "object" && chunk.response && typeof chunk.response === "object") {
    return chunk.response;
  }
  return chunk;
}

function providerError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createAntigravityApi({
  fetchImpl = globalThis.fetch,
  endpoint = ANTIGRAVITY_ENDPOINT,
  runStateful,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (runStateful !== undefined && typeof runStateful !== "function") {
    throw new TypeError("runStateful must be a function");
  }

  const stream = (model, context, options = {}) => {
    // 내부 재호출은 state를 이미 받았으므로 다시 queue에 넣지 않는다. 그러지 않으면
    // wrapper가 자기 자신을 재귀 호출해 stack overflow가 난다.
    if (runStateful && !options.antigravityState) {
      const outer = createAssistantMessageEventStream();
      void runStateful(options, async (state) => {
        const inner = stream(model, context, { ...options, antigravityState: state });
        for await (const event of inner) {
          outer.push(event);
        }
        return await inner.result();
      }).catch((error) => {
        // inner가 이미 terminal event를 전달했다면 outer는 done이고, 두 번째 error를
        // 내면 한 logical call에 terminal이 둘 생긴다. runStateful 자체의 실패만 낸다.
        if (outer.done) return;
        const output = emptyAssistant(model);
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = providerError(error);
        outer.push({ type: "error", reason: output.stopReason, error: output });
        outer.end(output);
      });
      return outer;
    }
    const eventStream = createAssistantMessageEventStream();
    const output = emptyAssistant(model);

    void (async () => {
      let current = undefined;
      let finishSeen = false;
      let providerState = options.antigravityState;
      try {
        const apiKey = options.apiKey;
        if (typeof apiKey !== "string" || apiKey.length === 0) {
          throw new Error("Antigravity OAuth access token is missing");
        }
        if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");

        const body = buildAntigravityRequest(model, context, options, providerState);
        const response = await fetchImpl(new URL("/v1internal:streamGenerateContent?alt=sse", endpoint), {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            "user-agent": "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64)",
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Antigravity HTTP ${response.status}: ${text.slice(0, 512)}`);
        }

        eventStream.push({ type: "start", partial: output });
        for await (const wire of parseAntigravitySse(response.body)) {
          if (wire.done) continue;
          const chunk = candidateEnvelope(wire);
          if (!chunk || typeof chunk !== "object") throw new Error("Invalid Antigravity response chunk");
          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (part.text === undefined && !part.functionCall && typeof part.thoughtSignature === "string") {
              finishCurrent(eventStream, output, current);
              current = part.thought === true
                ? { type: "thinking", thinking: "", thinkingSignature: part.thoughtSignature }
                : { type: "text", text: "", textSignature: part.thoughtSignature };
              output.content.push(current);
              eventStream.push({
                type: current.type === "thinking" ? "thinking_start" : "text_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            if (part.text !== undefined) {
              const type = part.thought === true ? "thinking" : "text";
              if (!current || current.type !== type) {
                finishCurrent(eventStream, output, current);
                current = type === "thinking"
                  ? { type, thinking: "", thinkingSignature: undefined }
                  : { type, text: "", textSignature: undefined };
                output.content.push(current);
                eventStream.push({
                  type: type === "thinking" ? "thinking_start" : "text_start",
                  contentIndex: output.content.length - 1,
                  partial: output,
                });
              }
              if (type === "thinking") {
                current.thinking += part.text;
                if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
                  current.thinkingSignature = part.thoughtSignature;
                }
                eventStream.push({ type: "thinking_delta", contentIndex: output.content.length - 1, delta: part.text, partial: output });
              } else {
                current.text += part.text;
                if (typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
                  current.textSignature = part.thoughtSignature;
                }
                eventStream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta: part.text, partial: output });
              }
            }

            if (part.functionCall) {
              finishCurrent(eventStream, output, current);
              current = undefined;
              const call = {
                type: "toolCall",
                id: part.functionCall.id || `${part.functionCall.name}_${globalThis.crypto.randomUUID()}`,
                name: part.functionCall.name || "",
                arguments: part.functionCall.args ?? {},
                ...(typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
                  ? { thoughtSignature: part.thoughtSignature }
                  : {}),
              };
              output.content.push(call);
              const contentIndex = output.content.length - 1;
              eventStream.push({ type: "toolcall_start", contentIndex, partial: output });
              eventStream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
              eventStream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
            }
          }

          if (candidate?.finishReason) {
            finishSeen = true;
            output.rawStopReason = candidate.finishReason;
            output.stopReason = stopReason(candidate.finishReason, output.content.some((part) => part.type === "toolCall"));
          }
          if (chunk.usageMetadata) output.usage = antigravityUsage(chunk.usageMetadata);
          if (typeof chunk.responseId === "string" && chunk.responseId.length > 0) output.responseId = chunk.responseId;
        }

        finishCurrent(eventStream, output, current);
        if (!finishSeen) throw new Error("Antigravity stream ended without a finish reason");
        if (output.stopReason === "error") throw new Error(`Antigravity stopped with ${output.rawStopReason}`);
        if (providerState && typeof providerState === "object") {
          if (output.responseId) providerState.lastExecutionId = output.responseId;
        }
        eventStream.push({ type: "done", reason: output.stopReason, message: output });
        eventStream.end();
      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = providerError(error);
        eventStream.push({ type: "error", reason: output.stopReason, error: output });
        eventStream.end();
      }
    })();

    return eventStream;
  };

  const streamSimple = (model, context, options = {}) => stream(model, context, options);
  return Object.freeze({ stream, streamSimple });
}
