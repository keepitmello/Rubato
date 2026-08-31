// [cluster:control-codemode] — interactive-control-surface(#29: slash-commands,
// extensions loader/runner, interactive-mode)를 load transform 으로 옮기는 자리.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들( interactive-mode 는 tui-chrome
// 클러스터 출력 이후의 텍스트), 없으면 throw, 패치 공존 중 inert.
//
// senpi-codemode baseline 은 jiti 가 fs 로 읽는 src/*.ts 라 훅이 못 고친다.
// loader.js 의 jiti 엔트리/alias 를 인레포 patched 복사본으로 돌린다
// (harness/rubato-pi/src/codemode/). #29 니들과 따로 적용해서 pre-flip 에도 산다.

import { injectCodemodeRedirect } from "./control-codemode-redirect.mjs";
import { injectExtensionsLoader, injectExtensionsRunner, isExtensionsLoaderUrl, isExtensionsRunnerUrl } from "./control-extensions.mjs";
import { injectInteractiveControl, isControlInteractiveModeUrl } from "./control-interactive-mode.mjs";
import { injectSlashCommandsRemoteMode, isSlashCommandsUrl } from "./control-slash-commands.mjs";

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyControlCodemodeTransforms(url, source, applyTransform) {
  if (isSlashCommandsUrl(url)) source = applyTransform(source, injectSlashCommandsRemoteMode);
  if (isExtensionsLoaderUrl(url)) {
    source = applyTransform(source, injectExtensionsLoader);
    source = applyTransform(source, injectCodemodeRedirect);
  }
  if (isExtensionsRunnerUrl(url)) source = applyTransform(source, injectExtensionsRunner);
  if (isControlInteractiveModeUrl(url)) source = applyTransform(source, injectInteractiveControl);
  return source;
}

export {
  injectCodemodeRedirect,
  injectExtensionsLoader,
  injectExtensionsRunner,
  injectInteractiveControl,
  injectSlashCommandsRemoteMode,
  isControlInteractiveModeUrl,
  isExtensionsLoaderUrl,
  isExtensionsRunnerUrl,
  isSlashCommandsUrl,
};
