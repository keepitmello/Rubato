import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { feature, files, patches, patchInteractiveTranscript } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js");
const tuiPackage = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "rubato-transcript-cache-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function child(id, cost = 1) {
  let renders = 0;
  return {
    id,
    get renders() { return renders; },
    render() {
      renders += 1;
      return Array.from({ length: cost }, () => `line-${id}`);
    },
  };
}

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "transcript-cache");
  assert.equal(PI_FEATURE_NAMES.includes("transcript-cache"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("transcript-cache"), true);
  assert.deepEqual((await loadPiFeatures(["transcript-cache"])).map((entry) => entry.id), ["transcript-cache"]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockPath)));
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/transcript-cache/progressive-transcript-container.mjs"]);
  const patched = patchInteractiveTranscript(readFileSync(stockPath, "utf8"));
  assert.match(patched, /new ProgressiveTranscriptContainer/);
});

test("first paint only renders the tail; later hydration warms the head", async () => {
  const work = scratch;
  mkdirSync(join(work, "node_modules/@earendil-works"), { recursive: true });
  symlinkSync(tuiPackage, join(work, "node_modules/@earendil-works/pi-tui"));
  writeFileSync(join(work, "progressive-transcript-container.mjs"), readFileSync(join(featureDir, "progressive-transcript-container.mjs")));
  const { ProgressiveTranscriptContainer } = await import(pathToFileURL(join(work, "progressive-transcript-container.mjs")).href + "?paint");
  const children = Array.from({ length: 8 }, (_, i) => child(i));
  let paints = 0;
  const container = new ProgressiveTranscriptContainer({
    tailBudget: 3,
    warmChunkSize: 2,
    requestRender: () => { paints += 1; },
  });
  for (const item of children) container.addChild(item);
  const first = container.render(40);
  assert.deepEqual(first, ["line-5", "line-6", "line-7"]);
  assert.equal(children[0].renders, 0);
  assert.equal(children[5].renders, 1);
  await delay(20);
  assert.ok(children[0].renders >= 1);
  assert.equal(container.isFullyHydrated, true);
  assert.ok(paints >= 1);
});
