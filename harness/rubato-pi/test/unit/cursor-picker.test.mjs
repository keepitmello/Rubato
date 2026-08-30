import assert from "node:assert/strict";
import test from "node:test";
import {
  CURSOR_GROK_46_FAST_NAME,
  CURSOR_GROK_46_ID,
} from "../../src/cursor-grok-fast.mjs";
import { CURSOR_PICKER_IDS, presentCursorPicker } from "../../src/cursor-picker.mjs";

function cursor(id, extra = {}) {
  return { id, name: id, provider: "cursor", ...extra };
}

test("피커에는 쓰던 일곱만, 목록 순서로 남는다", () => {
  const presented = presentCursorPicker([
    cursor("claude-opus-4-7"),
    cursor("composer-2.5"),
    cursor("gpt-5.6-sol-high-fast"),
    cursor("gpt-5.6-sol"),
    cursor("claude-opus-5-thinking"),
    cursor("claude-opus-5"),
    cursor("gemini-3.7-flash"),
    cursor("kimi-k3"),
    cursor("claude-fable-5"),
    cursor(CURSOR_GROK_46_ID),
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

test("Grok Fast 변형은 베이스 하나로 접힌 뒤 남는다", () => {
  const presented = presentCursorPicker([
    cursor("composer-2.5"),
    cursor("cursor-grok-4.6-high-fast"),
    cursor("cursor-grok-4.6-low-fast"),
  ]);
  assert.equal(presented.length, 2);
  assert.equal(presented[0].id, CURSOR_GROK_46_ID);
  assert.equal(presented[0].name, CURSOR_GROK_46_FAST_NAME);
  assert.equal(presented[1].id, "composer-2.5");
});
