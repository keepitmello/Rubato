import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CURSOR_GROK_FAST_NAME,
  CURSOR_GROK_ID,
} from "../../src/cursor-grok-fast.mjs";
import {
  CURSOR_GEMINI_38_FLASH_HIGH_ID,
  CURSOR_GEMINI_38_FLASH_ID,
  CURSOR_PICKER_IDS,
  presentCursorPicker,
} from "../../src/cursor-picker.mjs";

// 피커 목록의 현재 세대 id 는 `cursor-picker.mjs` 가 소유한다 — 여기서 손으로 적으면
// 세대가 바뀔 때마다 깨진다. fable 행은 export 된 상수가 없어 목록에서 찾는다.
const CURSOR_FABLE_ID = CURSOR_PICKER_IDS.find((id) => id.startsWith("claude-fable"));

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

test("discovery 의 fable 변형이 베이스 하나로 묶여 피커에 남는다", () => {
  // GetUsableModels 캡처의 실제 id 들. 표에 항목이 없던 동안에는
  // 베이스로 묶이지 않아 `claude-fable-5-2` 행이 조용히 비어 있었다.
  const presented = presentCursorPicker(discovered([
    `${CURSOR_FABLE_ID}-high`,
    `${CURSOR_FABLE_ID}-low`,
    `${CURSOR_FABLE_ID}-medium`,
    `${CURSOR_FABLE_ID}-xhigh`,
    `${CURSOR_FABLE_ID}-max`,
    `${CURSOR_FABLE_ID}-thinking-high`,
    "composer-2.5",
  ]));
  const fable = presented.find((model) => model.id === CURSOR_FABLE_ID);
  assert.ok(fable, "fable 행이 피커에 없다");
  assert.equal(fable.contextWindow, 1_000_000);
  assert.equal(fable.upstreamModelId, `${CURSOR_FABLE_ID}-medium`);
  assert.equal(fable.thinkingLevelMap.xhigh, "xhigh");
});

test("discovery 의 grok 변형도 베이스 하나로 묶여 피커에 남는다", () => {
  const presented = presentCursorPicker(discovered([
    `${CURSOR_GROK_ID}-high`,
    `${CURSOR_GROK_ID}-low`,
    `${CURSOR_GROK_ID}-medium`,
    `${CURSOR_GROK_ID}-xhigh`,
    `${CURSOR_GROK_ID}-high-fast`,
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
    cursor(CURSOR_GEMINI_38_FLASH_ID),
    cursor("kimi-k3"),
    cursor(CURSOR_FABLE_ID),
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

test("gemini 변형은 베이스 하나로 접힌 뒤 남는다", () => {
  // pinned grouping 이 이 세대를 묶지 못해 discovery 는 variant id 로 온다.
  const presented = presentCursorPicker([
    cursor(`${CURSOR_GEMINI_38_FLASH_ID}-medium`),
    cursor(`${CURSOR_GEMINI_38_FLASH_ID}-high`),
    cursor(`${CURSOR_GEMINI_38_FLASH_ID}-low`),
    cursor("composer-2.5"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), [CURSOR_GEMINI_38_FLASH_ID, "composer-2.5"]);
  // display 는 베이스, wire 는 high 고정 — 베어 id 는 캐시 0%라서.
  assert.equal(presented[0].upstreamModelId, CURSOR_GEMINI_38_FLASH_HIGH_ID);
  assert.equal(presented[0].compat?.cursorReasoning?.representativeVariantId, CURSOR_GEMINI_38_FLASH_HIGH_ID);
  assert.equal(presented[0].contextWindow, 1_048_576);
  assert.equal(presented[0].maxTokens, 65_536);
});

test("gemini 베이스가 오면 그대로 남는다", () => {
  const presented = presentCursorPicker([
    cursor(CURSOR_GEMINI_38_FLASH_ID),
    cursor("kimi-k3"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), [CURSOR_GEMINI_38_FLASH_ID, "kimi-k3"]);
  assert.equal(presented[0].upstreamModelId, CURSOR_GEMINI_38_FLASH_HIGH_ID);
});

test("grouped 3.7 저장분만 있으면 3.8을 만들지 않는다", () => {
  const presented = presentCursorPicker([
    cursor("gemini-3.7-flash"),
    cursor("composer-2.5"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), ["composer-2.5"]);
});

test("grouped 3.7 위에 현재 변형이 있으면 현재 세대로 접힌다", () => {
  const presented = presentCursorPicker([
    cursor("gemini-3.7-flash"),
    cursor(`${CURSOR_GEMINI_38_FLASH_ID}-high`),
    cursor(`${CURSOR_GEMINI_38_FLASH_ID}-medium`),
    cursor("composer-2.5"),
  ]);
  assert.deepEqual(presented.map((model) => model.id), [CURSOR_GEMINI_38_FLASH_ID, "composer-2.5"]);
});

test("Grok Fast 변형은 베이스 하나로 접힌 뒤 남는다", () => {
  const presented = presentCursorPicker([
    cursor("composer-2.5"),
    cursor(`${CURSOR_GROK_ID}-high-fast`),
    cursor(`${CURSOR_GROK_ID}-low-fast`),
  ]);
  assert.equal(presented.length, 2);
  assert.equal(presented[0].id, CURSOR_GROK_ID);
  assert.equal(presented[0].name, CURSOR_GROK_FAST_NAME);
  assert.equal(presented[1].id, "composer-2.5");
});
