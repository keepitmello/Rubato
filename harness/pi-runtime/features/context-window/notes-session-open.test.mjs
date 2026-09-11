import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-notes-session-open-"));
const previousHome = process.env.HOME;
const previousOffline = process.env.PI_OFFLINE;
const previousMode = process.env.RUBATO_CONTEXT_MODE;
const previousOrigin = process.env.RUBATO_CONTEXT_MODE_ORIGIN;
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
delete process.env.RUBATO_CONTEXT_MODE;
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
mkdirSync(process.env.HOME, { recursive: true });

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...await loadPiFeatures(["context-notes", "context-window"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const protocol = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/protocol.mjs",
)));
const modePolicy = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/mode-policy.mjs",
)));
const contextConfig = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/rubato-features/context-notes/src/context-notes/config.mjs",
)));

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  if (previousMode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = previousMode;
  if (previousOrigin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = previousOrigin;
  contextConfig.resetContextModeResolution();
  rmSync(scratch, { recursive: true, force: true });
});

function usage() {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function withMode(t, { mode, origin } = {}) {
  contextConfig.resetContextModeResolution();
  if (mode === undefined) delete process.env.RUBATO_CONTEXT_MODE;
  else process.env.RUBATO_CONTEXT_MODE = mode;
  if (origin === undefined) delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
  else process.env.RUBATO_CONTEXT_MODE_ORIGIN = origin;
  t.after(() => {
    delete process.env.RUBATO_CONTEXT_MODE;
    delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
    contextConfig.resetContextModeResolution();
  });
}

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function writeNotesSession(name) {
  const cwd = join(scratch, name + "-cwd");
  const sessionDir = join(scratch, name + "-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const manager = sdk.SessionManager.create(cwd, sessionDir);
  const window0 = protocol.initialWindow();
  manager.appendCustomEntry(protocol.INIT_ENTRY, { window: window0 });
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "keep this session as a notes window" }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "noted" }],
    api: "openai-completions",
    provider: "notes-session-open-test",
    model: "fake-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const window1 = protocol.nextWindow(window0);
  manager.appendCompaction(
    protocol.encodeBootstrap(window1, "handoff.md"),
    manager.getLeafId(),
    24,
    { source: protocol.SOURCE, window: window1 },
  );
  return { cwd, sessionDir, sourcePath: manager.getSessionFile() };
}

function copySession(sourcePath, name) {
  const sessionDir = join(scratch, name + "-copies");
  mkdirSync(sessionDir, { recursive: true });
  const copyPath = join(sessionDir, name + ".jsonl");
  copyFileSync(sourcePath, copyPath);
  return { sessionDir, copyPath };
}

const source = writeNotesSession("notes-source");

test("copied notes-window session throws NOTES_RESUME_IN_SUMMARY when opened with user-explicit summary", (t) => {
  withMode(t, { mode: "summary" });
  const { copyPath, sessionDir } = copySession(source.sourcePath, "open-summary");
  const opened = sdk.SessionManager.open(copyPath, sessionDir, source.cwd);
  assert.throws(
    () => opened.buildSessionContext(),
    { message: modePolicy.NOTES_RESUME_IN_SUMMARY },
  );
});

test("copied notes-window session opens without NOTES_RESUME_IN_SUMMARY when env is unset", (t) => {
  withMode(t);
  const { copyPath, sessionDir } = copySession(source.sourcePath, "open-default");
  const opened = sdk.SessionManager.open(copyPath, sessionDir, source.cwd);
  const context = opened.buildSessionContext();
  assert.ok(context.messages.some((message) => textOf(message).startsWith(protocol.BOOTSTRAP_PREFIX)));
});
