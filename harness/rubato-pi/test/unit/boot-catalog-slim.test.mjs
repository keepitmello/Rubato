import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { senpiDir } from "../../src/engine-paths.mjs";
import { applyBootPerfTransforms } from "../../src/transforms/boot-perf.mjs";
import {
  injectAuthStorageCatalogSlim,
  injectModelRuntimeCatalogSlim,
  slimCatalogHref,
} from "../../src/transforms/boot-catalog-slim.mjs";

const modelRuntimePath = join(senpiDir, "dist", "core", "model-runtime.js");
const authStoragePath = join(senpiDir, "dist", "core", "auth-storage.js");

function applyNoThrow(url, source) {
  const warnings = [];
  const next = applyBootPerfTransforms(url, source, (text, transform) => {
    try {
      const out = transform(text);
      return typeof out === "string" ? out : text;
    } catch (error) {
      warnings.push(error.message);
      return text;
    }
  });
  return { next, warnings };
}

test("model-runtime and auth-storage needles retarget the slim catalog", () => {
  const href = slimCatalogHref();
  const runtime = injectModelRuntimeCatalogSlim(readFileSync(modelRuntimePath, "utf8"));
  const auth = injectAuthStorageCatalogSlim(readFileSync(authStoragePath, "utf8"));
  assert.ok(runtime.includes(href));
  assert.ok(auth.includes(href));
  assert.equal(runtime.includes("@earendil-works/pi-ai/providers/all"), false);
  assert.equal(auth.includes("@earendil-works/pi-ai/providers/all"), false);
});

test("the boot-perf cluster slims catalog imports without drift", () => {
  for (const rel of ["dist/core/model-runtime.js", "dist/core/auth-storage.js"]) {
    const filePath = join(senpiDir, rel);
    const { next, warnings } = applyNoThrow(pathToFileURL(filePath).href, readFileSync(filePath, "utf8"));
    assert.equal(warnings.length, 0, `${rel} drift: ${warnings.join("; ")}`);
    assert.ok(next.includes("slim-provider-catalog.mjs"));
  }
});
