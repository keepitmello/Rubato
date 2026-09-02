// Anthropic 최종 요청·응답 계측 (캐시 실사용).
//
// `measurement-recorder.mjs` 는 pi 공통 context(`body.prompt`)로 구간을 가른다 — 그것은
// **중간 표현**이다. Anthropic 프롬프트 캐시는 실제로 전송된 `system`/`tools`/`messages`
// 바이트가 기준이므로, 실사에는 SDK 가 직렬화한 HTTP body 그 자체가 필요하다.
//
// 그래서 여기는 provider 에 `options.fetch` 로 들어가 SDK 가 부르는 fetch 를 감싼다.
// 요청 body 문자열을 그대로 저장하고, 구간별 해시로 직전 요청과 첫 변경 지점을
// 찾고, 응답 SSE 를 tee 해 원시 usage 를 남긴다.
//
// 가족:
// - Anthropic Messages (`/v1/messages`) — system/tools/messages, cache_* usage
// - OpenAI Codex Responses (`/codex/responses`) — instructions/tools/input,
//   `cached_tokens`. Codex 기본 전송은 WebSocket 이라 실사 훅이 안 보이므로
//   `rubato-stream` 이 audit 켜진 세션에서만 `options.transport = "sse"` 를 넣는다.
// - xAI OpenAI-Responses (`/v1/responses`) — 같은 구간·usage. SDK 기본이 SSE.
// - Gemini/Antigravity (`streamGenerateContent`) — params/systemInstruction/
//   functionDeclarations/contents. usageMetadata 의 cachedContentTokenCount.
//
// 선택 주입(테스트 세션 전용):
// - `RUBATO_CACHE_AUDIT_DIAGNOSTICS=1`  → `cache-diagnosis-2026-04-07` 베타 +
//   `diagnostics.previous_message_id` (세션별 직전 응답 id)
// - `RUBATO_CACHE_AUDIT_BLOCK_BINDING=1` → `thinking-binding-controls-2026-08-01` 베타 +
//   `thinking.block_binding.prefix_mismatch_behavior = "drop_block"`
//
// 주입이 없으면 body 는 바이트 하나 건드리지 않고 그대로 나간다.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

export const CACHE_AUDIT_SCHEMA_VERSION = 1;
export const CACHE_DIAGNOSIS_BETA = "cache-diagnosis-2026-04-07";
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

