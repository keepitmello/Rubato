// [cluster:control-codemode] — interactive-control-surface(#29: slash-commands,
// extensions loader/runner, interactive-mode)를 load transform 으로 옮기는 자리.
// 규약은 tui-chrome.mjs 와 같다: pristine 니들( interactive-mode 는 tui-chrome
// 클러스터 출력 이후의 텍스트), 없으면 throw, 패치 공존 중 inert.
//
// senpi-codemode baseline (`src/index.ts`, `src/extension/eval-notifier.ts`) 은
// 이 로더가 보지 않는다 — jiti 가 fs.readFileSync 로 TS 를 읽고, Node ESM 은
// node_modules 아래 .ts 에 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
// 로더를 재설계하지 않고 그 항목은 멈춘다.

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
  if (isExtensionsLoaderUrl(url)) source = applyTransform(source, injectExtensionsLoader);
  if (isExtensionsRunnerUrl(url)) source = applyTransform(source, injectExtensionsRunner);
  if (isControlInteractiveModeUrl(url)) source = applyTransform(source, injectInteractiveControl);
  return source;
}

export {
  injectExtensionsLoader,
  injectExtensionsRunner,
  injectInteractiveControl,
  injectSlashCommandsRemoteMode,
  isControlInteractiveModeUrl,
  isExtensionsLoaderUrl,
  isExtensionsRunnerUrl,
  isSlashCommandsUrl,
};
