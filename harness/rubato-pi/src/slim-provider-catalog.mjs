import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { senpiNested } from "./engine-paths.mjs";

// senpi model-runtime / auth-storage 가 부팅 때 올리는 카탈로그를
// Rubato 가 실제로 등록하는 lane + radius(설정 oauth) 로 줄인다.
// 전체 providers/all 은 kimi/groq 같은 미지원 구현까지 정적 import 한다.
function providerHref(name) {
  return pathToFileURL(senpiNested(`@earendil-works/pi-ai/dist/providers/${name}.js`)).href;
}

const [
  { anthropicProvider },
  { openaiCodexProvider },
  { xaiProvider },
  { cursorProvider },
  { radiusProvider },
] = await Promise.all([
  import(providerHref("anthropic")),
  import(providerHref("openai-codex")),
  import(providerHref("xai")),
  import(providerHref("cursor")),
  import(providerHref("radius")),
]);

export { radiusProvider };

export function builtinProviders() {
  return [
    anthropicProvider(),
    openaiCodexProvider(),
    xaiProvider(),
    cursorProvider(),
    radiusProvider(),
  ];
}

export function getBuiltinProviders() {
  return builtinProviders().map((provider) => provider.id);
}

export function getBuiltinModelDataGeneratedAt() {
  const manifestPath = senpiNested("@earendil-works/pi-ai/dist/providers/data/.manifest.json");
  try {
    const generatedAt = Date.parse(JSON.parse(readFileSync(manifestPath, "utf8")).generatedAt);
    return Number.isNaN(generatedAt) ? undefined : generatedAt;
  } catch {
    return undefined;
  }
}