export function cacheAuditEnabled(env = process.env) {
  return typeof env.RUBATO_CACHE_AUDIT_DIR === "string" && env.RUBATO_CACHE_AUDIT_DIR.length > 0;
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function headersToRecord(headers) {
  const record = {};
  if (!headers) return record;
  const iterable = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [key, value] of iterable) {
    if (value === undefined || value === null) continue;
    record[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return record;
}

function redactHeaders(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = REDACTED_HEADERS.has(key) ? "<redacted>" : value;
  }
  return out;
}

/**
 * 최종 Anthropic body 를 캐시 접두사 순서(system → tools → messages)로 구간화한다.
 * 각 구간은 그 블록의 JSON 직렬화 해시다. `params` 는 캐시 키에 영향을 주는 나머지
 * 필드(model, thinking, tool_choice, context_management, output_config …)다.
 */
export function anthropicSegments(body) {
  const segments = [];
  const push = (section, index, value) => {
    const serialized = JSON.stringify(value);
    segments.push({ section, index, digest: sha(serialized), bytes: Buffer.byteLength(serialized) });
  };
  const { system, tools, messages, stream, max_tokens, metadata, diagnostics, ...rest } = body ?? {};
  push("params", 0, rest);
  if (typeof system === "string") push("system", 0, system);
  else if (Array.isArray(system)) system.forEach((block, index) => push("system", index, block));
  if (Array.isArray(tools)) tools.forEach((tool, index) => push("tools", index, tool));
  if (Array.isArray(messages)) messages.forEach((message, index) => push("messages", index, message));
  return segments;
}

/**
 * Codex / OpenAI-Responses body 를 캐시 접두사 순서(params → instructions → tools → input)로
 * 구간화한다. `params` 는 instructions/tools/input 을 뺀 나머지(model, store,
 * previous_response_id, prompt_cache_key, reasoning …).
 */
export function responsesSegments(body) {
  const segments = [];
  const push = (section, index, value) => {
    const serialized = JSON.stringify(value);
    segments.push({ section, index, digest: sha(serialized), bytes: Buffer.byteLength(serialized) });
  };
  const { instructions, tools, input, ...rest } = body ?? {};
  push("params", 0, rest);
  if (instructions !== undefined) push("instructions", 0, instructions);
  if (Array.isArray(tools)) tools.forEach((tool, index) => push("tools", index, tool));
  if (Array.isArray(input)) input.forEach((item, index) => push("input", index, item));
  return segments;
}

const ANTIGRAVITY_PARAM_FIELDS = ["project", "requestId", "sessionId", "labels", "generationConfig"];

/** Antigravity params 스냅샷. 구간 해시와 필드별 변경 기록에 같은 값을 쓴다. */
export function antigravityParamsOf(body) {
  const request = body?.request && typeof body.request === "object" ? body.request : {};
  return {
    project: body?.project ?? null,
    requestId: body?.requestId ?? null,
    sessionId: request.sessionId ?? null,
    labels: request.labels ?? null,
    generationConfig: request.generationConfig ?? null,
  };
}

/** Which `params` sub-fields differ. Nested generationConfig keys use `generationConfig.maxOutputTokens`. */
export function changedAntigravityParamFields(previous, current) {
  const changed = [];
  for (const field of ANTIGRAVITY_PARAM_FIELDS) {
    if (JSON.stringify(previous?.[field] ?? null) !== JSON.stringify(current?.[field] ?? null)) {
      changed.push(field);
    }
  }
  const prevCfg = previous?.generationConfig && typeof previous.generationConfig === "object" ? previous.generationConfig : {};
  const currCfg = current?.generationConfig && typeof current.generationConfig === "object" ? current.generationConfig : {};
  for (const key of new Set([...Object.keys(prevCfg), ...Object.keys(currCfg)])) {
    if (JSON.stringify(prevCfg[key] ?? null) !== JSON.stringify(currCfg[key] ?? null)) {
      changed.push(`generationConfig.${key}`);
    }
  }
  return changed;
}

/**
 * Antigravity body 를 캐시 접두사 순서(params → systemInstruction → tools → contents)로
 * 구간화한다. `tools[i]` 는 각 `functionDeclaration`. `params` 는 project /
 * requestId / request.sessionId / request.labels / request.generationConfig.
 */
export function antigravitySegments(body) {
  const segments = [];
  const push = (section, index, value) => {
    const serialized = JSON.stringify(value);
    segments.push({ section, index, digest: sha(serialized), bytes: Buffer.byteLength(serialized) });
  };
  const request = body?.request && typeof body.request === "object" ? body.request : {};
  push("params", 0, antigravityParamsOf(body));
  if (request.systemInstruction !== undefined) push("systemInstruction", 0, request.systemInstruction);
  if (Array.isArray(request.tools)) {
    let index = 0;
    for (const tool of request.tools) {
      if (!Array.isArray(tool?.functionDeclarations)) continue;
      for (const declaration of tool.functionDeclarations) {
        push("tools", index, declaration);
        index += 1;
      }
    }
  }
  if (Array.isArray(request.contents)) request.contents.forEach((content, index) => push("contents", index, content));
  return segments;
}

/** 직전 요청과 비교해 접두사가 처음 갈라지는 구간. 없으면 undefined (완전 동일). */
export function firstChangedAnthropicSegment(previous = [], current = []) {
  const length = Math.max(previous.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const before = previous[index];
    const after = current[index];
    if (!before || !after) {
      return { section: (after ?? before).section, index: (after ?? before).index, kind: after ? "appended" : "removed", position: index };
    }
    if (before.section !== after.section || before.index !== after.index || before.digest !== after.digest) {
      return { section: after.section, index: after.index, kind: "changed", position: index };
    }
  }
  return undefined;
}

function betaList(value) {
  return typeof value === "string" && value.length > 0 ? value.split(",").map((beta) => beta.trim()).filter(Boolean) : [];
}

function summarizeMessageStart(message) {
  if (!message || typeof message !== "object") return undefined;
  const { content, ...rest } = message;
  return rest;
}

/** SSE 본문에서 `data:` JSON 이벤트를 읽어 message_start / message_delta / error 를 모은다. */
export function parseAnthropicSse(text) {
  const summary = { messageStart: undefined, messageDelta: undefined, errors: [], contentBlocks: [] };
  let block = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const payload = rawLine.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    switch (event?.type) {
      case "message_start":
        summary.messageStart = summarizeMessageStart(event.message);
        break;
      case "message_delta":
        summary.messageDelta = { ...(summary.messageDelta ?? {}), ...event };
        break;
      case "content_block_start":
        block = { index: event.index, type: event.content_block?.type, ...(event.content_block?.id ? { id: event.content_block.id } : {}) };
        summary.contentBlocks.push(block);
        break;
      case "content_block_delta":
        if (block && event.delta?.type === "signature_delta") block.signatureBytes = (block.signatureBytes ?? 0) + Buffer.byteLength(event.delta.signature ?? "");
        break;
      case "error":
        summary.errors.push(event.error ?? event);
        break;
      default:
        break;
    }
  }
  return summary;
}

