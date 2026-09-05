// Aside → Rubato Cursor OpenAI 호환 면의 순수 변환.
//
// transport 는 aside-cursor-server.mjs 가 소유한다. 여기는 id, 대화 키,
// 메시지, SSE, 사용량만 다룬다. Cursor Connect 를 부르지 않는다.

import { createHash } from "node:crypto";
import { CURSOR_GROK_46_ID } from "./cursor-grok-fast.mjs";
import {
  CURSOR_GEMINI_38_FLASH_HIGH_ID,
  CURSOR_GEMINI_38_FLASH_ID,
  CURSOR_PICKER_IDS,
} from "./cursor-picker.mjs";

export const ASIDE_CURSOR_DEFAULT_PORT = 18788;
export const ASIDE_CURSOR_DEFAULT_HOST = "127.0.0.1";
export const ASIDE_CURSOR_API_KEY = "rubato-cursor";

const ASIDE_PREFIX = /^cursor\//;

/** Aside allowlist id → pinned catalog id. Fast 행도 베이스로 접는다. */
export function asideCursorModelId(raw) {
  if (typeof raw !== "string" || raw.length === 0) return CURSOR_GROK_46_ID;
  let id = raw.trim();
  if (ASIDE_PREFIX.test(id)) id = id.slice("cursor/".length);
  if (id === `${CURSOR_GROK_46_ID}-fast` || id === "grok-4.6-fast") return CURSOR_GROK_46_ID;
  if (id === "grok-4.6") return CURSOR_GROK_46_ID;
  if (id === "claude-fable-5") return "claude-fable-5-1";
  return id;
}

export function asideCursorCatalog() {
  return [
    { id: "cursor/grok-4.6", name: "Grok 4.6 Fast [Cursor]" },
    { id: "cursor/grok-4.6-fast", name: "Grok 4.6 Fast [Cursor]" },
    { id: "cursor/claude-fable-5-1", name: "Fable 5.1 [Cursor/Claude]" },
    { id: "cursor/claude-opus-5", name: "Opus 5 [Cursor/Claude]" },
    { id: "cursor/gemini-3.8-flash", name: "3.8 Flash [Cursor/Gemini]" },
    { id: "cursor/kimi-k3", name: "K3 [Cursor/Kimi]" },
    { id: "cursor/composer-2.5", name: "Composer 2.5 [Cursor]" },
    { id: "cursor/gpt-5.6-sol", name: "5.6 Sol [Cursor/GPT]" },
  ];
}

