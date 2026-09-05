// Cursor 피커에 우리가 쓰던 모델만 남긴다.
//
// GetUsableModels 는 계정 usable catalog 권위다. 여기서 모델을 만들지 않는다.
// 피커만 줄인다 — discovery 에 없는 id 는 등장하지 않는다.
//
// 일곱은 OpenCodex 시절 실사용 목록이다
// (`case-studies/provider-routing/cursor-route-verdict`: grok-4.6, gpt-5.6-sol,
// claude-fable-5-1, claude-opus-5, gemini-3.8-flash, kimi-k3, composer-2.5).
// live id 는 `cursor-grok-4.6` 이다.

import { CURSOR_GROK_46_ID, presentCursorGrokFast } from "./cursor-grok-fast.mjs";
import { keepPickerIds } from "./picker-catalog.mjs";

export const CURSOR_PICKER_IDS = Object.freeze([
  CURSOR_GROK_46_ID,
  "gpt-5.6-sol",
  "claude-fable-5-1",
  "claude-opus-5",
  "gemini-3.8-flash",
  "kimi-k3",
  "composer-2.5",
]);

// pinned catalog-grouping 은 gemini-3.8-flash 를 모른다 — alias 테이블과
// capability 에 3.7 까지만 있어서 discovery 변형(`gemini-3.8-flash-medium` 등)이
// 베이스로 묶이지 않고 variant id 그대로 나온다. exact-match 인 keepPickerIds 는
// 그것을 버리므로, Grok Fast 처럼 여기서 베이스 하나로 접는다. upstream 이
// grouping 을 배우면 베이스가 그대로 와서 이 접기는 no-op 이다.
export const CURSOR_GEMINI_38_FLASH_ID = "gemini-3.8-flash";
export const CURSOR_GEMINI_38_FLASH_HIGH_ID = "gemini-3.8-flash-high";
const GEMINI_38_FLASH_VARIANT = /^gemini-3\.8-flash(-.+)?$/;

export function presentCursorGemini38Flash(models) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const kept = [];
  let base;
  let template;
  for (const model of models) {
    const id = model?.id ?? "";
    if (model?.provider === "cursor" && GEMINI_38_FLASH_VARIANT.test(id)) {
      if (id === CURSOR_GEMINI_38_FLASH_ID && !base) base = model;
      template ??= model;
      continue;
    }
    kept.push(model);
  }
  const source = base ?? template;
  if (source) {
    // display id 는 베이스로 두되 wire 는 high 변형으로 고정한다 — 베어 id 는
    // 캐시 0% (selection-descriptor 가 bare capability id 를 suffix 변형으로
    // 풀지 못해 fallback 이 베어를 그대로 wire 에 싣는다). high 는 실측 65%
    // prefix hit 가 나는 실 catalog variant 다. effort 를 바꿔도 high 로 나간다.
    kept.push({
      ...source,
      id: CURSOR_GEMINI_38_FLASH_ID,
      reasoning: typeof source.reasoning === "boolean" ? source.reasoning : true,
      upstreamModelId: CURSOR_GEMINI_38_FLASH_HIGH_ID,
      compat: {
        ...(source.compat ?? {}),
        cursorReasoning: {
          capabilityId: CURSOR_GEMINI_38_FLASH_ID,
          representativeVariantId: CURSOR_GEMINI_38_FLASH_HIGH_ID,
        },
      },
    });
  }
  return kept;
}

export function presentCursorPicker(models) {
  return keepPickerIds(
    presentCursorGrokFast(presentCursorGemini38Flash(models)),
    CURSOR_PICKER_IDS,
  );
}
