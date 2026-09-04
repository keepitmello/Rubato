import { replaceOnce } from "./replace-once.mjs";

export function isBootModelRuntimeUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/model-runtime.js");
}

export function isBootAuthStorageUrl(url) {
  return url.includes("@code-yeongyu/senpi/dist/core/auth-storage.js");
}

export function slimCatalogHref() {
  return new URL("../slim-provider-catalog.mjs", import.meta.url).href;
}

export function injectModelRuntimeCatalogSlim(source, href = slimCatalogHref()) {
  return replaceOnce(
    source,
    'import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";\n',
    `import * as builtinProviderCatalog from ${JSON.stringify(href)};\n`,
    "model-runtime slim provider catalog",
  );
}

export function injectAuthStorageCatalogSlim(source, href = slimCatalogHref()) {
  return replaceOnce(
    source,
    'import { builtinProviders } from "@earendil-works/pi-ai/providers/all";\n',
    `import { builtinProviders } from ${JSON.stringify(href)};\n`,
    "auth-storage slim provider catalog",
  );
}
