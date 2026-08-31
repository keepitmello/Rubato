// [cluster:tui-chrome] — TUI 크롬 벤더 패치를 load transform 으로 옮기는 자리.
// 이 파일과 여기서 import 하는 transform 모듈들은 tui-chrome 워크스트림이 소유한다.
// 규약: 각 transform 은 pristine 벤더 소스의 **정확한** 니들에 걸고, 니들이 없으면
// throw 한다 (applyTransform 이 drift 경고로 삼킨다). 패치가 아직 node_modules 에
// 발려 있는 동안 니들이 없어 자연히 inert 가 되는 것이 정상이다.

import { injectAssistantDescriptors, isAssistantDescriptorsUrl } from "./assistant-descriptors.mjs";
import { injectAssistantMessage, isAssistantMessageUrl } from "./assistant-message.mjs";
import { injectInteractiveModeChrome, isInteractiveModeUrl } from "./interactive-mode-chrome.mjs";
import { injectToolExecution, isToolExecutionUrl } from "./tool-execution.mjs";
import { injectTranscriptCache, isTranscriptCacheUrl } from "./transcript-cache.mjs";

/**
 * @param {string} url  로드 중인 모듈 URL
 * @param {string} source  이전 단계까지 변환된 소스
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyTuiChromeTransforms(url, source, applyTransform) {
  if (isInteractiveModeUrl(url)) source = applyTransform(source, (text) => injectInteractiveModeChrome(text));
  if (isAssistantMessageUrl(url)) source = applyTransform(source, (text) => injectAssistantMessage(text));
  if (isToolExecutionUrl(url)) source = applyTransform(source, (text) => injectToolExecution(text));
  if (isAssistantDescriptorsUrl(url)) source = applyTransform(source, injectAssistantDescriptors);
  if (isTranscriptCacheUrl(url)) source = applyTransform(source, injectTranscriptCache);
  return source;
}

export {
  injectAssistantDescriptors,
  injectAssistantMessage,
  injectInteractiveModeChrome,
  injectToolExecution,
  injectTranscriptCache,
  isAssistantDescriptorsUrl,
  isAssistantMessageUrl,
  isInteractiveModeUrl,
  isToolExecutionUrl,
  isTranscriptCacheUrl,
};
