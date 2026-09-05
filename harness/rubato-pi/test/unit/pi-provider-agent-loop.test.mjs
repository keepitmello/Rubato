// Stock pi-agent-core: withEmptyAssistantRecovery wrap + local-work watchdog.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const CORE_PATCH = join(repoRoot, "harness", "pi-patches", "pi-agent-core", "0.84.2");
const AI_PATCH = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2");
const STOCK_CORE = process.env.PI_STOCK_PI_AGENT_CORE_DIR ?? "/tmp/pi-provider-st_01a0729f/stock-pi-agent-core";
const STOCK_AI = process.env.PI_STOCK_PI_AI_DIR ?? "/tmp/pi-provider-st_01a0729f/stock-pi-ai";
const PATCH_FLAGS = ["-p1", "--fuzz=0", "--batch", "--forward"];

function fixtureProblem() {
  for (const [label, dir, want] of [
    ["pi-agent-core", STOCK_CORE, "pi-agent-core"],
    ["pi-ai", STOCK_AI, "pi-ai"],
  ]) {
    if (!existsSync(join(dir, "package.json"))) return `${label} missing at ${dir}`;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.version !== "0.84.2" || String(pkg.name).includes("senpi") || !String(pkg.name).endsWith(want)) {
      return `${label} is ${pkg.name}@${pkg.version}`;
    }
  }
  return null;
}

const SKIP = fixtureProblem();
const opts = SKIP ? { skip: SKIP } : {};

function apply(cwd, patch) {
  execFileSync("patch", [...PATCH_FLAGS, "-i", patch], {
    cwd,
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function overlayOwned(srcRoot, destRoot) {
  const owned = join(srcRoot, "owned");
  if (existsSync(owned)) cpSync(owned, destRoot, { recursive: true });
}

test("loop wrap and watchdog patches apply in order", opts, () => {
  const pkgDir = join(mkdtempSync(join(tmpdir(), "pi-provider-loop-")), "pkg");
  cpSync(STOCK_CORE, pkgDir, { recursive: true });
  overlayOwned(CORE_PATCH, pkgDir);
  apply(pkgDir, join(CORE_PATCH, "empty-assistant-recovery-export.patch"));
  apply(pkgDir, join(CORE_PATCH, "empty-assistant-recovery-loop.patch"));
  apply(pkgDir, join(CORE_PATCH, "stream-local-work-watchdog.patch"));
  const loop = readFileSync(join(pkgDir, "dist", "agent-loop.js"), "utf8");
  assert.match(loop, /withEmptyAssistantRecovery\(config\.model, streamFunction\)/);
  assert.match(loop, /hasPendingLocalWork/);
  assert.match(loop, /iterateAssistantEventsWithLocalWorkWatchdog/);
  assert.doesNotMatch(loop, /assistant-terminal-state/);
  assert.doesNotMatch(loop, /removedToolHints/);
});

test("watchdog re-arms while hasPendingLocalWork is true, then times out", opts, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-provider-loop-run-"));
  const aiDir = join(root, "ai");
  const coreDir = join(root, "core");
  cpSync(STOCK_AI, aiDir, { recursive: true });
  overlayOwned(AI_PATCH, aiDir);
  apply(aiDir, join(AI_PATCH, "event-stream-local-work.patch"));
  apply(aiDir, join(AI_PATCH, "index-empty-recovery-exports.patch"));
  const typebox = "/tmp/pi-rg-fixture/node_modules/@earendil-works/pi-coding-agent/node_modules";
  if (existsSync(typebox)) symlinkSync(typebox, join(aiDir, "node_modules"));
  cpSync(STOCK_CORE, coreDir, { recursive: true });
  overlayOwned(CORE_PATCH, coreDir);
  apply(coreDir, join(CORE_PATCH, "empty-assistant-recovery-export.patch"));
  apply(coreDir, join(CORE_PATCH, "empty-assistant-recovery-loop.patch"));
  apply(coreDir, join(CORE_PATCH, "stream-local-work-watchdog.patch"));

  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@earendil-works/pi-ai") {
        return { url: pathToFileURL(join(aiDir, "dist", "index.js")).href, shortCircuit: true };
      }
      return next(specifier);
    },
  });

  const { EventStream } = await import(pathToFileURL(join(aiDir, "dist", "utils", "event-stream.js")).href);
  const { runAgentLoop, StreamStartTimeoutError } = await import(
    pathToFileURL(join(coreDir, "dist", "agent-loop.js")).href
  );

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending = true;
  const streamFn = async () => {
    const stream = new EventStream((event) => event.type === "done", (event) => event.message);
    stream.hasPendingLocalWork = () => pending;
    return stream;
  };
  const user = { role: "user", content: "hi", timestamp: 1 };
  const context = { systemPrompt: "", messages: [], tools: [] };
  const config = {
    model: { id: "gpt-5.6-terra", provider: "openai-codex", api: "openai-codex-responses" },
    convertToLlm: async (messages) => messages,
    streamStartTimeoutMs: 1000,
    apiKey: "test-not-live",
  };
  const running = runAgentLoop([user], context, config, async () => {}, undefined, streamFn);
  pending = true;
  await t.mock.timers.tickAsync(1000);
  pending = false;
  await t.mock.timers.tickAsync(1000);
  await assert.rejects(running, (error) => error?.name === "StreamStartTimeoutError" || error instanceof StreamStartTimeoutError);
});
