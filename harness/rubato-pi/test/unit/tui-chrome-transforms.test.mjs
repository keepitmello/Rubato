import test from "node:test";
import assert from "node:assert/strict";
import {
  VENDOR_PATCHES,
  applyFilePatch,
  collectPatchLayers,
  stackByFile,
} from "../../../../postinstall.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";
import {
  applyTuiChromeTransforms,
  injectAssistantDescriptors,
  injectAssistantMessage,
  injectInteractiveModeChrome,
  injectToolExecution,
  injectTranscriptCache,
  isAssistantDescriptorsUrl,
  isAssistantMessageUrl,
  isInteractiveModeUrl,
  isToolExecutionUrl,
  isTranscriptCacheUrl,
} from "../../src/transforms/tui-chrome.mjs";

const SENPI = "@code-yeongyu/senpi/dist";
const IA = "file:///tui-chrome/internal-actions.mjs";
const TG = "file:///tui-chrome/tool-group-component.mjs";
const TW = "file:///tui-chrome/turn-work-summary.mjs";
const HREFS = { internalActions: IA, toolGroup: TG, turnWork: TW };

const OUR_PATCHES = new Set([
  "@code-yeongyu%2Fsenpi@2026.8.22.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260823-20Z-tui-skill-git-group.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260825-0956Z-tool-group-interleave.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260829-thinking-lifecycle-expand.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260830-turn-work-summary.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260831-turn-work-types.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260901-untimed-thinking-toggle.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260902-turn-work-dedupe.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260903-turn-work-tool-status.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260904-turn-work-width.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260905-turn-work-chrome.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260906-tool-use-ellipsis-final.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260908-abort-once-per-turn.patch",
  "@code-yeongyu%2Fsenpi/2026.8.22/20260911-turn-work-aggregate-tools.patch",
]);

function ourStack(relativePath) {
  const states = vendorFileStates("senpi", relativePath);
  assert.ok(states, `vendorFileStates returned null for ${relativePath}`);
  const stack = (stackByFile(collectPatchLayers(VENDOR_PATCHES[0])).get(relativePath) ?? [])
    .filter((layer) => OUR_PATCHES.has(layer.patchName));
  let ours = states.pristine;
  for (const layer of stack) ours = applyFilePatch(ours, layer, layer.patchName);
  return { ...states, ours };
}

function rewriteInternalActionsImport(source, href) {
  return source.replace('from "../internal-actions.js"', `from ${JSON.stringify(href)}`);
}

function rewriteInteractiveImports(source) {
  return source
    .replace('from "./internal-actions.js"', `from ${JSON.stringify(IA)}`)
    .replace('from "./components/tool-group.js"', `from ${JSON.stringify(TG)}`)
    .replace('from "./components/turn-work-summary.js"', `from ${JSON.stringify(TW)}`);
}

test("URL matching covers only this cluster's vendor files", () => {
  assert.equal(isInteractiveModeUrl(`file:///${SENPI}/modes/interactive/interactive-mode.js`), true);
  assert.equal(isAssistantMessageUrl(`file:///${SENPI}/modes/interactive/components/assistant-message.js`), true);
  assert.equal(isToolExecutionUrl(`file:///${SENPI}/modes/interactive/components/tool-execution.js`), true);
  assert.equal(isAssistantDescriptorsUrl(`file:///${SENPI}/modes/interactive/components/assistant-render-descriptors.js`), true);
  assert.equal(isTranscriptCacheUrl(`file:///${SENPI}/modes/interactive/components/progressive-transcript-container.js`), true);
  assert.equal(isInteractiveModeUrl(`file:///${SENPI}/modes/interactive/components/footer.js`), false);
  assert.equal(isAssistantMessageUrl(`file:///${SENPI}/modes/interactive/components/assistant-render-descriptors.js`), false);
});

test("transcript cache transform(pristine) is byte-equal to the patched file", () => {
  const { pristine, patched } = ourStack("dist/modes/interactive/components/progressive-transcript-container.js");
  assert.equal(injectTranscriptCache(pristine), patched);
  assert.throws(() => injectTranscriptCache("export class ProgressiveTranscriptContainer {}"), /transcript cache rewrite/);
});

