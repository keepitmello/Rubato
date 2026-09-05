// Stock pi-ai event-stream local-work, overflow, thinking-levels patches.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const PATCH_DIR = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2");
const FIXTURE = process.env.PI_STOCK_PI_AI_DIR ?? "/tmp/pi-provider-st_01a0729f/stock-pi-ai";
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
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

function apply(pkgDir, name) {
  try {
    const stdout = execFileSync("patch", [...PATCH_FLAGS, "-i", join(PATCH_DIR, name)], {
      cwd: pkgDir,
      encoding: "utf8",
      timeout: PATCH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (error.killed || error.signal) throw new Error(`patch killed (${error.signal ?? "timeout"})`);
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

function copyStock() {
  const pkgDir = join(mkdtempSync(join(tmpdir(), "pi-provider-stream-")), "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  return pkgDir;
}

test("trackLocalWork keeps hasPendingLocalWork true until the work settles", opts, async () => {
  const pkgDir = copyStock();
  const ok = apply(pkgDir, "event-stream-local-work.patch");
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const { EventStream } = await import(pathToFileURL(join(pkgDir, "dist", "utils", "event-stream.js")).href);
  const stream = new EventStream(() => false, () => undefined);
  assert.equal(stream.hasPendingLocalWork(), false);
  let release;
  const work = new Promise((resolve) => {
    release = resolve;
  });
  const tracked = stream.trackLocalWork(work);
  assert.equal(stream.hasPendingLocalWork(), true);
  release();
  await tracked;
  assert.equal(stream.hasPendingLocalWork(), false);
});

test("overflow detects Codex wording and ignores cacheRead-only silent stop", opts, async () => {
  const pkgDir = copyStock();
  const ok = apply(pkgDir, "overflow.patch");
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const { isContextOverflow } = await import(pathToFileURL(join(pkgDir, "dist", "utils", "overflow.js")).href);
  assert.equal(isContextOverflow({
    stopReason: "error",
    errorMessage: "This conversation is too long. Please try a shorter message.",
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  }, 100), true);
  assert.equal(isContextOverflow({
    stopReason: "stop",
    usage: { input: 10, output: 1, cacheRead: 5000, cacheWrite: 0 },
  }, 100), false);
  assert.equal(isContextOverflow({
    stopReason: "stop",
    usage: { input: 200, output: 1, cacheRead: 0, cacheWrite: 0 },
  }, 100), true);
});

test("thinking-levels omits off/minimal and keeps graded wire steps", opts, () => {
  const pkgDir = copyStock();
  const ok = apply(pkgDir, "thinking-levels.patch");
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const source = readFileSync(join(pkgDir, "dist", "models.js"), "utf8");
  assert.match(source, /const graded = \[\];/);
  assert.match(source, /for \(const level of \["low", "medium", "high", "xhigh", "max"\]\)/);
  assert.doesNotMatch(source, /return EXTENDED_THINKING_LEVELS.filter/);
});

test("google-input-guard.patch optional-chains model.input", opts, () => {
  const pkgDir = copyStock();
  const ok = apply(pkgDir, "google-input-guard.patch");
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const shared = readFileSync(join(pkgDir, "dist", "api", "google-shared.js"), "utf8");
  const transform = readFileSync(join(pkgDir, "dist", "api", "transform-messages.js"), "utf8");
  assert.match(shared, /model\.input\?\.includes\("image"\)/);
  assert.match(transform, /model\.input\?\.includes\("image"\)/);
});
