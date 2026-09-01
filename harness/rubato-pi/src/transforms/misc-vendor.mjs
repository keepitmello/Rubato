// [cluster:misc-vendor] — 소형 벤더 패치(auth-storage, model-selector, high-reasoning,
// pi-tui autocomplete, pi-ai lazy/TTL, google input guard)를 load transform 으로 옮기는 자리.
// 이 파일과 여기서 import 하는 transform 모듈들은 misc-vendor 워크스트림이 소유한다.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들, 없으면 throw, 패치 공존 중 inert.

import { injectAuthStorage, isAuthStorageUrl } from "./misc-auth-storage.mjs";
import {
  injectGoogleSharedInputGuard,
  injectTransformMessagesInputGuard,
  isGoogleSharedUrl,
  isTransformMessagesUrl,
} from "./misc-google-input-guard.mjs";
import { injectHighReasoning, isHighReasoningUrl } from "./misc-high-reasoning.mjs";
import { injectModelSelector, isModelSelectorUrl } from "./misc-model-selector.mjs";
import { injectPiAiLazy, isPiAiLazyUrl } from "./misc-pi-ai-lazy.mjs";
import { injectPromptCacheTtl, isPromptCacheTtlUrl } from "./misc-prompt-cache-ttl.mjs";
import {
  injectTuiAutocomplete,
  injectTuiDollar,
  injectTuiEditor,
  injectTuiSlash,
  isTuiAutocompleteUrl,
  isTuiDollarUrl,
  isTuiEditorUrl,
  isTuiSlashUrl,
} from "./misc-tui-autocomplete.mjs";

/**
 * @param {string} url  로드 중인 모듈 URL
 * @param {string} source  이전 단계까지 변환된 소스
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyMiscVendorTransforms(url, source, applyTransform) {
  if (isModelSelectorUrl(url)) source = applyTransform(source, injectModelSelector);
  if (isHighReasoningUrl(url)) source = applyTransform(source, injectHighReasoning);
  if (isAuthStorageUrl(url)) source = applyTransform(source, injectAuthStorage);
  if (isTuiAutocompleteUrl(url)) source = applyTransform(source, injectTuiAutocomplete);
  if (isTuiEditorUrl(url)) source = applyTransform(source, injectTuiEditor);
  if (isTuiDollarUrl(url)) source = applyTransform(source, injectTuiDollar);
  if (isTuiSlashUrl(url)) source = applyTransform(source, injectTuiSlash);
  if (isPiAiLazyUrl(url)) source = applyTransform(source, injectPiAiLazy);
  if (isPromptCacheTtlUrl(url)) source = applyTransform(source, injectPromptCacheTtl);
  if (isTransformMessagesUrl(url)) source = applyTransform(source, injectTransformMessagesInputGuard);
  if (isGoogleSharedUrl(url)) source = applyTransform(source, injectGoogleSharedInputGuard);
  return source;
}

export {
  injectAuthStorage,
  injectGoogleSharedInputGuard,
  injectHighReasoning,
  injectModelSelector,
  injectPiAiLazy,
  injectPromptCacheTtl,
  injectTransformMessagesInputGuard,
  injectTuiAutocomplete,
  injectTuiDollar,
  injectTuiEditor,
  injectTuiSlash,
  isAuthStorageUrl,
  isGoogleSharedUrl,
  isHighReasoningUrl,
  isModelSelectorUrl,
  isPiAiLazyUrl,
  isPromptCacheTtlUrl,
  isTransformMessagesUrl,
  isTuiAutocompleteUrl,
  isTuiDollarUrl,
  isTuiEditorUrl,
  isTuiSlashUrl,
};
