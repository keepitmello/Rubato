import assert from "node:assert/strict";
import { PI_VERSION } from "../../pi-version.mjs";
import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { feature, files, patches, patchTuiAutocomplete, patchTuiEditor } from "./patches.mjs";
import { inlineSlashTokenAt, isInlineDollarToken, getDollarInvocationContext } from "./inline.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
// Wherever the install puts pi-tui (nested under pi-coding-agent in 0.86.1, hoisted since 1.0).
const tuiDir = resolvePiRuntime({ root: join(featureDir, "../..") }).packages["@earendil-works/pi-tui"].dir;
const tuiDist = join(tuiDir, "dist");
// Stock autocomplete.js imports ./utils.js, which imports get-east-asian-width.
// The isolated fixture copies the module graph, so both must come along.
const eastAsianWidthDir = dirname(findPackageJSON("get-east-asian-width", pathToFileURL(join(tuiDir, "package.json"))));
const scratch = mkdtempSync(join(tmpdir(), "rubato-tui-autocomplete-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "tui-autocomplete");
  assert.equal(PI_FEATURE_NAMES.includes("tui-autocomplete"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("tui-autocomplete"), true);
  assert.deepEqual((await loadPiFeatures(["tui-autocomplete"])).map((entry) => entry.id), ["tui-autocomplete"]);
  assert.equal(patches.length, 2);
  assert.ok(patches.every((entry) => entry.version === PI_VERSION));
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
  assert.match(patched, /cursorLine === 0 && commandText.startsWith/);
  assert.match(patched, /inlineSlashTokenAt/);
  assert.match(patched, /getDollarInvocationContext/);

  const work = join(scratch, "ac");
  mkdirSync(join(work, "rubato-features/tui-autocomplete"), { recursive: true });
  writeFileSync(join(work, "autocomplete.js"), patched);
  cpSync(join(tuiDist, "fuzzy.js"), join(work, "fuzzy.js"));
  cpSync(join(tuiDist, "utils.js"), join(work, "utils.js"));
  mkdirSync(join(work, "node_modules"), { recursive: true });
  symlinkSync(eastAsianWidthDir, join(work, "node_modules/get-east-asian-width"), "dir");
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

  // 1.0 (#10218) opens the command menu after leading whitespace. Kept: before the upgrade the
  // stock check failed there and Rubato's inline path showed skills only, which no feature asked for.
  const indented = ["  /res"];
  const indentedPatched = await provider.getSuggestions(indented, 0, indented[0].length, { force: false });
  assert.deepEqual(indentedPatched.items.map((item) => item.value), ["resume"]);
  assert.equal(indentedPatched.prefix, "/res");
  // The command menu stays on the first line; later lines only complete inline /skill: tokens.
  const secondLine = ["first line", "/res"];
  const secondPatched = await provider.getSuggestions(secondLine, 1, secondLine[1].length, { force: false });
  assert.equal((secondPatched?.items ?? []).some((item) => item.value === "resume"), false);
  // "/a/b" at the start is a path, not a command.
  const slashPath = ["/usr/lo"];
  assert.equal(await provider.getSuggestions(slashPath, 0, slashPath[0].length, { force: false }), null);
  // A leading $ run offers commands and skills on line 0.
  const leadingDollar = ["$re"];
  const leading = await provider.getSuggestions(leadingDollar, 0, leadingDollar[0].length, { force: false });
  assert.ok(leading.items.some((item) => item.value === "/resume"));
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
