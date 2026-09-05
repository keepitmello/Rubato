import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { injectResumeRecovery, isSdkUrl } from "../../src/transforms/core-resume-recovery.mjs";

function pinnedSdk() {
  return readFileSync(join(senpiDir, "dist/core/sdk.js"), "utf8");
}

test("sdk url matcher targets only Senpi core sdk", () => {
  assert.equal(isSdkUrl("file:///x/@code-yeongyu/senpi/dist/core/sdk.js"), true);
  assert.equal(isSdkUrl("file:///x/@code-yeongyu/senpi/dist/core/agent-session.js"), false);
});

test("an oversized persisted history opens only when the fixed model budget fits", () => {
  const source = pinnedSdk();
  const next = injectResumeRecovery(source);

  assert.match(next, /session\.assertModelUsable\(undefined, liveContextTokens\)/);
  assert.match(next, /if \(!hasExistingSession \|\| liveContextTokens <= 0\)/);
  assert.match(next, /session\.assertModelUsable\(undefined, 0\)/);
  assert.match(next, /Opened in recovery mode; run \/compact before sending or switching models/);
  assert.throws(() => injectResumeRecovery(next));
});
