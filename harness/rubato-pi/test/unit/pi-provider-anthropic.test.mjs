// Stock pi-ai 0.84.2 anthropic-compaction.patch: compaction_delta receive + replay.
// Fixture SSE only. No paid requests, no live credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@anthropic-ai/sdk") {
      return { url: pathToFileURL(join(here, "pi-provider-anthropic-sdk-stub.mjs")).href, shortCircuit: true };
    }
    if (specifier === "partial-json") {
      return { url: pathToFileURL(join(here, "pi-provider-partial-json-stub.mjs")).href, shortCircuit: true };
    }
    return next(specifier);
  },
});
const repoRoot = join(here, "..", "..", "..", "..");
const PATCH_DIR = join(repoRoot, "harness", "pi-patches", "pi-ai", "0.84.2");
const PATCH = join(PATCH_DIR, "anthropic-compaction.patch");
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
    return `stock fixture unreadable: ${String(error)}`;
  }
  if (!existsSync(PATCH)) return `patch missing at ${PATCH}`;
  return null;
}

const SKIP = fixtureProblem();
const opts = SKIP ? opts : {};

function runPatch(args, cwd) {
  try {
    const stdout = execFileSync("patch", args, {
      cwd,
      encoding: "utf8",
      timeout: PATCH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (error.killed || error.signal) {
      throw new Error(`patch timed out or killed (${error.signal ?? "timeout"}): ${args.join(" ")}`);
    }
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function compactionSse() {
  return (
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [{ type: "compaction", input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
        },
      },
    }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "compaction", content: null },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "compaction_delta", content: "SUMMARY" },
    }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }) +
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "hi" },
    }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    }) +
    sseEvent("message_stop", { type: "message_stop" })
  );
}

const MODEL = {
  id: "claude-opus-5",
  provider: "anthropic",
  api: "anthropic-messages",
  name: "Opus 5",
  input: ["text"],
  maxTokens: 128,
  contextWindow: 200_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  compat: {},
};

function fakeClient(body, capture) {
  return {
    messages: {
      create(params) {
        if (capture) capture.params = params;
        return {
          asResponse: async () =>
            new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        };
      },
    },
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("anthropic-compaction.patch applies to stock 0.84.2", opts, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-anthropic-"));
  const pkgDir = join(dir, "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const ok = runPatch([...PATCH_FLAGS, "-i", PATCH], pkgDir);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(`${ok.stdout}\n${ok.stderr}`, /anthropic-messages\.js/);
});

test("anthropic-compaction.patch rejects drifted pristine hunk", opts, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-anthropic-drift-"));
  const pkgDir = join(dir, "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const target = join(pkgDir, "dist", "api", "anthropic-messages.js");
  const before = readFileSync(target, "utf8");
  const needle = "function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, deferredToolNames = new Set(), normalizeToolName = (name) => name) {";
  assert.equal(before.includes(needle), true);
  writeFileSync(target, before.replace(needle, "function convertMessages(drifted) {"));
  const bad = runPatch([...PATCH_FLAGS, "-i", PATCH], pkgDir);
  assert.notEqual(bad.status, 0, `${bad.stdout}\n${bad.stderr}`);
});

test("fixture SSE compaction_delta becomes providerNative compaction + usage.compaction", opts, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-anthropic-run-"));
  const pkgDir = join(dir, "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const ok = runPatch([...PATCH_FLAGS, "-i", PATCH], pkgDir);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const { stream } = await import(pathToFileURL(join(pkgDir, "dist", "api", "anthropic-messages.js")).href);
  const events = await collect(stream(MODEL, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {
    client: fakeClient(compactionSse()),
  }));
  const done = events.find((event) => event.type === "done");
  assert.ok(done, `no done in ${events.map((e) => e.type).join(",")}`);
  const compaction = done.message.content.find((block) => block.subtype === "compaction");
  assert.equal(compaction?.raw?.content, "SUMMARY");
  assert.equal(done.message.usage.compaction?.output, 4);
});

test("replay sends compaction block and omits earlier thinking", opts, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-provider-anthropic-replay-"));
  const pkgDir = join(dir, "pkg");
  cpSync(FIXTURE, pkgDir, { recursive: true });
  const ok = runPatch([...PATCH_FLAGS, "-i", PATCH], pkgDir);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  const { stream } = await import(pathToFileURL(join(pkgDir, "dist", "api", "anthropic-messages.js")).href);
  const capture = {};
  const prior = {
    role: "assistant",
    provider: "anthropic",
    api: "anthropic-messages",
    content: [
      { type: "thinking", thinking: "old", thinkingSignature: "sig" },
      { type: "providerNative", subtype: "compaction", raw: { type: "compaction", content: "SUMMARY" } },
      { type: "text", text: "after" },
    ],
    timestamp: 1,
  };
  await collect(stream(MODEL, {
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      prior,
      { role: "user", content: "again", timestamp: 2 },
    ],
  }, { client: fakeClient(compactionSse(), capture) }));
  const assistant = capture.params.messages.find((msg) => msg.role === "assistant");
  assert.ok(assistant);
  assert.equal(assistant.content.some((block) => block.type === "thinking"), false);
  assert.deepEqual(assistant.content.find((block) => block.type === "compaction"), { type: "compaction", content: "SUMMARY" });
});
