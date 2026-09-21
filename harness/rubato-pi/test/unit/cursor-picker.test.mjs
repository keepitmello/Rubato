import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CURSOR_GROK_FAST_NAME,
  CURSOR_GROK_ID,
} from "../../src/cursor-grok-fast.mjs";
import { CURSOR_PICKER_IDS, presentCursorPicker } from "../../src/cursor-picker.mjs";

// discovery 는 베이스 id 를 주지 않는다 — alias 표가 묶어야 피커에 행이 생긴다.
// 런타임에 실리는 표(vendored)를 읽는다. 워크스페이스 stock 사본은 다른 세대다.
const { normalizeCursorCatalog } = await import(fileURLToPath(new URL(
  "../../../pi-runtime/features/providers/vendor/pi-ai/cursor/catalog-grouping.js",
  import.meta.url,
)));

function cursor(id, extra = {}) {
  return { id, name: id, provider: "cursor", ...extra };
}

/** raw discovery 행 → provider 가 내보내는 모양. grouping 이 끝난 뒤의 변환만 흉내낸다. */
function discovered(rawIds) {
  return normalizeCursorCatalog(rawIds.map((id) => ({ id, name: id, input: ["text"], cursorMaxMode: false })))
    .map((entry) => cursor(entry.id, {
      name: entry.name,
      contextWindow: entry.window,
      ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
      ...(entry.representativeVariantId ? { upstreamModelId: entry.representativeVariantId } : {}),
      ...(entry.capabilityId ? { compat: { cursorReasoning: { capabilityId: entry.capabilityId, representativeVariantId: entry.representativeVariantId } } } : {}),
    }));
}

test("discovery 의 fable-5-1 변형이 베이스 하나로 묶여 피커에 남는다", () => {
  // 2026-09-22 GetUsableModels 캡처의 실제 id 들. 표에 항목이 없던 동안에는
  // 베이스로 묶이지 않아 `claude-fable-5-1` 행이 조용히 비어 있었다.
  const presented = presentCursorPicker(discovered([
    "claude-fable-5-1-high",
    "claude-fable-5-1-low",
    "claude-fable-5-1-medium",
    "claude-fable-5-1-xhigh",
    "claude-fable-5-1-max",
    "claude-fable-5-1-thinking-high",
    "composer-2.5",
  ]));
  const fable = presented.find((model) => model.id === "claude-fable-5-1");
  assert.ok(fable, "fable-5-1 행이 피커에 없다");
  assert.equal(fable.contextWindow, 1_000_000);
  assert.equal(fable.upstreamModelId, "claude-fable-5-1-medium");
  assert.equal(fable.thinkingLevelMap.xhigh, "xhigh");
});

test("discovery 의 grok 변형도 베이스 하나로 묶여 피커에 남는다", () => {
  const presented = presentCursorPicker(discovered([
    "grok-4.7-high",
    "grok-4.7-low",
    "grok-4.7-medium",
    "grok-4.7-xhigh",
    "grok-4.7-high-fast",
    "composer-2.5",
  ]));
  const grok = presented.filter((model) => String(model.id).includes("grok"));
  assert.equal(grok.length, 1);
  assert.equal(grok[0].id, CURSOR_GROK_ID);
  assert.equal(grok[0].name, CURSOR_GROK_FAST_NAME);
});

test("피커에는 쓰던 일곱만, 목록 순서로 남는다", () => {
  const presented = presentCursorPicker([
    cursor("claude-opus-4-7"),
    cursor("composer-2.5"),
    cursor("gpt-5.6-sol-high-fast"),
    cursor("gpt-5.6-sol"),
    cursor("claude-opus-5-thinking"),
    cursor("claude-opus-5"),
    cursor("gemini-3.8-flash"),
    cursor("kimi-k3"),
    cursor("claude-fable-5-1"),
    cursor(CURSOR_GROK_ID),
    cursor("default"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), [...CURSOR_PICKER_IDS]);
});

test("discovery 에 없는 id 는 만들지 않는다", () => {
  const presented = presentCursorPicker([
    cursor("composer-2.5"),
    cursor("gpt-5.6-sol"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), ["gpt-5.6-sol", "composer-2.5"]);
});

test("gemini-3.8-flash 변형은 베이스 하나로 접힌 뒤 남는다", () => {
  // pinned grouping 이 3.8 을 묶지 못해 discovery 는 variant id 로 온다.
  const presented = presentCursorPicker([
    cursor("gemini-3.8-flash-medium"),
    cursor("gemini-3.8-flash-high"),
    cursor("gemini-3.8-flash-low"),
    cursor("composer-2.5"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), ["gemini-3.8-flash", "composer-2.5"]);
  // display 는 베이스, wire 는 high 고정 — 베어 id 는 캐시 0%라서.
  assert.equal(presented[0].upstreamModelId, "gemini-3.8-flash-high");
  assert.equal(presented[0].compat?.cursorReasoning?.representativeVariantId, "gemini-3.8-flash-high");
  assert.equal(presented[0].contextWindow, 1_048_576);
  assert.equal(presented[0].maxTokens, 65_536);
});

test("gemini-3.8-flash 베이스가 오면 그대로 남는다", () => {
  const presented = presentCursorPicker([
    cursor("gemini-3.8-flash"),
    cursor("kimi-k3"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), ["gemini-3.8-flash", "kimi-k3"]);
  assert.equal(presented[0].upstreamModelId, "gemini-3.8-flash-high");
});

test("grouped 3.7 저장분만 있으면 3.8을 만들지 않는다", () => {
  const presented = presentCursorPicker([
    cursor("gemini-3.7-flash"),
    cursor("composer-2.5"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), ["composer-2.5"]);
});

test("grouped 3.7 위에 3.8 변형이 있으면 3.8로 접힌다", () => {
  const presented = presentCursorPicker([
    cursor("gemini-3.7-flash"),
    cursor("gemini-3.8-flash-high"),
    cursor("gemini-3.8-flash-medium"),
    cursor("composer-2.5"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), ["gemini-3.8-flash", "composer-2.5"]);
});

test("Grok Fast 변형은 베이스 하나로 접힌 뒤 남는다", () => {
  const presented = presentCursorPicker([
    cursor("composer-2.5"),
    cursor("grok-4.7-high-fast"),
    cursor("grok-4.7-low-fast"),
  ]);
  assert.equal(presented.length, 2);
  assert.equal(presented[0].id, CURSOR_GROK_ID);
  assert.equal(presented[0].name, CURSOR_GROK_FAST_NAME);
  assert.equal(presented[1].id, "composer-2.5");
});
