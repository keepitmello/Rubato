// [cluster:cursor-vendor] — senpi cursor-exec journal 3부작과 pi-ai
// cursor-terminal-failure-kind / cursor-native-checkpoint 를 load transform 으로
// 옮기는 자리. 규약은 tui-chrome.mjs 와 같다: pristine 니들, 없으면 throw,
// 패치 공존 중 inert. 패치가 새로 만드는 벤더 파일은 in-repo 모듈 + href 주입.

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyCursorVendorTransforms(url, source, applyTransform) {
  void url;
  void applyTransform;
  return source;
}
