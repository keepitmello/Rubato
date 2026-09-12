import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { installTitleGuard } from "./title-guard.mjs";
import { feature, files, patches, patchTerminalTitle } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const stockPath = join(featureDir, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/terminal.js");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("descriptor is stock-locked and listed on the candidate", async () => {
  assert.equal(feature.id, "title-guard");
  assert.equal(PI_FEATURE_NAMES.includes("title-guard"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("title-guard"), true);
  assert.deepEqual((await loadPiFeatures(["title-guard"])).map((entry) => entry.id), ["title-guard"]);
  assert.equal(patches[0].preimageSha256, sha256(readFileSync(stockPath)));
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/title-guard/title-guard.mjs"]);
  const patched = patchTerminalTitle(readFileSync(stockPath, "utf8"));
  assert.match(patched, /installTitleGuard\(ProcessTerminal.prototype\)/);
});

test("identical titles emit OSC 0 once", () => {
  const writes = [];
  class FakeTerminal {
    setTitle(title) {
      const sanitized = String(title).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      writes.push(`\x1b]0;${sanitized}\x07`);
    }
  }
  assert.equal(installTitleGuard(FakeTerminal.prototype), true);
  const term = new FakeTerminal();
  for (let i = 0; i < 40; i += 1) term.setTitle("rubato - bash");
  term.setTitle("rubato - read");
  term.setTitle("rubato - read");
  assert.deepEqual(writes, ["\x1b]0;rubato - bash\x07", "\x1b]0;rubato - read\x07"]);
  assert.equal(installTitleGuard(FakeTerminal.prototype), false);
});
