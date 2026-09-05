// Exercise directProviders() against patched stock pi-ai + owned overlay.
// Isolated HOME. No live credentials, no paid requests.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const AI_PATCH = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2");
const STOCK_AI = "/tmp/pi-provider-st_01a0729f/stock-pi-ai";
const CA_NM = "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent/node_modules";
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];
const AI_PATCHES = [
  "event-stream-local-work.patch",
  "anthropic-compaction.patch",
  "openai-codex-configuration-update.patch",
  "overflow.patch",
  "google-input-guard.patch",
  "thinking-levels.patch",
  "oauth-cursor-loader.patch",
  "index-empty-recovery-exports.patch",
  "prompt-cache-ttl-export.patch",
];

function fixtureProblem() {
  if (!existsSync(join(STOCK_AI, "package.json"))) return `stock pi-ai missing at ${STOCK_AI}`;
  const pkg = JSON.parse(readFileSync(join(STOCK_AI, "package.json"), "utf8"));
  if (pkg.version !== "0.84.2" || String(pkg.name).includes("senpi")) return `stock is ${pkg.name}@${pkg.version}`;
  return null;
}

const SKIP = fixtureProblem();
const opts = SKIP ? { skip: SKIP } : {};

function stageStockPiAi() {
  const pkgDir = join(mkdtempSync(join(tmpdir(), "pi-provider-direct-")), "pkg");
  cpSync(STOCK_AI, pkgDir, { recursive: true });
  for (const name of AI_PATCHES) {
    execFileSync("patch", [...PATCH_FLAGS, "-i", join(AI_PATCH, name)], {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  cpSync(join(AI_PATCH, "owned"), pkgDir, { recursive: true });
  if (existsSync(CA_NM)) symlinkSync(CA_NM, join(pkgDir, "node_modules"));
  return pkgDir;
}

test("directProviders registers all seven ids on patched stock pi-ai", opts, async (t) => {
  const pkgDir = stageStockPiAi();
  const home = mkdtempSync(join(tmpdir(), "pi-provider-direct-home-"));
  process.env.PI_STOCK_PI_AI_DIR = pkgDir;
  process.env.HOME = home;
  process.env.RUBATO_LEGACY_AUTH_PATH = join(home, "legacy-auth.json");
  process.env.RUBATO_TARGET_AUTH_PATH = join(home, "target-auth.json");
  const { directProviders, DIRECT_PROVIDER_IDS } = await import("../../src/provider-direct.mjs");
  const providers = await directProviders({
    env: process.env,
    kiro: { env: process.env, home, readFileImpl: () => { throw new Error("no kiro file"); } },
    cursor: { env: process.env },
    antigravity: { env: process.env, fetchImpl: async () => new Response("{}", { status: 404 }) },
  });
  assert.deepEqual(providers.map((provider) => provider.id), [...DIRECT_PROVIDER_IDS]);
  for (const provider of providers) {
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.getModels, "function");
  }
});
