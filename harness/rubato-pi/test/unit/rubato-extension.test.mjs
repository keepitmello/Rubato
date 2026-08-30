import test from "node:test";
import assert from "node:assert/strict";
import { loadRubatoExtension, rubatoExtensionPath } from "../../src/rubato-entry.mjs";

test("Rubato extension entry loads registrar exports", async () => {
  assert.match(rubatoExtensionPath(), /extensions\/rubato\.js$/);
  const mod = await loadRubatoExtension();
  assert.equal(typeof mod.composeRubatoExtension, "function");
  assert.ok(Array.isArray(mod.rubatoComponents));
  assert.deepEqual(
    mod.rubatoComponents.map((c) => c.name).sort(),
    ["ast-grep", "lsp", "memory", "task"].sort(),
  );
  assert.equal(typeof mod.createRubatoComponents, "function");
});
