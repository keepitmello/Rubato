import assert from "node:assert/strict";
import test from "node:test";
import { scanBuiltinSources } from "../scripts/scan-senpi-builtins.mjs";

const sources = {
  index: 'import one from "./one.js";\nimport two from "./two.js";\nexport const globalDefaultExtensionIds = ["diff"];\nexport const builtinExtensions = [{ id: "one", factory: one }, { id: "two", factory: two }];',
  loader: 'const bundledBuiltinExtensions = [{ id: "codemode", package: "@code-yeongyu/senpi-codemode" }];',
  defaults: 'export const DISABLED_OAUTH_EXTENSIONS = ["two"];\nexport const DISABLED_WEB_SEARCH_EXTENSIONS = [];',
};

test("inventory includes normal, disabled, bundled, and generated extension entry points", () => {
  const result = scanBuiltinSources(sources);
  assert.deepEqual(result.entries.map((row) => row.id), ["one", "two", "codemode", "diff"]);
  assert.equal(result.entries[1].defaultPolicy, "disabled-by-rubato");
  assert.equal(result.entries.every((row) => row.status === "pending-contract-and-parity"), true);
  assert.equal(result.sources.indexSha256.length, 64);
});

test("unknown registrations fail instead of becoming silently absent capabilities", () => {
  assert.throws(() => scanBuiltinSources({ ...sources, index: sources.index.replace('factory: one', 'factory: () => one') }), /silently omit/);
  assert.throws(() => scanBuiltinSources({ ...sources, loader: sources.loader.replace('"codemode"', '"new-builtin"') }), /registration changed/);
  assert.throws(() => scanBuiltinSources({ ...sources, defaults: sources.defaults.replace('"two"', '"missing"') }), /unknown builtin/);
});
