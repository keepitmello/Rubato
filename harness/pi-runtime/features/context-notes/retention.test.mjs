import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPiFeatures } from "../../feature-catalog.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";

// 문맥 기록(SQLite)은 세션 원본을 옮겨 둔 사본이라 버려도 된다. 그래서 대화 없이 끝난 세션은
// 기록을 남기지 않고, 14일 동안 쓰이지 않은 기록은 Rubato 가 뜰 때 지운다. 지금 열린 세션의
// 기록은 날짜와 상관없이 남기고, 지운 기록은 세션을 다시 열면 원본에서 되살아난다.

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-context-notes-retention-"));
const previousOffline = process.env.PI_OFFLINE;
process.env.PI_OFFLINE = "1";

const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot: join(scratch, "engine"),
  features: [...await loadPiFeatures(["context-notes"])],
});
const runtime = resolvePiRuntime({ root: staged.root });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(
  runtime.codingAgentDir, "node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")));
const { createContextNotesExtension } = await import(pathToFileURL(join(
  runtime.codingAgentDir, "dist/rubato-features/context-notes/extension.mjs")));
const { ContextNotesStore, databasePath } = await import(pathToFileURL(join(
  runtime.codingAgentDir, "dist/rubato-features/context-notes/src/context-notes/store.mjs")));

after(() => {
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
  rmSync(scratch, { recursive: true, force: true });
});

const model = {
  provider: "retention-test", id: "fake-model", name: "fake", api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function reply(text) {
  const message = { role: "assistant", content: [{ type: "text", text }], api: model.api,
    provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const out = new AssistantMessageEventStream();
  out.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  out.push({ type: "done", reason: "stop", message });
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

async function open({ cwd, agentDir, sessionManager }) {
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
  session.agent.streamFunction = () => reply("done");
  const tool = async (name, params) => {
    session.setActiveToolsByName([name]);
    const found = session.agent.state.tools.find((entry) => entry.name === name);
    assert.ok(found, `${name} is registered`);
    return JSON.parse((await found.execute(`${name}-call`, params, new AbortController().signal)).content[0].text);
  };
  const close = async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  };
  return { session, errors, tool, close };
}

const archives = (agentDir) => {
  const directory = join(agentDir, "context-notes");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".sqlite")) : [];
};
const files = (path) => [path, `${path}-wal`, `${path}-shm`];
const backdate = (path, days) => {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  for (const file of files(path)) if (existsSync(file)) utimesSync(file, at, at);
};

test("a session that ends without a conversation leaves no archive behind", async () => {
  const ws = workspace("empty");
  const empty = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) });
  assert.deepEqual(empty.errors, []);
  assert.equal(archives(ws.agentDir).length, 1, "the open session has its archive");
  await empty.close();
  assert.deepEqual(readdirSync(join(ws.agentDir, "context-notes")), [], "no .sqlite, -wal or -shm left");

  // 대화가 있던 세션의 기록은 그대로 남는다.
  const used = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) });
  await used.session.prompt("keep this conversation");
  await used.close();
  assert.deepEqual(used.errors, []);
  assert.equal(archives(ws.agentDir).length, 1);
});

test("startup removes archives unused for 14 days, but keeps recent ones and those of open sessions", async (t) => {
  const ws = workspace("sweep");
  const seed = (sessionId, days) => {
    const path = databasePath(ws.agentDir, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(id TEXT); INSERT INTO items VALUES ('x');");
    db.close();
    backdate(path, days);
    return path;
  };
  const stale = seed("stale-session", 15);
  const recent = seed("recent-session", 13);

  // 같은 프로세스에 열린 세션(호스팅 서버)과 다른 프로세스에 열린 세션(다른 Rubato 실행).
  const openHere = databasePath(ws.agentDir, "open-in-this-process");
  const store = new ContextNotesStore(openHere);
  t.after(() => store.close());
  store.db.exec("INSERT INTO items VALUES ('x', 'w', 0, 'user', 'message', NULL, 'kept', '{}', '')");
  backdate(openHere, 30);
  const openElsewhere = databasePath(ws.agentDir, "open-in-another-process");
  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(openElsewhere)});
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items(id TEXT); INSERT INTO items VALUES ('x');");
    process.stdout.write("ready\\n");
    process.stdin.resume();`], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => holder.kill());
  await new Promise((ready) => holder.stdout.once("data", ready));
  backdate(openElsewhere, 30);

  const started = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) });
  await started.close();
  assert.deepEqual(started.errors, []);
  for (const file of files(stale)) assert.equal(existsSync(file), false, `${file} is removed`);
  assert.equal(existsSync(recent), true, "a 13-day-old archive stays");
  assert.equal(existsSync(openHere), true, "an open session's archive stays even when its files look old");
  assert.equal(existsSync(openElsewhere), true, "another process's open archive stays");
  // 남긴 기록은 그 세션이 계속 쓸 수 있다.
  store.db.exec("INSERT INTO items VALUES ('y', 'w', 1, 'user', 'message', NULL, 'still', '{}', '')");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM items").get().n, 2);
});

test("a session whose archive was removed rebuilds history search and notes from its transcript", async () => {
  const ws = workspace("rebuild");
  const first = await open({ ...ws, sessionManager: sdk.SessionManager.create(ws.cwd, ws.sessionDir) });
  let file, sessionId;
  try {
    await first.session.prompt("the original request mentions needle-7c1f");
    assert.equal((await first.tool("notes_write_file", { path: "now.md", text: "resume from needle-7c1f" })).path, "now.md");
    file = first.session.sessionManager.getSessionFile();
    sessionId = first.session.sessionManager.getSessionId();
  } finally { await first.close(); }
  assert.deepEqual(first.errors, []);
  const archive = databasePath(ws.agentDir, sessionId);
  assert.equal(existsSync(archive), true);
  for (const path of files(archive)) rmSync(path, { force: true });

  const second = await open({ ...ws, sessionManager: sdk.SessionManager.open(file, ws.sessionDir) });
  try {
    const found = await second.tool("history_search_contents", { query: "needle-7c1f", role: "user" });
    assert.equal(found.items.length, 1);
    assert.match(found.items[0].truncated_content, /the original request mentions needle-7c1f/);
    assert.equal((await second.tool("notes_read_file", { path: "now.md" })).text, "resume from needle-7c1f");
    assert.equal((await second.tool("history_list_windows", {})).windows.length, 1);
  } finally { await second.close(); }
  assert.deepEqual(second.errors, []);
  assert.equal(existsSync(archive), true, "the rebuilt archive is kept");
});
