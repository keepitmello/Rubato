import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retirePath } from "../scripts/install-candidate.mjs";
import {
  engineMarkerPath,
  engineStatus,
  installStockEngine,
  rollbackEngine,
  stockEngineDir,
  switchEngine,
} from "../scripts/switch-engine.mjs";

async function fakeInstall({ outputRoot }) {
  const entryRel = "rubato-features/rubato-components/candidate-main.mjs";
  await mkdir(join(outputRoot, "rubato-features/rubato-components"), { recursive: true });
  await writeFile(join(outputRoot, entryRel), "export {}\n");
  const receipt = {
    version: 1,
    state: "ready",
    mode: "isolated-candidate",
    fullRubatoParity: false,
    stockVersion: "0.85.1",
    features: ["rubato-components"],
    candidateEntry: entryRel,
    hashes: { stageReceipt: "fake", lock: "fake" },
    installedAt: "2026-09-11T00:00:00.000Z",
  };
  await writeFile(join(outputRoot, "rubato-install.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return { root: outputRoot, receipt, previous: null };
}

test("switch-engine install/switch/rollback/status against a temp HOME", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-switch-engine-"));
  t.after(() => retirePath(scratch));
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true });
  const dest = stockEngineDir(home);

  const first = await installStockEngine({ home, install: fakeInstall });
  assert.equal(first.skipped, false);
  assert.equal(first.root, dest);
  assert.equal(first.receipt.candidateEntry.endsWith("candidate-main.mjs"), true);

  const again = await installStockEngine({ home, install: async () => {
    throw new Error("install must not run twice");
  } });
  assert.equal(again.skipped, true);

  const switched = await switchEngine({ home, install: fakeInstall });
  assert.equal(switched.engine, "stock-pi");
  assert.equal(switched.previous, "stock-pi");
  const marker = JSON.parse(await readFile(engineMarkerPath(home), "utf8"));
  assert.equal(marker.engine, "stock-pi");
  assert.equal(marker.installRoot, dest);

  const status = await engineStatus({ home });
  assert.equal(status.installed, true);
  assert.equal(status.engine, "stock-pi");
  assert.equal(status.receipt.stockVersion, "0.85.1");

  const rolled = await rollbackEngine({ home });
  assert.equal(rolled.engine, "stock-pi");
  assert.equal(rolled.previous, "stock-pi");
  const after = JSON.parse(await readFile(engineMarkerPath(home), "utf8"));
  assert.equal(after.engine, "stock-pi");
  const still = JSON.parse(await readFile(join(dest, "rubato-install.json"), "utf8"));
  assert.equal(still.state, "ready");

  const reswitch = await switchEngine({ home });
  assert.equal(reswitch.engine, "stock-pi");
  assert.equal(reswitch.previous, "stock-pi");
});

test("rollback to a senpi marker refuses instead of reviving senpi", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-switch-engine-senpi-rollback-"));
  t.after(() => retirePath(scratch));
  const home = join(scratch, "home");
  await mkdir(join(home, ".rubato-pi"), { recursive: true });
  await writeFile(engineMarkerPath(home), JSON.stringify({ engine: "stock-pi", previous: "senpi" }));
  await assert.rejects(() => rollbackEngine({ home }), /retired senpi engine/);
});

test("switch without install fails closed; switch installIfMissing uses the injected installer", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-switch-engine-missing-"));
  t.after(() => retirePath(scratch));
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true });
  await assert.rejects(switchEngine({ home, install: fakeInstall }), /not installed/);
  const marker = await switchEngine({ home, installIfMissing: true, install: fakeInstall });
  assert.equal(marker.engine, "stock-pi");
  const status = await engineStatus({ home });
  assert.equal(status.installed, true);
});

test("temp HOME never resolves to the live profile", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "rubato-switch-engine-liveguard-"));
  t.after(() => retirePath(scratch));
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true });
  const status = await engineStatus({ home });
  assert.equal(status.home, home);
  assert.equal(status.installRoot.startsWith(home), true);
  assert.equal(status.installRoot.includes(".rubato-pi/stock-engine"), true);
});

