import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STOCK_PI_FALLBACK_NOTICE,
  applyStockPiProcessEnv,
  resolveLaunchEngine,
  stockPiLaunchEnv,
  stripNoChangelogNodeOptions,
} from "../../src/launch.mjs";
import { defaultStockEngineDir } from "../../src/engine-paths.mjs";

function plantReceipt(home) {
  const root = defaultStockEngineDir(home);
  const entryRel = "rubato-features/rubato-components/candidate-main.mjs";
  mkdirSync(join(root, "rubato-features/rubato-components"), { recursive: true });
  writeFileSync(join(root, entryRel), "export {};");
  writeFileSync(join(root, "rubato-install.json"), JSON.stringify({
    version: 1, state: "ready", features: ["rubato-components"], candidateEntry: entryRel,
  }));
  return { root, entry: join(root, entryRel) };
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "rubato-launch-engine-followup-"));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("a present but invalid receipt falls back to senpi with a notice", () => {
  withHome((home) => {
    const planted = plantReceipt(home);
    rmSync(planted.entry);
    const resolved = resolveLaunchEngine({ env: { HOME: home } });
    assert.equal(resolved.engine, "senpi");
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.notice, STOCK_PI_FALLBACK_NOTICE);
  });
});

test("unknown RUBATO_ENGINE warns and uses the default rule", () => {
  withHome((home) => {
    const resolved = resolveLaunchEngine({ env: { HOME: home, RUBATO_ENGINE: "stockpi" } });
    assert.equal(resolved.engine, "senpi");
    assert.match(resolved.warning, /unknown RUBATO_ENGINE=stockpi/);
    assert.equal(resolved.notice, null);
  });
});

test("stockPiLaunchEnv strips SENPI_BIN and no-changelog NODE_OPTIONS from env and process.env", () => {
  const env = stockPiLaunchEnv({
    SENPI_BIN: "/tmp/senpi",
    SENPI_BRAND: "x",
    SENPI_CODING_AGENT_DIR: "/tmp/senpi-agent",
    NODE_OPTIONS: "--import=file:///tmp/no-changelog-register.mjs --trace-uncaught",
    HOME: "/tmp/home",
  }, "/tmp/agent");
  assert.equal(env.SENPI_BIN, undefined);
  assert.equal(env.SENPI_BRAND, undefined);
  assert.equal(env.SENPI_CODING_AGENT_DIR, undefined);
  assert.equal(env.RUBATO_CANDIDATE_AGENT_DIR, "/tmp/agent");
  assert.match(env.RUBATO_BOOT_CHROME_HREF, /boot-chrome.mjs$/);
  assert.equal(env.NODE_OPTIONS, "--trace-uncaught");
  assert.equal(stripNoChangelogNodeOptions("--import=/x/no-changelog-register.mjs"), undefined);
  // Separate form must not leave an orphan flag behind ("--import --trace-uncaught" makes node refuse to start).
  assert.equal(stripNoChangelogNodeOptions("--import file:///x/no-changelog-register.mjs --trace-uncaught"), "--trace-uncaught");
  assert.equal(stripNoChangelogNodeOptions("--trace-uncaught --import file:///x/no-changelog-register.mjs"), "--trace-uncaught");
  assert.equal(stripNoChangelogNodeOptions("--import file:///x/other-loader.mjs"), "--import file:///x/other-loader.mjs");
  const prevBin = process.env.SENPI_BIN;
  const prevOpts = process.env.NODE_OPTIONS;
  process.env.SENPI_BIN = "/live/senpi";
  process.env.NODE_OPTIONS = "--import=file:///tmp/no-changelog-register.mjs";
  try {
    applyStockPiProcessEnv(env);
    assert.equal(process.env.SENPI_BIN, undefined);
    assert.equal(process.env.NODE_OPTIONS, "--trace-uncaught");
    assert.equal(process.env.RUBATO_CANDIDATE_AGENT_DIR, "/tmp/agent");
  } finally {
    if (prevBin === undefined) delete process.env.SENPI_BIN; else process.env.SENPI_BIN = prevBin;
    if (prevOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prevOpts;
    delete process.env.RUBATO_CANDIDATE_AGENT_DIR;
    delete process.env.RUBATO_BOOT_CHROME_HREF;
    delete process.env.RUBATO_ROLE_PROMPT_MODULE;
    delete process.env.RUBATO_ROLE_CONTRACT_MODULE;
  }
});
