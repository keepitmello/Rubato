import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

// When the manager cannot start (here: the archive and the transcript disagree about an
// entry), every request is refused before the provider. The refusal is what the user sees
// in the transcript, so it must name that cause, and fixing the cause must be enough.

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-context-notes-start-failure-"));
const previous = { mode: process.env.RUBATO_CONTEXT_MODE, origin: process.env.RUBATO_CONTEXT_MODE_ORIGIN,
  offline: process.env.PI_OFFLINE };
process.env.RUBATO_CONTEXT_MODE = "history-notes";
delete process.env.RUBATO_CONTEXT_MODE_ORIGIN;
process.env.PI_OFFLINE = "1";

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...await loadPiFeatures(["input-lifecycle", "abort-provenance", "request-run", "context-window"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(runtime.packages["@earendil-works/pi-ai"].dir, "dist/utils/event-stream.js")));
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir, "dist/rubato-features/context-notes/extension.mjs")));

after(() => {
  for (const [key, value] of [["RUBATO_CONTEXT_MODE", previous.mode],
    ["RUBATO_CONTEXT_MODE_ORIGIN", previous.origin], ["PI_OFFLINE", previous.offline]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const model = {
  provider: "start-failure-test", id: "fake-model", name: "fake", api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const settle = () => new Promise((done) => setTimeout(done, 300));

function assistant(text, stopReason = "stop", input = 1, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
    provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra };
}

function stream(message) {
  const out = new AssistantMessageEventStream();
  out.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  out.push({ type: "done", reason: message.stopReason, message });
  return out;
}
function workspace(name) {
  const cwd = join(scratch, name);
  const agentDir = join(cwd, "agent");
  const sessionDir = join(cwd, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [model.provider]: {
    baseUrl: model.baseUrl, api: model.api, apiKey: "unused",
    models: [{ id: model.id, input: ["text"], contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } } }));
  return { cwd, agentDir, sessionDir };
}

async function open({ cwd, agentDir, sessionManager }, script) {
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "context-notes", factory: createContextNotesExtension({ agentDir, enabled: true }) }],
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager, model });
  const errors = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { notify(message, level) { if (level === "error") errors.push(message); }, setStatus() {}, confirm: async () => false },
    onError: (error) => errors.push(error?.error ?? String(error)),
  });
  let calls = 0;
  session.agent.streamFunction = (_model, _context, options) => {
    const out = script(calls++, options, session);
    return out instanceof AssistantMessageEventStream ? out : stream(out);
  };
  const close = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  };
  return { session, errors, calls: () => calls, close };
}

const archive = (agentDir, sessionId) =>
  join(agentDir, "context-notes", `${createHash("sha256").update(sessionId).digest("hex")}.sqlite`);
const lastAssistant = (session) => session.sessionManager.getBranch()
  .findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.message;

test("a refused request names why the notes manager could not start, and recovers once the cause is fixed", async () => {
  const ws = workspace("diverged");
  const first = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) }, (i) => assistant(`turn ${i}`));
  let file, sessionId, userId;
  try {
    await first.session.prompt("hello"); await settle();
    file = first.session.sessionManager.getSessionFile();
    sessionId = first.session.sessionManager.getSessionId();
    userId = first.session.sessionManager.getBranch().find((entry) => entry.message?.role === "user").id;
  } finally { await first.close(); }

  const db = new DatabaseSync(archive(ws.agentDir, sessionId));
  const { raw } = db.prepare("SELECT raw FROM items WHERE id=?").get(userId);
  db.prepare("UPDATE items SET raw=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(raw), parentId: "never-written" }), userId);

  const second = await open({ ...ws, sessionManager: sdk.SessionManager.open(file, ws.sessionDir) }, (i) => assistant(`again ${i}`));
  try {
    await second.session.prompt("continue"); await settle();
    assert.equal(second.calls(), 0, "the provider is never reached");
    const refused = lastAssistant(second.session);
    assert.match(refused.errorMessage, /준비되지 않았어요/);
    assert.ok(refused.errorMessage.includes(`기록 항목 ${userId}의 원문이 변경됐어요`),
      `the refusal carries the start failure: ${refused.errorMessage}`);

    db.prepare("UPDATE items SET raw=? WHERE id=?").run(raw, userId);
    await second.session.prompt("after repair"); await settle();
    assert.equal(second.calls(), 1, "the same runtime starts its manager on the next message");
    assert.equal(lastAssistant(second.session).stopReason, "stop");
  } finally { db.close(); await second.close(); }
});
