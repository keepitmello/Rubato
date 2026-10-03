import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TEST_RUNTIME_ENV } from "../src/engine-paths.mjs";

// Existing server-compaction tests exercise the legacy policy explicitly.
// New context-notes tests select their mode in fixtures and also run here.
const root = fileURLToPath(new URL("../", import.meta.url));
const piRuntimeRoot = join(root, "..", "pi-runtime");
const tests = readdirSync(join(root, "test/unit")).filter((name) => name.endsWith(".test.mjs")).sort()
  .map((name) => join(root, "test/unit", name));

// The provider routes read pi files that only exist after Rubato stages its features onto stock pi
// (vendored pi-ai providers, patched stock files). Tests read that same staged tree, built here
// from harness/pi-runtime's isolated stock install, never the live engine.
async function stageTestRuntime() {
  if (!existsSync(join(piRuntimeRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))) {
    throw new Error("rubato-pi unit tests need the staged pi runtime; run `npm --prefix harness/pi-runtime ci --workspaces=false --ignore-scripts` first");
  }
  const { stagePiRuntime } = await import("../../pi-runtime/stage-runtime.mjs");
  const { loadPiFeatures } = await import("../../pi-runtime/feature-catalog.mjs");
  const { CANDIDATE_FEATURE_NAMES } = await import("../../pi-runtime/features/rubato-components/candidate-main.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-test-runtime-"));
  const staged = await stagePiRuntime({
    sourceRoot: piRuntimeRoot,
    outputRoot: join(scratch, "runtime"),
    features: await loadPiFeatures(CANDIDATE_FEATURE_NAMES),
  });
  return { root: staged.root, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

const preset = process.env[TEST_RUNTIME_ENV];
const runtime = typeof preset === "string" && preset.trim() !== "" ? { root: preset, cleanup: () => {} } : await stageTestRuntime();
try {
  const result = spawnSync(process.execPath, ["--test", ...tests],
    { stdio: "inherit", cwd: root, env: { ...process.env, RUBATO_CONTEXT_MODE: "summary", [TEST_RUNTIME_ENV]: runtime.root } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  runtime.cleanup();
}
