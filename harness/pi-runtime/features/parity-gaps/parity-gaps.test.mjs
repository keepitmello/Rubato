import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  patchAuthStorage,
  patchGoogleSharedInputGuard,
  patchOverflow,
  patchPromptCacheTtl,
  patchToolDescriptions,
  files,
  patches,
} from "./patches.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ai = join(here, "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist");
const ag = join(here, "../../node_modules/@earendil-works/pi-coding-agent/dist");

test("parity-gaps patches match stock preimages and apply", () => {
  const byId = Object.fromEntries(patches.map((p) => [p.id, p]));
  const overflow = readFileSync(join(ai, "utils/overflow.js"), "utf8");
  assert.equal(byId.overflow.preimageSha256.length, 64);
  const o = patchOverflow(overflow);
  assert.match(o, /conversation is too long/);
  assert.match(o, /message\.usage\.input \?\? 0/);
  const g = patchGoogleSharedInputGuard(readFileSync(join(ai, "api/google-shared.js"), "utf8"));
  assert.match(g, /model\.input\?\.includes\("image"\)/);
  const c = patchPromptCacheTtl(readFileSync(join(ai, "api/openai-responses.js"), "utf8"));
  assert.match(c, /return \{ ttl: "30m" \};\n    return \{ ttl: "30m" \};/);
  const a = patchAuthStorage(readFileSync(join(ag, "core/auth-storage.js"), "utf8"));
  assert.match(a, /function atomicWriteAuthFileSync/);
  assert.match(a, /atomicWriteAuthFileSync\(this\.authPath, next\)/);
  const t = patchToolDescriptions(readFileSync(join(ag, "core/tools/tool-definition-wrapper.js"), "utf8"));
  assert.match(t, /slimToolDescription\(definition\.name/);
  assert.match(t, /from "\.\.\/\.\.\/rubato-features\/parity-gaps\/slim\.mjs"/);
  assert.deepEqual(files.map((entry) => entry.path), ["dist/rubato-features/parity-gaps/slim.mjs"]);
});
