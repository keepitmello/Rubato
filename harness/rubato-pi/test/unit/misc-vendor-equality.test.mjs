import assert from "node:assert/strict";
import test from "node:test";
import {
  injectAuthStorage,
  injectHighReasoning,
  injectModelSelector,
  injectPiAiLazy,
  injectPromptCacheTtl,
  injectTuiAutocomplete,
  injectTuiDollar,
  injectTuiEditor,
  injectTuiSlash,
  isModelSelectorUrl,
} from "../../src/transforms/misc-vendor.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";

function states(alias, relativePath) {
  const pair = vendorFileStates(alias, relativePath);
  assert.ok(pair, `vendorFileStates(${alias}, ${relativePath}) must locate the series`);
  assert.notEqual(pair.pristine, pair.patched, `${relativePath} fixture must differ`);
  return pair;
}

test("model-selector.js #4+#7+#26: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/modes/interactive/components/model-selector.js");
  assert.equal(injectModelSelector(pristine), patched);
});

test("model-selector.d.ts #5 is skipped: types never load at runtime", () => {
  // Series #5 only edits model-selector.d.ts. The ESM loader never fetches .d.ts,
  // so there is no runtime needle and no transform.
  assert.equal(
    isModelSelectorUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/components/model-selector.d.ts"),
    false,
  );
});

test("high-reasoning-warning.js #6: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/high-reasoning-warning.js");
  assert.equal(injectHighReasoning(pristine), patched);
});

test("auth-storage.js #12+#13: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi", "dist/core/auth-storage.js");
  assert.equal(injectAuthStorage(pristine), patched);
});

test("autocomplete.js tui baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi-tui", "dist/autocomplete.js");
  assert.equal(injectTuiAutocomplete(pristine), patched);
});

test("editor.js tui baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi-tui", "dist/components/editor.js");
  assert.equal(injectTuiEditor(pristine), patched);
});

test("dollar-invocation-autocomplete.js tui baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi-tui", "dist/dollar-invocation-autocomplete.js");
  assert.equal(injectTuiDollar(pristine), patched);
});

test("slash-command-autocomplete.js tui baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("senpi-tui", "dist/slash-command-autocomplete.js");
  assert.equal(injectTuiSlash(pristine), patched);
});

test("lazy.js pi-ai baseline: transform(pristine) === patched", () => {
  const { pristine, patched } = states("pi-ai", "dist/api/lazy.js");
  assert.equal(injectPiAiLazy(pristine), patched);
});

test("prompt-cache-ttl.js gpt56 series: transform(pristine) === patched", () => {
  const { pristine, patched } = states("pi-ai", "dist/utils/prompt-cache-ttl.js");
  assert.equal(injectPromptCacheTtl(pristine), patched);
});
