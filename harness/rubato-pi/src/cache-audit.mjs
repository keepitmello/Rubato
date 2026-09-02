// Anthropic 최종 요청·응답 계측 (캐시 실사용).
//
// `measurement-recorder.mjs` 는 pi 공통 context(`body.prompt`)로 구간을 가른다 — 그것은
// **중간 표현**이다. Anthropic 프롬프트 캐시는 실제로 전송된 `system`/`tools`/`messages`
// 바이트가 기준이므로, 실사에는 SDK 가 직렬화한 HTTP body 그 자체가 필요하다.
//
// 그래서 여기는 provider 에 `options.fetch` 로 들어가 Anthropic SDK 가 부르는 fetch 를
// 감싼다. 요청 body 문자열을 그대로 저장하고, 구간별 해시로 직전 요청과 첫 변경
// 지점을 찾고, 응답 SSE 를 tee 해 `message_start`/`message_delta` 의 원시 usage 와
// `diagnostics`/`input_transformations` 를 남긴다.
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
  const wrapFetch = (baseFetch, { sessionId, model, provider } = {}) => {
    const inner = baseFetch ?? globalThis.fetch;
    return async (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const bodyText = typeof init.body === "string" ? init.body : undefined;
      if (!/\/v1\/messages(\?|$)/.test(url) || bodyText === undefined) return inner(input, init);

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
