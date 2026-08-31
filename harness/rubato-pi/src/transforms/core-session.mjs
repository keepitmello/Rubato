// [cluster:core-session] — compaction 시리즈, stream-watchdog, agent-session
// (/skill: inline, compact-after-user-abort), speculative, service-tier,
// pi-ai codex-overflow 를 load transform 으로 옮기는 자리.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들, 없으면 throw, 패치 공존 중 inert.

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyCoreSessionTransforms(url, source, applyTransform) {
  void url;
  void applyTransform;
  return source;
}
