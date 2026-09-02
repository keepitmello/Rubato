import { replaceOnce } from "./replace-once.mjs";

export function isBootLoaderUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/extensions/loader.js");
}

/**
 * loader.js 는 확장 샌드박스용으로 senpi 공개 배럴·pi-ai/providers/all·typebox
 * 를 정적 import 한다. Bun 바이너리 번들 때문이고, Node 경로에서는
 * createExtensionModuleImporter() 가 alias 로 실제 패키지를 풀므로
 * 이 네임스페이스는 VIRTUAL_MODULES (Bun/SEA) 에만 쓰인다.
 *
 * 정적 import 를 빼면 부팅 그래프가 index.js → main/TUI/이미지 유틸로
 * 순환 확장되지 않고, 사용자 확장(jiti) 이 실제로 붙기 전까지
 * providers/all 도 안 올린다.
 */
export function injectLoaderDeferHeavyBundles(source) {
  let next = source;
  next = replaceOnce(
    next,
    'import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";\nimport * as _bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";\n',
    "const _bundledPiAiOauth = {};\nconst _bundledPiAiProviders = {};\n",
    "loader defer pi-ai oauth/providers",
  );
  next = replaceOnce(
    next,
    'import * as _bundledTypebox from "typebox";\nimport * as _bundledTypeboxCompile from "typebox/compile";\nimport * as _bundledTypeboxValue from "typebox/value";\n',
    "const _bundledTypebox = {};\nconst _bundledTypeboxCompile = {};\nconst _bundledTypeboxValue = {};\n",
    "loader defer typebox virtual modules",
  );
  next = replaceOnce(
    next,
    'import * as _bundledPiCodingAgent from "../../index.js";\n',
    "const _bundledPiCodingAgent = {};\n",
    "loader defer senpi barrel",
  );
  return next;
}
