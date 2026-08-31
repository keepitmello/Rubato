import test from "node:test";
import assert from "node:assert/strict";
import {
  VENDOR_PATCHES,
  applyFilePatch,
  collectPatchLayers,
  stackByFile,
} from "../../../../postinstall.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";
import { injectInteractiveModeChrome } from "../../src/transforms/interactive-mode-chrome.mjs";
import { stripChangelog } from "../../src/no-changelog.mjs";
import {
  applyControlCodemodeTransforms,
  injectExtensionsLoader,
  injectExtensionsRunner,
  injectInteractiveControl,
  injectSlashCommandsRemoteMode,
  isControlInteractiveModeUrl,
  isExtensionsLoaderUrl,
  isExtensionsRunnerUrl,
  isSlashCommandsUrl,
} from "../../src/transforms/control-codemode.mjs";

const SENPI = "@code-yeongyu/senpi/dist";
const IA = "file:///tui-chrome/internal-actions.mjs";
const TG = "file:///tui-chrome/tool-group-component.mjs";
const TW = "file:///tui-chrome/turn-work-summary.mjs";
const HREFS = { internalActions: IA, toolGroup: TG, turnWork: TW };
const P29 = "@code-yeongyu%2Fsenpi/2026.8.22/20260910-interactive-control-surface.patch";

function rewriteInteractiveImports(source) {
  return source
    .replace('from "./internal-actions.js"', `from ${JSON.stringify(IA)}`)
    .replace('from "./components/tool-group.js"', `from ${JSON.stringify(TG)}`)
    .replace('from "./components/turn-work-summary.js"', `from ${JSON.stringify(TW)}`);
}

function apply29OnChrome(chrome) {
  const layer = (stackByFile(collectPatchLayers(VENDOR_PATCHES[0])).get("dist/modes/interactive/interactive-mode.js") ?? [])
    .find((item) => item.patchName === P29);
  assert.ok(layer, "missing #29 layer for interactive-mode.js");
  return applyFilePatch(chrome, layer, P29);
}

test("URL matching covers only this cluster's vendor files", () => {
  assert.equal(isSlashCommandsUrl(`file:///${SENPI}/core/slash-commands.js`), true);
  assert.equal(isExtensionsLoaderUrl(`file:///${SENPI}/core/extensions/loader.js`), true);
  assert.equal(isExtensionsRunnerUrl(`file:///${SENPI}/core/extensions/runner.js`), true);
  assert.equal(isControlInteractiveModeUrl(`file:///${SENPI}/modes/interactive/interactive-mode.js`), true);
  assert.equal(isSlashCommandsUrl(`file:///${SENPI}/core/slash-commands.d.ts`), false);
  assert.equal(isExtensionsLoaderUrl(`file:///${SENPI}/core/extensions/runner.js`), false);
  assert.equal(isControlInteractiveModeUrl(`file:///${SENPI}/modes/interactive/components/footer.js`), false);
});

test("slash-commands transform(pristine) is byte-equal to the patched file", () => {
  const states = vendorFileStates("senpi", "dist/core/slash-commands.js");
  assert.ok(states);
  assert.equal(injectSlashCommandsRemoteMode(states.pristine), states.patched);
  assert.throws(() => injectSlashCommandsRemoteMode("export const BUILTIN_SLASH_COMMANDS = [];"), /slash remoteMode/);
});

test("extensions loader transform(pristine) is byte-equal to the patched file", () => {
  const states = vendorFileStates("senpi", "dist/core/extensions/loader.js");
  assert.ok(states);
  assert.equal(injectExtensionsLoader(states.pristine), states.patched);
  assert.throws(() => injectExtensionsLoader("export function loadExtensions() {}"), /extensions loader runtime/);
});

test("extensions runner transform(pristine) is byte-equal to the patched file", () => {
  const states = vendorFileStates("senpi", "dist/core/extensions/runner.js");
  assert.ok(states);
  assert.equal(injectExtensionsRunner(states.pristine), states.patched);
  assert.throws(() => injectExtensionsRunner("export class ExtensionRunner {}"), /extensions runner/);
});

test("interactive-mode transform(tui-chrome output) is byte-equal to tui-chrome stack + #29 except in-repo hrefs", () => {
  // Comparison basis: injectInteractiveModeChrome(pristine, HREFS) then #29.
  // That equals rewrite(installed patched) because installed patched is the
  // full series including tui-chrome patches + #29, and no other cluster
  // edits this file. hrefs stay rewritten from the tui-chrome step.
  const states = vendorFileStates("senpi", "dist/modes/interactive/interactive-mode.js");
  assert.ok(states);
  const chrome = injectInteractiveModeChrome(states.pristine, HREFS);
  const got = injectInteractiveControl(chrome);
  assert.equal(got, apply29OnChrome(chrome));
  assert.equal(got, rewriteInteractiveImports(states.patched));
  assert.match(got, /createInteractiveControlSurface/);
  assert.match(got, /setInteractiveControl/);
  assert.match(got, /dispatchInteractiveInput/);
  assert.match(got, /randomUUID/);
  assert.throws(() => injectInteractiveControl("export class InteractiveMode {}"), /uuid import/);
});

test("interactive-mode and slash-commands needles survive stripChangelog", () => {
  const slash = vendorFileStates("senpi", "dist/core/slash-commands.js");
  const strippedSlash = stripChangelog(slash.pristine, `file:///${SENPI}/core/slash-commands.js`);
  const slashGot = injectSlashCommandsRemoteMode(strippedSlash);
  assert.match(slashGot, /remoteMode: "terminal-only"/);
  assert.equal(slashGot.includes('{ name: "changelog"'), false);

  const im = vendorFileStates("senpi", "dist/modes/interactive/interactive-mode.js");
  const chrome = injectInteractiveModeChrome(im.pristine, HREFS);
  const stripped = stripChangelog(chrome, "interactive-mode.js");
  const got = injectInteractiveControl(stripped);
  assert.match(got, /createInteractiveControlSurface/);
  assert.match(got, /dispatchInteractiveInput/);
});

test("applyControlCodemodeTransforms routes by URL and swallows drift on already-patched sources", () => {
  const { patched } = vendorFileStates("senpi", "dist/core/slash-commands.js");
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
  const url = `file:///x/${SENPI}/core/slash-commands.js`;
  const next = applyControlCodemodeTransforms(url, patched, applyTransform);
  assert.equal(next, patched);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /slash remoteMode/);
});

test(".d.ts-only #29 hunks are skipped", () => {
  // Runtime never loads these. Recorded so the cluster report stays honest.
  const skipped = [
    "dist/core/slash-commands.d.ts",
    "dist/core/extensions/types.d.ts",
    "dist/core/extensions/runner.d.ts",
    "dist/modes/interactive/interactive-mode.d.ts",
  ];
  for (const relativePath of skipped) {
    const states = vendorFileStates("senpi", relativePath);
    assert.ok(states, relativePath);
    assert.notEqual(states.pristine, states.patched, relativePath);
  }
});