/** Antigravity SSE 에서 마지막 usageMetadata 와 responseId/model 을 모은다. */
export function parseAntigravitySse(text) {
  const summary = { usageMetadata: undefined, responseId: undefined, model: undefined, errors: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const payload = rawLine.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event?.error) summary.errors.push(event.error);
    const chunk = event?.response && typeof event.response === "object" ? event.response : event;
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.usageMetadata) summary.usageMetadata = chunk.usageMetadata;
    if (typeof chunk.responseId === "string" && chunk.responseId.length > 0) summary.responseId = chunk.responseId;
    if (typeof chunk.model === "string" && chunk.model.length > 0) summary.model = chunk.model;
    else if (typeof event?.model === "string" && event.model.length > 0) summary.model = event.model;
  }
  return summary;
}

/** SSE 본문에서 Responses API 의 response.created / response.completed / error 를 모은다. */
export function parseResponsesSse(text) {
  const summary = { created: undefined, completed: undefined, errors: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const payload = rawLine.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    switch (event?.type) {
      case "response.created":
        summary.created = event.response ?? event;
        break;
      case "response.completed":
        summary.completed = event.response ?? event;
        break;
      case "response.failed":
      case "error":
        summary.errors.push(event.error ?? event.response ?? event);
        break;
      default:
        break;
    }
  }
  return summary;
}

function responsesFamilyFromUrl(url) {
  if (/\/codex\/responses(\?|$)/.test(url)) return "codex";
  if (/\/v1\/responses(\?|$)/.test(url)) return "xai";
  return undefined;
}

function initBodyText(init) {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body == null) return undefined;
  let buffer;
  if (body instanceof ArrayBuffer) buffer = Buffer.from(body);
  else if (ArrayBuffer.isView(body)) buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else return undefined;
  const encoding = headersToRecord(init.headers)["content-encoding"] ?? "";
  if (/(?:^|[,\s])zstd(?:[,\s]|$)/i.test(encoding) && typeof zlib.zstdDecompressSync === "function") {
    try { buffer = Buffer.from(zlib.zstdDecompressSync(buffer)); } catch { /* keep raw bytes */ }
  }
  return buffer.toString("utf8");
}

