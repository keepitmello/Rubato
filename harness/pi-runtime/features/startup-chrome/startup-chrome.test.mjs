import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { BRAND_NAME } from "../statusline/brand.mjs";
import { patchInteractiveTranscript } from "../transcript-cache/patches.mjs";
import { patchInteractiveTuiInput } from "../tui-input/patches.mjs";
import { patchInteractiveTurnChrome } from "../turn-chrome/patches.mjs";
import { startupDisplayVersion, startupLogoPlain } from "./header.mjs";
import { feature, files, patches, patchStartupChrome } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const stockConfigPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "startup-chrome");
  assert.equal(PI_FEATURE_NAMES.includes("startup-chrome"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("startup-chrome"), true);
  assert.deepEqual((await loadPiFeatures(["startup-chrome"])).map((entry) => entry.id), [
    "statusline",
    "startup-chrome",
  ]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockPath)));
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/startup-chrome/header.mjs"]);
});

test("header uses the wordmark and drops the Extensions listing", () => {
  const patched = patchStartupChrome(readFileSync(stockPath, "utf8"));
  assert.match(patched, /startupDisplayVersion\(this\.version\)/);
  assert.match(patched, /theme\.fg\("accent", BRAND_NAME\)/);
  assert.doesNotMatch(patched, /theme\.fg\("accent", APP_NAME\)\) \+ theme\.fg\("dim", ` v\$\{this\.version\}`\)/);
  assert.doesNotMatch(patched, /addLoadedSection\("Extensions"/);
  assert.match(patched, /addLoadedSection\("Context"/);
  assert.match(patched, /addLoadedSection\("Skills"/);
  assert.match(patched, /rubato\.startupChrome\.hideExtensions/);
});

test("shared interactive-mode anchors survive neighbouring feature applies", () => {
  const stock = readFileSync(stockPath, "utf8");
  const composed = patchStartupChrome(patchInteractiveTranscript(patchInteractiveTurnChrome(patchInteractiveTuiInput(stock))));
  assert.match(composed, /startupDisplayVersion\(this\.version\)/);
  assert.doesNotMatch(composed, /addLoadedSection\("Extensions"/);
  assert.match(composed, /attachClipboardImage/);
  assert.match(composed, /attachToolComponent/);
  assert.match(composed, /ProgressiveTranscriptContainer/);
});

test("wordmark has no ASCII uppercase mapping, so APP_NAME stays unbranded", () => {
  assert.equal(BRAND_NAME.toUpperCase(), BRAND_NAME);
  assert.notEqual(`${BRAND_NAME.toUpperCase()}_CODING_AGENT_DIR`, "PI_CODING_AGENT_DIR");
  const stockConfig = readFileSync(stockConfigPath, "utf8");
  assert.match(stockConfig, /export const APP_NAME = piConfigName \|\| "pi"/);
  assert.match(stockConfig, /export const ENV_AGENT_DIR = `\$\{APP_NAME\.toUpperCase\(\)\}_CODING_AGENT_DIR`/);
  assert.equal(patches.some((entry) => entry.path === "dist/config.js"), false);
});

test("display version prefers RUBATO_VERSION and otherwise the product version", () => {
  assert.equal(startupDisplayVersion("0.85.1", {}), "0.0.5");
  assert.equal(startupDisplayVersion("0.85.1", { RUBATO_VERSION: "9.9.9" }), "9.9.9");
  assert.equal(startupLogoPlain("0.85.1", {}), `${BRAND_NAME} v0.0.5`);
});

test("stock config still resolves the launcher agent and sessions dirs", async () => {
  const home = mkdtempSync(join(tmpdir(), "rubato-startup-chrome-home-"));
  const agentDir = join(home, ".rubato-pi", "agent");
  const previousHome = process.env.HOME;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousSession = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const config = await import(`${pathToFileURL(stockConfigPath).href}?startup-chrome-dir=${Date.now()}`);
    assert.equal(config.APP_NAME, "pi");
    assert.equal(config.ENV_AGENT_DIR, "PI_CODING_AGENT_DIR");
    assert.equal(config.ENV_SESSION_DIR, "PI_CODING_AGENT_SESSION_DIR");
    assert.equal(config.getAgentDir(), agentDir);
    assert.equal(config.getSessionsDir(), join(agentDir, "sessions"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousSession === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSession;
  }
});

test("rendered header capture (plain + themed)", async () => {
  const { initTheme, theme } = await import(pathToFileURL(join(
    featureDir,
    "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
  )).href);
  initTheme("dark");
  const plain = startupLogoPlain("0.85.1", { RUBATO_VERSION: "0.0.5" });
  const themed = theme.bold(theme.fg("accent", BRAND_NAME)) + theme.fg("dim", ` v${startupDisplayVersion("0.85.1", { RUBATO_VERSION: "0.0.5" })}`);
  assert.equal(plain, `${BRAND_NAME} v0.0.5`);
  assert.match(themed, /𝒓𝒖𝒃𝒂𝒕𝒐/);
  assert.doesNotMatch(themed, /\bpi\b/);
  assert.match(themed, /\x1b\[/);
});
