import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { senpiNested } from "../../src/engine-paths.mjs";
import {
  BUILTIN_PROVIDER_IDS,
  SUPPORTED_PROVIDER_IDS,
  builtinProviderIds,
  foreignProviderIds,
} from "../../src/provider-ids.mjs";

test("supported ids stay out of the foreign disable list", () => {
  const foreign = foreignProviderIds(builtinProviderIds());
  for (const id of SUPPORTED_PROVIDER_IDS) {
    assert.equal(foreign.includes(id), false, id);
  }
  assert.ok(foreign.includes("vercel-ai-gateway"));
  assert.ok(foreign.includes("alibaba-token-plan"));
});

test("frozen builtin ids match the installed pi-ai catalog union", async () => {
  const catalog = await import(
    pathToFileURL(senpiNested("@earendil-works/pi-ai/dist/providers/all.js")).href
  );
  const live = [
    ...new Set([
      ...catalog.getBuiltinProviders(),
      ...catalog.builtinProviders().map((provider) => provider.id),
    ]),
  ].sort();
  assert.deepEqual([...BUILTIN_PROVIDER_IDS].sort(), live);
});