export function createCacheAudit({ env = process.env, dir = env.RUBATO_CACHE_AUDIT_DIR, now = () => new Date() } = {}) {
  if (!dir) return undefined;
  const rawDir = join(dir, "raw");
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  const logPath = join(dir, "audit.jsonl");
  const injectDiagnostics = env.RUBATO_CACHE_AUDIT_DIAGNOSTICS === "1";
  const injectBlockBinding = env.RUBATO_CACHE_AUDIT_BLOCK_BINDING === "1";
  let sequence = 0;
  /** @type {Map<string, { segments: Array<object>, lastResponseId?: string, lastResponseModel?: string }>} */
  const sessions = new Map();

  const record = (type, fields) => {
    const event = { schemaVersion: CACHE_AUDIT_SCHEMA_VERSION, type, at: now().toISOString(), ...fields };
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  };
  const writeRaw = (name, text) => {
    const path = join(rawDir, name);
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    return path;
  };
  const sessionState = (sessionId) => {
    const key = sessionId ?? "anonymous";
    if (!sessions.has(key)) sessions.set(key, { segments: [] });
    return sessions.get(key);
  };

  /**
   * body/headers 에 선택 주입을 적용한다. 주입이 없으면 원본 문자열을 그대로 돌려준다.
   * (JSON 재직렬화는 키 순서를 지키지만, 바이트 동일성을 위해 재직렬화 자체를 피한다.)
   */
  const applyInjections = (bodyText, headers, state) => {
    if (!injectDiagnostics && !injectBlockBinding) return { bodyText, headers, injected: [] };
    let body;
    try { body = JSON.parse(bodyText); } catch { return { bodyText, headers, injected: [] }; }
    const betas = betaList(headers["anthropic-beta"]);
    const injected = [];
    if (injectDiagnostics) {
      if (!betas.includes(CACHE_DIAGNOSIS_BETA)) betas.push(CACHE_DIAGNOSIS_BETA);
      body.diagnostics = { previous_message_id: state.lastResponseId ?? null };
      injected.push("diagnostics");
    }
    if (injectBlockBinding && body.thinking && typeof body.thinking === "object") {
      if (!betas.includes(THINKING_BINDING_BETA)) betas.push(THINKING_BINDING_BETA);
      body.thinking = { ...body.thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } };
      injected.push("block_binding");
    }
    const nextHeaders = { ...headers, "anthropic-beta": betas.join(",") };
    return { bodyText: JSON.stringify(body), headers: nextHeaders, injected };
  };

  /**
   * Anthropic SDK 가 부르는 fetch 를 감싼다. `baseFetch` 가 없으면 전역 fetch.
   * Messages API 가 아닌 호출(모델 목록 등)은 그대로 통과시킨다.
   */
  const wrapAntigravityFetch = (inner, input, init, url, { sessionId, model, provider } = {}) => {
    const bodyText = typeof init.body === "string" ? init.body : initBodyText(init);
    if (!/streamGenerateContent/.test(url) || bodyText === undefined) return inner(input, init);

    const seq = ++sequence;
    const state = sessionState(sessionId);
    const sentHeaders = headersToRecord(init.headers);
    const tag = `${String(seq).padStart(4, "0")}-${(sessionId ?? "anon").slice(0, 8)}`;
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { parsed = undefined; }
    const segments = parsed ? antigravitySegments(parsed) : [];
    const changed = firstChangedAnthropicSegment(state.segments, segments);
    const previousSegments = state.segments;
    const params = parsed ? antigravityParamsOf(parsed) : undefined;
    const paramsChanged = state.antigravityParams && params
      ? changedAntigravityParamFields(state.antigravityParams, params)
      : [];
    state.segments = segments;
    state.antigravityParams = params;

    const requestBodyPath = writeRaw(`${tag}.request.json`, bodyText);
    const requestMetaPath = writeRaw(`${tag}.request.meta.json`, JSON.stringify({
      url,
      method: init.method ?? "POST",
      headers: redactHeaders(sentHeaders),
      transport: "sse",
      segments,
      params,
      paramsChanged,
    }, null, 2));
    const sentAt = Date.now();
    record("antigravity.request", {
      seq,
      sessionId,
      provider,
      model: parsed?.model ?? model,
      transport: "sse",
      injected: [],
      bodyBytes: Buffer.byteLength(bodyText),
      bodyDigest: sha(bodyText),
      counts: {
        systemInstruction: segments.filter((segment) => segment.section === "systemInstruction").length,
        tools: segments.filter((segment) => segment.section === "tools").length,
        contents: segments.filter((segment) => segment.section === "contents").length,
      },
      params,
      paramsChanged,
      sharedPrefixSegments: changed ? changed.position : segments.length,
      previousSegments: previousSegments.length,
      ...(changed ? { firstChanged: changed } : { identicalToPrevious: previousSegments.length > 0 }),
      files: { body: requestBodyPath, meta: requestMetaPath },
    });

    return inner(input, init).then((response) => {
      const responseHeaders = headersToRecord(response.headers);
      const base = {
        seq,
        sessionId,
        status: response.status,
        requestId: responseHeaders["request-id"] ?? responseHeaders["x-request-id"],
        latencyMs: Date.now() - sentAt,
        transport: "sse",
      };
      if (!response.body) {
        record("antigravity.response", { ...base, note: "no body" });
        return response;
      }
      const [forward, observe] = response.body.tee();
      (async () => {
        try {
          const text = await new Response(observe).text();
          const responsePath = writeRaw(`${tag}.response.sse`, text);
          const sse = parseAntigravitySse(text);
          const usage = sse.usageMetadata ?? {};
          if (sse.responseId) {
            state.lastResponseId = sse.responseId;
            state.lastResponseModel = sse.model;
          }
          record("antigravity.response", {
            ...base,
            id: sse.responseId,
            model: sse.model,
            usage: {
              promptTokenCount: usage.promptTokenCount ?? null,
              cachedContentTokenCount: usage.cachedContentTokenCount ?? null,
              candidatesTokenCount: usage.candidatesTokenCount ?? null,
              thoughtsTokenCount: usage.thoughtsTokenCount ?? null,
            },
            errors: sse.errors,
            responseHeaders: redactHeaders(responseHeaders),
            files: { sse: responsePath },
          });
        } catch (error) {
          record("antigravity.response", { ...base, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return new Response(forward, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
  };

  const wrapResponsesFetch = (inner, input, init, url, { sessionId, model, provider } = {}) => {
    const family = responsesFamilyFromUrl(url);
    const bodyText = typeof init.body === "string" ? init.body : initBodyText(init);
    if (!family || bodyText === undefined) return inner(input, init);

    const seq = ++sequence;
    const state = sessionState(sessionId);
    const sentHeaders = headersToRecord(init.headers);
    const tag = `${String(seq).padStart(4, "0")}-${(sessionId ?? "anon").slice(0, 8)}`;
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { parsed = undefined; }
    const segments = parsed ? responsesSegments(parsed) : [];
    const changed = firstChangedAnthropicSegment(state.segments, segments);
    const previousSegments = state.segments;
    state.segments = segments;

    const requestBodyPath = writeRaw(`${tag}.request.json`, bodyText);
    const requestMetaPath = writeRaw(`${tag}.request.meta.json`, JSON.stringify({
      url,
      method: init.method ?? "POST",
      headers: redactHeaders(sentHeaders),
      transport: "sse",
      segments,
    }, null, 2));
    const sentAt = Date.now();
    record(`${family}.request`, {
      seq,
      sessionId,
      provider,
      model: parsed?.model ?? model,
      transport: "sse",
      injected: [],
      bodyBytes: Buffer.byteLength(bodyText),
      bodyDigest: sha(bodyText),
      counts: {
        instructions: segments.filter((segment) => segment.section === "instructions").length,
        tools: segments.filter((segment) => segment.section === "tools").length,
        input: segments.filter((segment) => segment.section === "input").length,
      },
      sharedPrefixSegments: changed ? changed.position : segments.length,
      previousSegments: previousSegments.length,
      ...(changed ? { firstChanged: changed } : { identicalToPrevious: previousSegments.length > 0 }),
      previous_response_id: parsed?.previous_response_id ?? null,
      prompt_cache_key: parsed?.prompt_cache_key ?? null,
      store: parsed?.store ?? null,
      files: { body: requestBodyPath, meta: requestMetaPath },
    });

    return inner(input, init).then((response) => {
      const responseHeaders = headersToRecord(response.headers);
      const base = {
        seq,
        sessionId,
        status: response.status,
        requestId: responseHeaders["request-id"] ?? responseHeaders["x-request-id"],
        latencyMs: Date.now() - sentAt,
        transport: "sse",
      };
      if (!response.body) {
        record(`${family}.response`, { ...base, note: "no body" });
        return response;
      }
      const [forward, observe] = response.body.tee();
      (async () => {
        try {
          const text = await new Response(observe).text();
          const responsePath = writeRaw(`${tag}.response.sse`, text);
          const sse = parseResponsesSse(text);
          const completed = sse.completed;
          const created = sse.created;
          const usage = completed?.usage ?? created?.usage ?? {};
          const id = completed?.id ?? created?.id;
          const responseModel = completed?.model ?? created?.model;
          if (id) {
            state.lastResponseId = id;
            state.lastResponseModel = responseModel;
          }
          record(`${family}.response`, {
            ...base,
            id,
            model: responseModel,
            usage: {
              input_tokens: usage.input_tokens ?? null,
              cached_tokens: usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? null,
              output_tokens: usage.output_tokens ?? null,
              ...(usage.input_tokens_details ? { input_tokens_details: usage.input_tokens_details } : {}),
            },
            errors: sse.errors,
            responseHeaders: redactHeaders(responseHeaders),
            files: { sse: responsePath },
          });
        } catch (error) {
          record(`${family}.response`, { ...base, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return new Response(forward, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
  };

  const wrapFetch = (baseFetch, { sessionId, model, provider } = {}) => {
    const inner = baseFetch ?? globalThis.fetch;
    return async (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.href ?? input?.url ?? String(input);
      const bodyText = typeof init.body === "string" ? init.body : undefined;
      if (!/\/v1\/messages(\?|$)/.test(url) || bodyText === undefined) {
        if (/streamGenerateContent/.test(url)) {
          return wrapAntigravityFetch(inner, input, init, url, { sessionId, model, provider });
        }
        return wrapResponsesFetch(inner, input, init, url, { sessionId, model, provider });
      }

      const seq = ++sequence;
      const state = sessionState(sessionId);
      const originalHeaders = headersToRecord(init.headers);
      const { bodyText: sentBody, headers: sentHeaders, injected } = applyInjections(bodyText, originalHeaders, state);
      const tag = `${String(seq).padStart(4, "0")}-${(sessionId ?? "anon").slice(0, 8)}`;

      let parsed;
      try { parsed = JSON.parse(sentBody); } catch { parsed = undefined; }
      const segments = parsed ? anthropicSegments(parsed) : [];
      const changed = firstChangedAnthropicSegment(state.segments, segments);
      const previousSegments = state.segments;
      state.segments = segments;

      const requestBodyPath = writeRaw(`${tag}.request.json`, sentBody);
      const requestMetaPath = writeRaw(`${tag}.request.meta.json`, JSON.stringify({
        url,
        method: init.method ?? "POST",
        headers: redactHeaders(sentHeaders),
        segments,
      }, null, 2));
      const sentAt = Date.now();
      record("anthropic.request", {
        seq,
        sessionId,
        provider,
        model: parsed?.model ?? model,
        betas: betaList(sentHeaders["anthropic-beta"]),
        injected,
        bodyBytes: Buffer.byteLength(sentBody),
        bodyDigest: sha(sentBody),
        counts: {
          system: segments.filter((segment) => segment.section === "system").length,
          tools: segments.filter((segment) => segment.section === "tools").length,
          messages: segments.filter((segment) => segment.section === "messages").length,
        },
        sharedPrefixSegments: changed ? changed.position : segments.length,
        previousSegments: previousSegments.length,
        ...(changed ? { firstChanged: changed } : { identicalToPrevious: previousSegments.length > 0 }),
        cacheControl: {
          ttl: parsed?.system?.at?.(-1)?.cache_control?.ttl ?? parsed?.messages?.at?.(-1)?.content?.at?.(-1)?.cache_control?.ttl ?? null,
          systemBreakpoint: Array.isArray(parsed?.system) ? parsed.system.some((block) => block?.cache_control) : false,
          toolsBreakpoint: Array.isArray(parsed?.tools) ? parsed.tools.some((tool) => tool?.cache_control) : false,
          messagesBreakpoints: Array.isArray(parsed?.messages)
            ? parsed.messages.filter((message) => Array.isArray(message?.content) && message.content.some((block) => block?.cache_control)).length
            : 0,
        },
        thinking: parsed?.thinking ?? null,
        contextManagement: parsed?.context_management ?? null,
        files: { body: requestBodyPath, meta: requestMetaPath },
      });

      const nextInit = { ...init, body: sentBody };
      if (injected.length > 0) nextInit.headers = sentHeaders;
      const response = await inner(input, nextInit);
      const responseHeaders = headersToRecord(response.headers);
      const base = {
        seq,
        sessionId,
        status: response.status,
        requestId: responseHeaders["request-id"] ?? responseHeaders["x-request-id"],
        latencyMs: Date.now() - sentAt,
      };
      if (!response.body) {
        record("anthropic.response", { ...base, note: "no body" });
        return response;
      }
      const [forward, observe] = response.body.tee();
      (async () => {
        try {
          const text = await new Response(observe).text();
          const responsePath = writeRaw(`${tag}.response.sse`, text);
          const sse = parseAnthropicSse(text);
          const start = sse.messageStart;
          const deltaUsage = sse.messageDelta?.usage;
          const usage = { ...(start?.usage ?? {}), ...(deltaUsage ?? {}) };
          if (start?.id) {
            state.lastResponseId = start.id;
            state.lastResponseModel = start.model;
          }
          const { id, model: responseModel, usage: _usage, type: _type, role: _role, stop_reason: _stop, stop_sequence: _seq, ...extra } = start ?? {};
          record("anthropic.response", {
            ...base,
            id,
            model: responseModel,
            stopReason: sse.messageDelta?.delta?.stop_reason ?? start?.stop_reason,
            usage: {
              input_tokens: usage.input_tokens ?? null,
              cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
              cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
              ephemeral_5m_input_tokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
              ephemeral_1h_input_tokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
              output_tokens: usage.output_tokens ?? null,
              ...(usage.iterations ? { iterations: usage.iterations } : {}),
            },
            diagnostics: start?.diagnostics ?? sse.messageDelta?.diagnostics ?? null,
            inputTransformations: start?.input_transformations ?? sse.messageDelta?.input_transformations ?? null,
            contextManagement: start?.context_management ?? sse.messageDelta?.context_management ?? null,
            extra: Object.keys(extra).filter((key) => !["diagnostics", "input_transformations", "context_management"].includes(key)),
            contentBlocks: sse.contentBlocks,
            errors: sse.errors,
            responseHeaders: redactHeaders(responseHeaders),
            files: { sse: responsePath },
          });
        } catch (error) {
          record("anthropic.response", { ...base, error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return new Response(forward, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  };

  return { dir, logPath, record, wrapFetch, sessionState };
}

let shared;
export function cacheAudit(env = process.env) {
  if (!cacheAuditEnabled(env)) return undefined;
  if (!shared || shared.dir !== env.RUBATO_CACHE_AUDIT_DIR) shared = createCacheAudit({ env });
  return shared;
}

/** 이 model 이 Anthropic Messages 직결 경로인지. 다른 provider 의 fetch 는 건드리지 않는다. */
export function isAnthropicMessagesModel(model) {
  return model?.api === "anthropic-messages" && (model?.provider === "anthropic" || /api\.anthropic\.com/.test(model?.baseUrl ?? ""));
}

export function isCodexResponsesModel(model) {
  return model?.api === "openai-codex-responses" && model?.provider === "openai-codex";
}

export function isXaiResponsesModel(model) {
  return model?.api === "openai-responses" && model?.provider === "xai";
}

/** Anthropic Messages + Codex Responses + xAI Responses 직결 경로. */
export function isCacheAuditModel(model) {
  return isAnthropicMessagesModel(model) || isCodexResponsesModel(model) || isXaiResponsesModel(model);
}