/** 헤더가 있으면 그걸 쓴다. 없으면 첫 시스템+유저 텍스트로 대화를 묶는다. */
export function conversationKey({ headers = {}, body = {} } = {}) {
  const named = headerValue(headers, "x-aside-session-id")
    || headerValue(headers, "x-session-id")
    || (typeof body.user === "string" && body.user.trim() ? body.user.trim() : "");
  if (named) return named;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const seed = `${systemText(messages)}\n${firstUserText(messages)}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

export function openaiToPiContext(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompt = systemTexts(messages).join("\n");
  const converted = [];
  for (const message of messages) {
    if (!message || message.role === "system") continue;
    if (message.role === "tool") {
      converted.push({
        role: "user",
        content: formatToolResult(message),
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      continue;
    }
    const content = messageContent(message.content);
    if (content === undefined) continue;
    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content,
    });
  }
  if (converted.length === 0) {
    converted.push({ role: "user", content: firstUserText(messages) || "ping" });
  }
  const tools = openaiToolsToPi(body.tools);
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: converted,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

export function cursorModelStub(id) {
  const catalogId = asideCursorModelId(id);
  const known = CURSOR_PICKER_IDS.includes(catalogId) || catalogId === CURSOR_GROK_46_ID;
  return {
    id: known ? catalogId : CURSOR_GROK_46_ID,
    name: catalogId === CURSOR_GROK_46_ID ? "Grok 4.6 Fast" : catalogId,
    api: "cursor-agent",
    provider: "cursor",
    baseUrl: "https://api2.cursor.sh",
    reasoning: true,
    input: ["text", "image"],
  };
}

// pinned catalog-grouping이 모르는 신규모델 베이스(gemini-3.8, fable-5-1)는
// provider 목록에 베이스가 없다. stub의 베어 id를 wire에 싣히면 선택기가
// 별명표를 몰라 베어로 되돌리고, Cursor는 답 뒤에 턴을 깨뜨린다(2026-09-05
// 실측: type error / reason error). 목록에 있는 실 variant 항목을 그대로
// 쓴다. gemini는 high(캐시 실측), fable은 medium(opus·sol 선례).
const CURSOR_WIRE_VARIANT = {
  [CURSOR_GEMINI_38_FLASH_ID]: CURSOR_GEMINI_38_FLASH_HIGH_ID,
  "claude-fable-5-1": "claude-fable-5-1-medium",
};

function normalizeCursorEntry(found) {
  return {
    ...found,
    id: found.id,
    provider: found.provider ?? "cursor",
    api: found.api ?? "cursor-agent",
    baseUrl: found.baseUrl ?? "https://api2.cursor.sh",
  };
}

function findCursorEntry(models, target) {
  return models.find((model) => model.id === target)
    ?? models.find((model) => model?.provider === "cursor" && model.id === target);
}

export function resolveCursorModel(id, catalog) {
  const want = asideCursorModelId(id);
  const models = Array.isArray(catalog) ? catalog : [];
  const found = findCursorEntry(models, want);
  if (found) return normalizeCursorEntry(found);
  const variant = CURSOR_WIRE_VARIANT[want];
  const live = variant ? findCursorEntry(models, variant) : undefined;
  if (live) return normalizeCursorEntry(live);
  return cursorModelStub(id);
}

export function cacheHitRate(usage) {
  const cacheRead = Number(usage?.cacheRead ?? 0);
  const input = Number(usage?.input ?? 0);
  const uncached = input > cacheRead ? input - cacheRead : input;
  const denom = uncached + cacheRead;
  if (!(denom > 0)) return null;
  return cacheRead / denom;
}

export function usageFromStreamEvent(event) {
  const usage = event?.usage ?? event?.message?.usage ?? event?.partial?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cacheRead: Number(usage.cacheRead ?? 0),
    cacheWrite: Number(usage.cacheWrite ?? 0),
  };
}

export function openaiSseChunk(id, delta, finishReason = null, usage) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage: toOpenAiUsage(usage) } : {}),
  })}\n\n`;
}

export function openaiSseDone() {
  return "data: [DONE]\n\n";
}

export function openaiJsonCompletion(id, text, usage) {
  return {
    id,
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    ...(usage ? { usage: toOpenAiUsage(usage) } : {}),
  };
}

export function toOpenAiUsage(usage) {
  const prompt = Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: Number(usage.output ?? 0),
    total_tokens: prompt + Number(usage.output ?? 0),
    prompt_tokens_details: {
      cached_tokens: Number(usage.cacheRead ?? 0),
    },
  };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want && value != null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function systemTexts(messages) {
  return messages
    .filter((message) => message?.role === "system")
    .map((message) => messageContent(message.content))
    .filter((text) => typeof text === "string" && text.length > 0);
}

function systemText(messages) {
  return systemTexts(messages).join("\n");
}

function firstUserText(messages) {
  for (const message of messages) {
    if (message?.role === "user") {
      const text = messageContent(message.content);
      if (text) return text;
    }
  }
  return "";
}

function messageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function formatToolResult(message) {
  const name = message.name ? ` (${message.name})` : "";
  return `Tool result${name}:\n${messageContent(message.content) ?? ""}`;
}

function openaiToolsToPi(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const fn = tool?.function ?? tool;
    if (!fn?.name) return [];
    return [{
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    }];
  });
}
