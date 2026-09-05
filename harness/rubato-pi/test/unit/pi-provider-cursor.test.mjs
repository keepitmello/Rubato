// Owned cursor overlay on stock 0.84.2: rotation forget + bridge path.
// Persist files stay in a 0700 temp dir. Never reads live credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_AI_OWNED_OVERLAY, resolvePiAiFile } from "../../src/pi-provider-bridge.mjs";
import { SUPPORTED_PROVIDER_IDS } from "../../src/provider-ids.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const ROTATION = join(PI_AI_OWNED_OVERLAY, "dist", "api", "cursor-conversation-rotation.js");
const CURSOR_PROVIDER = join(PI_AI_OWNED_OVERLAY, "dist", "providers", "cursor.js");
const FIXTURE = process.env.PI_STOCK_PI_AI_DIR ?? "/tmp/pi-provider-st_01a0729f/stock-pi-ai";

function fixtureProblem() {
  if (!existsSync(ROTATION)) return `owned rotation missing at ${ROTATION}`;
  if (!existsSync(CURSOR_PROVIDER)) return `owned cursor provider missing at ${CURSOR_PROVIDER}`;
  if (!existsSync(join(FIXTURE, "package.json"))) return `stock pi-ai missing at ${FIXTURE}`;
  try {
    const pkg = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || String(pkg.name).includes("senpi")) {
      return `stock fixture is ${pkg.name}@${pkg.version}`;
    }
  } catch (error) {
    return `unreadable: ${String(error)}`;
  }
  return null;
}

const SKIP = fixtureProblem();
const opts = SKIP ? opts : {};

test("owned overlay is not under the user home profile", () => {
  assert.equal(PI_AI_OWNED_OVERLAY.startsWith(homedir()), false);
  assert.equal(PI_AI_OWNED_OVERLAY.includes(".rubato-pi"), false);
});

test("SUPPORTED_PROVIDER_IDS still lists every current provider", () => {
  assert.deepEqual([...SUPPORTED_PROVIDER_IDS], [
    "openai-codex",
    "xai",
    "anthropic",
    "cursor",
    "kiro",
    "google-antigravity",
    "opencode",
  ]);
});

test("bridge resolves stock anthropic factory and owned cursor module", opts, () => {
  const env = { PI_STOCK_PI_AI_DIR: FIXTURE };
  const anthropic = resolvePiAiFile("dist/providers/anthropic.js", env);
  assert.equal(anthropic.startsWith(FIXTURE), true);
  const cursor = resolvePiAiFile("dist/providers/cursor.js", env);
  assert.equal(cursor, CURSOR_PROVIDER);
  assert.equal(existsSync(join(FIXTURE, "dist", "api", "cursor-agent.js")), false);
});

test("rotation store forgets a disposed lineage in an isolated 0700 dir", opts, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-cursor-rot-"));
  chmodSync(dir, 0o700);
  assert.equal(statSync(dir).mode & 0o077, 0);
  const persistPath = join(dir, "rotation.json");
  writeFileSync(persistPath, "{}\n", { mode: 0o600 });
  const { createConversationRotationStore } = await import(pathToFileURL(ROTATION).href);
  const store = createConversationRotationStore({ persistPath, randomId: () => "wire-2" });
  store.recordZeroTokenPoison("base-1", "wire-1");
  assert.equal(typeof store.forget, "function");
  assert.equal(store.forget("base-1"), true);
  assert.equal(store.forget("base-1"), false);
  const saved = JSON.parse(readFileSync(persistPath, "utf8"));
  assert.equal(saved["base-1"], undefined);
});
