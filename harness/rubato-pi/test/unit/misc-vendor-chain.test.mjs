import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../../src/no-changelog-hooks.mjs";
import {
  injectModelSelector,
  injectTuiEditor,
  isAuthStorageUrl,
  isHighReasoningUrl,
  isModelSelectorUrl,
  isPiAiLazyUrl,
  isPromptCacheTtlUrl,
  isTuiAutocompleteUrl,
  isTuiDollarUrl,
  isTuiEditorUrl,
  isTuiSlashUrl,
} from "../../src/transforms/misc-vendor.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";

function loaderFor(source) {
  return () => ({ format: "module", source, shortCircuit: true });
}

async function runLoad(url, source) {
  return await load(url, {}, loaderFor(source));
}

test("url matchers hit the nested realpath shape and ignore neighbors", () => {
  // Verified 2026-08-31 by importing through a custom loader + senpiNested() realpath.
  // Node hands the bun store path, but it still contains these substrings:
  //   .../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/lazy.js
  //   .../node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-tui/dist/components/editor.js
  //   .../node_modules/@code-yeongyu/senpi/dist/core/auth-storage.js
  const bunPiAi =
    "file:///Users/x/node_modules/.bun/@code-yeongyu+senpi@2026.8.22/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/lazy.js";
  const bunTtl =
    "file:///Users/x/node_modules/.bun/@code-yeongyu+senpi@2026.8.22/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/utils/prompt-cache-ttl.js";
  const bunEditor =
    "file:///Users/x/node_modules/.bun/@code-yeongyu+senpi@2026.8.22/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-tui/dist/components/editor.js";
  assert.equal(isPiAiLazyUrl(bunPiAi), true);
  assert.equal(isPiAiLazyUrl(bunPiAi.replace("api/lazy.js", "api/google-generative-ai.lazy.js")), false);
  assert.equal(isPromptCacheTtlUrl(bunTtl), true);
  assert.equal(isTuiEditorUrl(bunEditor), true);
  assert.equal(isTuiAutocompleteUrl("file:///x/pi-tui/dist/autocomplete.js"), true);
  assert.equal(isTuiAutocompleteUrl("file:///x/pi-tui/dist/dollar-invocation-autocomplete.js"), false);
  assert.equal(isTuiDollarUrl("file:///x/pi-tui/dist/dollar-invocation-autocomplete.js"), true);
  assert.equal(isTuiSlashUrl("file:///x/pi-tui/dist/slash-command-autocomplete.js"), true);
  assert.equal(isModelSelectorUrl("file:///x/@code-yeongyu/senpi/dist/modes/interactive/components/model-selector.js"), true);
  assert.equal(isHighReasoningUrl("file:///x/@code-yeongyu/senpi/dist/core/high-reasoning-warning.js"), true);
  assert.equal(isAuthStorageUrl("file:///x/@code-yeongyu/senpi/dist/core/auth-storage.js"), true);
});

test("missing pristine needles throw so applyTransform can swallow drift", () => {
  assert.throws(() => injectModelSelector("export class ModelSelectorComponent {}"), /misc vendor transform drift/);
  assert.throws(() => injectTuiEditor("export class Editor {}"), /misc vendor transform drift/);
});

test("editor.js needles survive the full loader chain (mouse + paste + misc)", async () => {
  const pair = vendorFileStates("senpi-tui", "dist/components/editor.js");
  assert.ok(pair);
  const url = "file:///x/node_modules/@earendil-works/pi-tui/dist/components/editor.js";
  const result = await runLoad(url, pair.pristine);
  const out = String(result.source);
  assert.match(out, /rubato\.editorMouse\.injected/);
  assert.match(out, /rubato\.pasteExpand\.injected/);
  assert.match(out, /inlineSlashTokenAt/);
  assert.match(out, /isInlineSlash/);
  assert.match(out, /isInlineDollar/);
  assert.match(out, /return true;/);
});

test("already-patched editor: misc transform is inert, mouse/paste still compose", async () => {
  const pair = vendorFileStates("senpi-tui", "dist/components/editor.js");
  assert.ok(pair);
  const url = "file:///x/node_modules/@earendil-works/pi-tui/dist/components/editor.js";
  const result = await runLoad(url, pair.patched);
  const out = String(result.source);
  // TUI slash needles are already gone, so injectTuiEditor throws and is swallowed.
  // editor-mouse / paste-expand needles are unrelated and still match.
  assert.match(out, /rubato\.editorMouse\.injected/);
  assert.match(out, /rubato\.pasteExpand\.injected/);
  assert.equal(out.split("import { inlineSlashTokenAt }").length - 1, 1);
  assert.match(out, /isInlineSlash/);
});

test("already-patched pi-ai lazy stays inert through the loader", async () => {
  const pair = vendorFileStates("pi-ai", "dist/api/lazy.js");
  assert.ok(pair);
  const url =
    "file:///x/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/lazy.js";
  const result = await runLoad(url, pair.patched);
  assert.equal(String(result.source), pair.patched);
});

test("pristine pi-ai lazy is rewritten by the loader", async () => {
  const pair = vendorFileStates("pi-ai", "dist/api/lazy.js");
  assert.ok(pair);
  const url =
    "file:///x/node_modules/@code-yeongyu/senpi/node_modules/@earendil-works/pi-ai/dist/api/lazy.js";
  const result = await runLoad(url, pair.pristine);
  assert.equal(String(result.source), pair.patched);
});
