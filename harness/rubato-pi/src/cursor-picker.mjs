// Cursor 피커에 우리가 쓰던 모델만 남긴다.
//
// GetUsableModels 는 계정 usable catalog 권위다. 여기서 모델을 만들지 않는다.
// 피커만 줄인다 — discovery 에 없는 id 는 등장하지 않는다.
//
// 일곱은 OpenCodex 시절 실사용 목록이다
// (`case-studies/provider-routing/cursor-route-verdict`: grok-4.6, gpt-5.6-sol,
// claude-fable-5, claude-opus-5, gemini-3.7-flash, kimi-k3, composer-2.5).
// live id 는 `cursor-grok-4.6` 이다.

import { CURSOR_GROK_46_ID, presentCursorGrokFast } from "./cursor-grok-fast.mjs";
import { keepPickerIds } from "./picker-catalog.mjs";

export const CURSOR_PICKER_IDS = Object.freeze([
  CURSOR_GROK_46_ID,
  "gpt-5.6-sol",
  "claude-fable-5",
  "claude-opus-5",
  "gemini-3.7-flash",
  "kimi-k3",
  "composer-2.5",
]);

export function presentCursorPicker(models) {
  return keepPickerIds(presentCursorGrokFast(models), CURSOR_PICKER_IDS);
}
