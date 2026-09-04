// [cluster:boot-perf] — 엔진 부팅 그래프에서 첫 페인트에 안 쓰는
// 정적 import 를 끊는 자리. 규약은 tui-chrome.mjs 와 같다.

import { injectAgentSessionDeferExportHtml, isBootAgentSessionUrl } from "./boot-agent-session-export.mjs";
import {
  injectAuthStorageCatalogSlim,
  injectModelRuntimeCatalogSlim,
  isBootAuthStorageUrl,
  isBootModelRuntimeUrl,
} from "./boot-catalog-slim.mjs";
import { injectInteractiveDeferDialogs, isBootInteractiveModeUrl } from "./boot-interactive-defer.mjs";
import { injectLoaderDeferHeavyBundles, isBootLoaderUrl } from "./boot-loader-defer.mjs";
import { injectMainDeferCliModules, isBootMainUrl } from "./boot-main-defer.mjs";

/**
 * @param {string} url
 * @param {string} source
 * @param {(source: string, transform: (text: string) => string) => string} applyTransform
 * @returns {string}
 */
export function applyBootPerfTransforms(url, source, applyTransform) {
  if (isBootLoaderUrl(url)) source = applyTransform(source, injectLoaderDeferHeavyBundles);
  if (isBootAgentSessionUrl(url)) source = applyTransform(source, injectAgentSessionDeferExportHtml);
  if (isBootMainUrl(url)) source = applyTransform(source, injectMainDeferCliModules);
  if (isBootInteractiveModeUrl(url)) source = applyTransform(source, injectInteractiveDeferDialogs);
  if (isBootModelRuntimeUrl(url)) source = applyTransform(source, injectModelRuntimeCatalogSlim);
  if (isBootAuthStorageUrl(url)) source = applyTransform(source, injectAuthStorageCatalogSlim);
  return source;
}

export {
  injectAgentSessionDeferExportHtml,
  injectAuthStorageCatalogSlim,
  injectInteractiveDeferDialogs,
  injectLoaderDeferHeavyBundles,
  injectMainDeferCliModules,
  injectModelRuntimeCatalogSlim,
  isBootAgentSessionUrl,
  isBootAuthStorageUrl,
  isBootInteractiveModeUrl,
  isBootLoaderUrl,
  isBootMainUrl,
  isBootModelRuntimeUrl,
};
