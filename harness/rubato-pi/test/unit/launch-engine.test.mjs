import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STOCK_PI_FALLBACK_NOTICE,
  adapterPath,
  buildSenpiArgs,
  buildStockPiArgs,
  isValidInstalledCandidateReceipt,
  leadOverlayPath,
  nodeSatisfiesCandidate,
  providerOverlayPath,
  resolveLaunchAgentDir,
  resolveLaunchEngine,
  statuslinePath,
} from "../../src/launch.mjs";
import { defaultStockEngineDir } from "../../src/engine-paths.mjs";

function plantReceipt(home, extras = {}) {
  const root = defaultStockEngineDir(home);
  const entryRel = "rubato-features/rubato-components/candidate-main.mjs";
  mkdirSync(join(root, "rubato-features/rubato-components"), { recursive: true });
  writeFileSync(join(root, entryRel), "export {}\n");
  const receipt = {
    version: 1,
    state: "ready",
    mode: "isolated-candidate",
    fullRubatoParity: false,
    stockVersion: "0.85.1",
    features: ["rubato-components"],
    candidateEntry: entryRel,
    ...extras,
  };
  writeFileSync(join(root, "rubato-install.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return { root, entry: join(root, entryRel), receipt };
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "rubato-launch-engine-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("defaultStockEngineDir lives under ~/.rubato-pi/stock-engine", () => {
  assert.equal(defaultStockEngineDir("/tmp/h"), "/tmp/h/.rubato-pi/stock-engine");
});

test("receipt without candidateEntry is not launch-valid", () => {
  assert.equal(isValidInstalledCandidateReceipt({
    version: 1, state: "ready", features: ["rubato-components"],
  }, "/tmp"), false);
});

test("valid receipt defaults the launcher to stock-pi", () => {
  withHome((home) => {
    const planted = plantReceipt(home);
    const resolved = resolveLaunchEngine({ env: { HOME: home } });
    assert.equal(resolved.engine, "stock-pi");
    assert.equal(resolved.source, "receipt");
    assert.equal(resolved.fallback, false);
    assert.equal(resolved.notice, null);
    assert.equal(resolved.entry, planted.entry);
  });
});

test("missing receipt defaults to senpi without a fallback notice", () => {
  withHome((home) => {
    const resolved = resolveLaunchEngine({ env: { HOME: home } });
    assert.equal(resolved.engine, "senpi");
    assert.equal(resolved.source, "default");
    assert.equal(resolved.fallback, false);
    assert.equal(resolved.notice, null);
  });
});

test("RUBATO_ENGINE=stock-pi with no receipt falls back to senpi with a notice", () => {
  withHome((home) => {
    const resolved = resolveLaunchEngine({ env: { HOME: home, RUBATO_ENGINE: "stock-pi" } });
    assert.equal(resolved.engine, "senpi");
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.notice, STOCK_PI_FALLBACK_NOTICE);
    assert.equal(resolved.source, "env");
  });
});

test("RUBATO_ENGINE=senpi wins even when a valid receipt exists", () => {
  withHome((home) => {
    plantReceipt(home);
    const resolved = resolveLaunchEngine({ env: { HOME: home, RUBATO_ENGINE: "senpi" } });
    assert.equal(resolved.engine, "senpi");
    assert.equal(resolved.source, "env");
    assert.equal(resolved.fallback, false);
    assert.equal(resolved.notice, null);
  });
});

test("engine.json marker selects stock-pi when the receipt is valid", () => {
  withHome((home) => {
    const planted = plantReceipt(home);
    mkdirSync(join(home, ".rubato-pi"), { recursive: true });
    writeFileSync(join(home, ".rubato-pi/engine.json"), JSON.stringify({
      engine: "stock-pi", previous: "senpi", installedAt: "2026-09-11T00:00:00.000Z",
    }));
    const resolved = resolveLaunchEngine({ env: { HOME: home } });
    assert.equal(resolved.engine, "stock-pi");
    assert.equal(resolved.source, "marker");
    assert.equal(resolved.entry, planted.entry);
  });
});

test("engine.json stock-pi with a missing install falls back with a notice", () => {
  withHome((home) => {
    mkdirSync(join(home, ".rubato-pi"), { recursive: true });
    writeFileSync(join(home, ".rubato-pi/engine.json"), JSON.stringify({ engine: "stock-pi", previous: "senpi" }));
    const resolved = resolveLaunchEngine({ env: { HOME: home } });
    assert.equal(resolved.engine, "senpi");
    assert.equal(resolved.fallback, true);
    assert.equal(resolved.notice, STOCK_PI_FALLBACK_NOTICE);
  });
});

test("env RUBATO_ENGINE overrides the marker", () => {
  withHome((home) => {
    plantReceipt(home);
    mkdirSync(join(home, ".rubato-pi"), { recursive: true });
    writeFileSync(join(home, ".rubato-pi/engine.json"), JSON.stringify({ engine: "stock-pi", previous: "senpi" }));
    const resolved = resolveLaunchEngine({ env: { HOME: home, RUBATO_ENGINE: "senpi" } });
    assert.equal(resolved.engine, "senpi");
    assert.equal(resolved.source, "env");
  });
});

test("buildStockPiArgs keeps fullscreen and user args and drops Senpi overlays", () => {
  const args = buildStockPiArgs(["--resume", "--model", "xai/grok-4.6"], { env: {} });
  assert.equal(args.includes("--system-prompt"), true);
  const senpiPrompt = buildSenpiArgs(["--resume", "--model", "xai/grok-4.6"], { env: {} });
  assert.equal(args[args.indexOf("--system-prompt") + 1], senpiPrompt[senpiPrompt.indexOf("--system-prompt") + 1]);
  assert.equal(args.includes("-e"), false);
  assert.equal(args.includes(statuslinePath()), false);
  assert.equal(args.includes(leadOverlayPath()), false);
  assert.equal(args.includes(providerOverlayPath()), false);
  assert.equal(args.includes(adapterPath()), false);
  assert.equal(args[args.indexOf("--tui-mode") + 1], "fullscreen");
  assert.deepEqual(args.slice(-3), ["--resume", "--model", "xai/grok-4.6"]);
  const rpc = buildStockPiArgs(["--mode", "rpc"]);
  assert.equal(rpc.includes("--tui-mode"), false);
  const senpi = buildSenpiArgs(["--mode", "rpc"], { env: {} });
  assert.equal(senpi.includes("--system-prompt"), true);
  assert.equal(senpi.includes(adapterPath()), true);
});

test("resolveLaunchAgentDir honors existing profile env overrides", () => {
  assert.equal(
    resolveLaunchAgentDir({ RUBATO_PI_CODING_AGENT_DIR: "/tmp/custom-agent" }, "/tmp/home"),
    "/tmp/custom-agent",
  );
  assert.equal(
    resolveLaunchAgentDir({ SENPI_CODING_AGENT_DIR: "/tmp/senpi-agent" }, "/tmp/home"),
    "/tmp/senpi-agent",
  );
  assert.match(resolveLaunchAgentDir({ HOME: "/tmp/home" }, "/tmp/home"), /\/\.rubato-pi\/agent$/);
});

test("candidate engines field matches nodeSatisfiesCandidate", () => {
  assert.equal(nodeSatisfiesCandidate("v24.18.0"), true);
  assert.equal(nodeSatisfiesCandidate("v24.15.0"), true);
  assert.equal(nodeSatisfiesCandidate("v24.14.9"), false);
  assert.equal(nodeSatisfiesCandidate("v26.5.0"), true);
  assert.equal(nodeSatisfiesCandidate("v22.20.0"), false);
});
