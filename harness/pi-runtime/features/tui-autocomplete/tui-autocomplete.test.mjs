import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { feature, files, patches, patchTuiAutocomplete, patchTuiEditor } from "./patches.mjs";
import { inlineSlashTokenAt, isInlineDollarToken, getDollarInvocationContext } from "./inline.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const tuiDist = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist");
const scratch = mkdtempSync(join(tmpdir(), "rubato-tui-autocomplete-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "tui-autocomplete");
  assert.equal(PI_FEATURE_NAMES.includes("tui-autocomplete"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("tui-autocomplete"), true);
  assert.deepEqual((await loadPiFeatures(["tui-autocomplete"])).map((entry) => entry.id), ["tui-autocomplete"]);
  assert.equal(patches.length, 2);
  assert.ok(patches.every((entry) => entry.version === "0.85.1"));
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/tui-autocomplete/inline.mjs"]);
});

test("inline tokens detect mid-line /skill: and $", () => {
  assert.equal(inlineSlashTokenAt("hello /skill:web"), "/skill:web");
  assert.equal(inlineSlashTokenAt("/resume"), "/resume");
  assert.equal(inlineSlashTokenAt("path/to"), null);
  assert.equal(isInlineDollarToken("use $web"), true);
  assert.equal(isInlineDollarToken("$HOME/bin"), false);
  const ctx = getDollarInvocationContext("hello $web", 1, [{ name: "skill:web" }]);
  assert.equal(ctx.prefix, "$web");
  assert.equal(ctx.skillsOnly, true);
});

test("stock editor only allows slash menu on line 0; patch allows line 1 /skill:", async () => {
  const stock = readFileSync(join(tuiDist, "autocomplete.js"));
  assert.equal(sha256(stock), patches[0].preimageSha256);
  const patched = patchTuiAutocomplete(stock.toString("utf8"));
  assert.match(patched, /cursorLine === 0 && textBeforeCursor.startsWith/);
  assert.match(patched, /inlineSlashTokenAt/);
  assert.match(patched, /getDollarInvocationContext/);

  const work = join(scratch, "ac");
  mkdirSync(join(work, "rubato-features/tui-autocomplete"), { recursive: true });
  writeFileSync(join(work, "autocomplete.js"), patched);
  cpSync(join(tuiDist, "fuzzy.js"), join(work, "fuzzy.js"));
  cpSync(join(featureDir, "inline.mjs"), join(work, "rubato-features/tui-autocomplete/inline.mjs"));
  const { CombinedAutocompleteProvider } = await import(pathToFileURL(join(work, "autocomplete.js")).href + "?patched");
  const provider = new CombinedAutocompleteProvider([
    { name: "resume", description: "resume a session" },
    { name: "skill:web-search", description: "search the web" },
    { name: "skill:weather", description: "weather" },
  ], process.cwd());
  const stockProvider = new (await import(pathToFileURL(join(tuiDist, "autocomplete.js")).href + "?stock")).CombinedAutocompleteProvider([
    { name: "skill:web-search", description: "search the web" },
  ], process.cwd());

  const midLine = ["first line", "please /skill:web"];
  const stockMid = await stockProvider.getSuggestions(midLine, 1, midLine[1].length, { force: false });
  assert.equal((stockMid?.items ?? []).some((item) => String(item.value).includes("skill:")), false);
  const patchedMid = await provider.getSuggestions(midLine, 1, midLine[1].length, { force: false });
  assert.ok(patchedMid);
  assert.ok(patchedMid.items.some((item) => item.value === "skill:web-search"));
  assert.equal(patchedMid.prefix, "/skill:web");

  const dollarLine = ["first line", "use $we"];
  const dollar = await provider.getSuggestions(dollarLine, 1, dollarLine[1].length, { force: false });
  assert.ok(dollar);
  assert.ok(dollar.items.some((item) => item.value === "$web-search" || item.value === "$weather"));
});

test("editor patch opens slash helpers on every line", () => {
  const stock = readFileSync(join(tuiDist, "components/editor.js"));
  assert.equal(sha256(stock), patches[1].preimageSha256);
  const patched = patchTuiEditor(stock.toString("utf8"));
  assert.match(patched, /isSlashMenuAllowed\(\) \{\n        return true;/);
  assert.match(patched, /isInlineSlash/);
  assert.match(patched, /isInlineDollar/);
  assert.doesNotMatch(patched, /return this.state.cursorLine === 0;/);
});
