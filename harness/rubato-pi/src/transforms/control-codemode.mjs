// [cluster:control-codemode] — interactive-control-surface(#29: slash-commands,
// extensions loader/runner, interactive-mode)와 senpi-codemode eval-notifier 를
// load transform 으로 옮기는 자리. 규약은 tui-chrome.mjs 와 같다: pristine 니들,
// 없으면 throw, 패치 공존 중 inert. interactive-mode 니들은 tui-chrome 클러스터
// 출력 이후의 텍스트에서 살아야 한다 (호출 순서상 이 클러스터가 뒤).

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyControlCodemodeTransforms(url, source, applyTransform) {
  void url;
  void applyTransform;
  return source;
}
