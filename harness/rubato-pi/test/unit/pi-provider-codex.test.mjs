// Stock pi-ai 0.84.2 openai-codex-configuration-update.patch.
// No paid requests. Prelude is executed from the patched file, not a rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const PATCH = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2", "openai-codex-configuration-update.patch");
const FIXTURE = process.env.PI_STOCK_PI_AI_DIR ?? "/tmp/pi-provider-st_01a0729f/stock-pi-ai";
const PATCH_TIMEOUT_MS = 8000;
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  if (!existsSync(join(FIXTURE, "package.json"))) return `stock pi-ai missing at ${FIXTURE}`;
  try {
    const pkg = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || !String(pkg.name).endsWith("pi-ai") || String(pkg.name).includes("senpi")) {
      return `stock fixture is ${pkg.name}@${pkg.version}`;
    }
  } catch (error) {
    return `unreadable: ${String(error)}`;
  }
  if (!existsSync(PATCH)) return `patch missing at ${PATCH}`;
  return null;
}

const SKIP = fixtureProblem();
const opts = SKIP ? opts : {};

function runPatch(cwd) {
  try {
    const stdout = execFileSync("patch", [...PATCH_FLAGS, "-i", PATCH], {
      cwd,
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

function loadPrelude(source) {
  const start = source.indexOf("const astraConfigurationUpdateState = new Map();");
  const end = source.indexOf("function buildRequestBody");
  assert.ok(start >= 0 && end > start, "patched prelude missing");
  return new Function(`${source.slice(start, end)}; return { applyAstraConfigurationUpdate, isAstraConfigurationUpdateModel };`)();
}

test("openai-codex-configuration-update.patch applies", opts, () => {
  const pkgDir = join(mkdtempSync(join(tmpdir(), "pi-provider-codex-")), "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const ok = runPatch(pkgDir);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const patched = readFileSync(join(pkgDir, "dist", "api", "openai-codex-responses.js"), "utf8");
  assert.match(patched, /configuration_update/);
  assert.match(patched, /!isAstraConfigurationUpdateModel\(model\)/);
});

test("effort change inserts configuration_update and freezes request-level effort", opts, () => {
  const pkgDir = join(mkdtempSync(join(tmpdir(), "pi-provider-codex-run-")), "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  assert.equal(runPatch(pkgDir).status, 0);
  const { applyAstraConfigurationUpdate, isAstraConfigurationUpdateModel } = loadPrelude(
    readFileSync(join(pkgDir, "dist", "api", "openai-codex-responses.js"), "utf8"),
  );
  const astra = { id: "gpt-6-astra" };
  assert.equal(isAstraConfigurationUpdateModel(astra), true);
  assert.equal(isAstraConfigurationUpdateModel({ id: "gpt-5.6-terra" }), false);
  const first = { input: [{ role: "user", content: "hi" }], reasoning: { effort: "low" } };
  applyAstraConfigurationUpdate(first, astra, "s-1", "low");
  assert.equal(first.input.some((item) => item?.type === "configuration_update"), false);
  const second = {
    input: [...first.input, { role: "assistant", content: "draft" }, { role: "user", content: "deeper" }],
    reasoning: { effort: "high" },
  };
  applyAstraConfigurationUpdate(second, astra, "s-1", "high");
  assert.equal(second.reasoning.effort, "low");
  const updates = second.input.filter((item) => item?.type === "configuration_update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: "configuration_update", reasoning: { effort: "high" } });
});