test("tool-execution transform(pristine) is byte-equal except the in-repo internal-actions href", () => {
  // Deviation: registerInternalAction is imported from the in-repo module href
  // because vendor internal-actions.js is a created file.
  const { pristine, patched } = ourStack("dist/modes/interactive/components/tool-execution.js");
  assert.equal(injectToolExecution(pristine, IA), rewriteInternalActionsImport(patched, IA));
  assert.throws(() => injectToolExecution("export class ToolExecutionComponent {}"), /tool-execution imports/);
});

test("assistant-message transform(pristine) is byte-equal except the in-repo internal-actions href", () => {
  // Deviation: registerInternalAction import path only. .d.ts hunks are skipped
  // (types never load at runtime): baseline thinking fields, #17 overrides, #19 turnWorkCollapsed.
  const { pristine, patched } = ourStack("dist/modes/interactive/components/assistant-message.js");
  assert.equal(injectAssistantMessage(pristine, IA), rewriteInternalActionsImport(patched, IA));
  assert.throws(() => injectAssistantMessage("export class AssistantMessageComponent {}"), /assistant hyperlink import/);
});

test("assistant-render-descriptors transform(pristine) is byte-equal to this cluster's stack", () => {
  // Not compared to installed patched bytes: series #31 (retry-watchdog) also
  // edits this file and is owned by another cluster.
  const { pristine, ours, patched } = ourStack("dist/modes/interactive/components/assistant-render-descriptors.js");
  const got = injectAssistantDescriptors(pristine);
  assert.equal(got, ours);
  assert.notEqual(got, patched);
  assert.throws(() => injectAssistantDescriptors("export function createAssistantRenderDescriptors() {}"), /descriptors ellipsis/);
});

test("interactive-mode transform(pristine) is byte-equal to this cluster's stack except in-repo hrefs", () => {
  // Deviations: (1) import lines rewrite created vendor files to in-repo hrefs;
  // (2) not compared to installed patched bytes because #29 interactive-control-surface
  // also edits this file and is [hard], out of this cluster.
  // .d.ts-only: skipped.
  const { pristine, ours, patched } = ourStack("dist/modes/interactive/interactive-mode.js");
  const got = injectInteractiveModeChrome(pristine, HREFS);
  assert.equal(got, rewriteInteractiveImports(ours));
  assert.notEqual(got, patched);
  assert.match(got, /attachToolComponent/);
  assert.match(got, /lastAssistantTextRunStart/);
  assert.match(got, /task-kill/);
  assert.match(got, /"tasks"/);
  assert.throws(() => injectInteractiveModeChrome("export class InteractiveMode {}"), /interactive imports/);
});

test("applyTuiChromeTransforms routes by URL and swallows drift on already-patched sources", () => {
  const { patched } = ourStack("dist/modes/interactive/components/progressive-transcript-container.js");
  const warnings = [];
  const applyTransform = (source, transform) => {
    try {
      const next = transform(source);
      return typeof next === "string" ? next : source;
    } catch (error) {
      warnings.push(error.message);
      return source;
    }
  };
  const url = `file:///x/${SENPI}/modes/interactive/components/progressive-transcript-container.js`;
  const next = applyTuiChromeTransforms(url, patched, applyTransform);
  assert.equal(next, patched);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transcript cache rewrite/);
});

test(".d.ts-only TUI chrome hunks are skipped", () => {
  // Runtime never loads these. Recorded so the cluster report stays honest.
  const skipped = [
    "dist/modes/interactive/components/assistant-message.d.ts",
    "dist/modes/interactive/components/tool-execution.d.ts",
    "dist/modes/interactive/internal-actions.d.ts",
    "dist/modes/interactive/components/assistant-render-descriptors.d.ts",
    "dist/modes/interactive/components/turn-work-summary.d.ts",
  ];
  for (const relativePath of skipped) {
    const states = vendorFileStates("senpi", relativePath);
    assert.ok(states, relativePath);
    assert.notEqual(states.pristine, states.patched, relativePath);
  }
});
