import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MAX_SESSION_PAGE_SIZE } from "../session-catalog/catalog.mjs";
import { applyFeatureToggles, readDisabledFeatures } from "../rubato-components/feature-toggles.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { filterHistory } from "./history-search/filter.mjs";
import { indexHistoryFromCatalog, iterateHistoryCatalogPages } from "./history-search/catalog-index.mjs";
import { collectSessionFiles, extractPatchedPaths } from "./files/index.mjs";
import { createUserCommandSessionFactories, USER_COMMAND_SESSION_FACTORY_NAMES } from "./index.mjs";
import { feature } from "./feature.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const runtime = resolvePiRuntime({ root: sourceRoot });
const sdk = await import(pathToFileURL(runtime.sdkEntry));
const scratch = mkdtempSync(join(tmpdir(), "rubato-user-commands-session-"));
const previousEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_OFFLINE: process.env.PI_OFFLINE,
};
process.env.HOME = join(scratch, "home");
process.env.PI_OFFLINE = "1";
mkdirSync(process.env.HOME, { recursive: true });

after(() => {
  if (previousEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = previousEnv.HOME;
  if (previousEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousEnv.PI_CODING_AGENT_DIR;
  if (previousEnv.PI_OFFLINE === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousEnv.PI_OFFLINE;
  rmSync(scratch, { recursive: true, force: true });
});

function fakeTheme() {
  return {
    fg: (_name, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
  };
}

function commandNames(session) {
  return session.extensionRunner.getRegisteredCommands().map((command) => command.name).sort();
}

function sessionJsonl({ id, cwd, text, timestamp }) {
  return [
    JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date(timestamp).toISOString() }),
    JSON.stringify({
      type: "message",
      id: "entry-" + id,
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: { role: "user", content: [{ type: "text", text }], timestamp },
    }),
  ].join("\n") + "\n";
}

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Rubato test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Rubato test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function waitUntil(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

async function startSession({ name, factories, sessionDir, cwd }) {
  const project = cwd ?? join(scratch, name + "-project");
  const agentDir = join(scratch, name + "-agent");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = sdk.SettingsManager.create(project, agentDir);
  const keybindings = KeybindingsManager.create(agentDir);
  const notices = [];
  const rendered = [];
  let editorText = "";
  const tui = { requestRender() {}, terminal: { rows: 120, cols: 100 }, fullRedraws: 7 };
  const theme = fakeTheme();
  const uiContext = {
    notify(message, type) { notices.push({ message, type }); },
    setEditorText(text) { editorText = text; },
    getEditorText() { return editorText; },
    async custom(factory, options) {
      const component = await factory(tui, theme, keybindings, (value) => { uiContext._done?.(value); });
      const text = typeof component?.render === "function" ? component.render(80).join("\n") : "";
      rendered.push({ options, text, component });
      return await new Promise((resolve) => {
        uiContext._done = resolve;
        resolve(undefined);
      });
    },
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: factories,
  });
  await loader.reload();
  const created = await sdk.createAgentSession({
    cwd: project,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: sessionDir ? sdk.SessionManager.create(project, sessionDir) : sdk.SessionManager.inMemory(project),
    noTools: "all",
  });
  const errors = [];
  await created.session.bindExtensions({
    mode: "tui",
    uiContext,
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(created.extensionsResult.errors, []);
  assert.deepEqual(errors, []);
  return {
    ...created,
    project,
    agentDir,
    notices,
    rendered,
    get editorText() { return editorText; },
    tui,
    uiContext,
    async close() { created.session.dispose(); },
  };
}

test("feature manifest copies runtime files and names five toggleable factories", () => {
  assert.equal(feature.id, "user-commands-session");
  assert.equal(feature.patches.length, 0);
  assert.ok(feature.files.some((file) => file.path.endsWith("history-search/catalog-index.mjs")));
  assert.deepEqual([...USER_COMMAND_SESSION_FACTORY_NAMES], [
    "rubato-history-search", "rubato-help", "rubato-diff", "rubato-files", "rubato-redraws",
  ]);
});

test("filterHistory keeps recency order for an empty query and fuzzy-matches text", () => {
  const entries = [
    { text: "alpha prompt", timestamp: 2 },
    { text: "beta needle", timestamp: 1 },
  ];
  assert.deepEqual(filterHistory(entries, " ").map((entry) => entry.text), ["alpha prompt", "beta needle"]);
  assert.deepEqual(filterHistory(entries, "needle").map((entry) => entry.text), ["beta needle"]);
});

test("extractPatchedPaths and collectSessionFiles follow the product file list", () => {
  const paths = extractPatchedPaths("*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch\n");
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  const files = collectSessionFiles([
    { type: "message", message: { role: "assistant", timestamp: 1, content: [
      { type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } },
    ] } },
    { type: "message", message: { role: "toolResult", toolCallId: "r1", timestamp: 2, content: [] } },
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].operations.has("read"), true);
});


test("stock AgentSession registers the five commands, renders them, and drops a disabled factory", async (t) => {
  const fixture = await startSession({ name: "all-commands", factories: createUserCommandSessionFactories() });
  t.after(() => fixture.close());
  assert.deepEqual(commandNames(fixture.session), ["diff", "files", "help", "history", "tui"]);

  await fixture.session.prompt("/help");
  const helpText = fixture.rendered.at(-1).text;
  assert.match(helpText, /Getting started/);
  assert.match(helpText, /Keybindings/);
  assert.match(helpText, /Type \/ for commands/);
  await fixture.session.prompt("/tui");
  assert.equal(fixture.notices.some((notice) => notice.message === "TUI full redraws: 7"), true);

  const agentDir = join(scratch, "disabled-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "rubato-features.json"), JSON.stringify({ disabled: ["rubato-help", "rubato-missing"] }));
  const toggled = applyFeatureToggles(
    createUserCommandSessionFactories(),
    readDisabledFeatures({ agentDir, env: {} }),
  );
  assert.deepEqual(toggled.disabled, ["rubato-help"]);
  assert.deepEqual(toggled.unknown, ["rubato-missing"]);
  const disabled = await startSession({ name: "disabled-help", factories: toggled.extensionFactories });
  t.after(() => disabled.close());
  assert.equal(commandNames(disabled.session).includes("help"), false);
  assert.deepEqual(commandNames(disabled.session), ["diff", "files", "history", "tui"]);
});

test("/history pages the session catalog to Senpi recall and finds the oldest prompt", async (t) => {
  const sessionDir = join(scratch, "history-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const newest = Date.now();
  const count = MAX_SESSION_PAGE_SIZE + 1;
  const oldestText = "oldest-prompt-should-render";
  for (let index = 0; index < count; index++) {
    const timestamp = newest - index * 1000;
    const id = "sess-" + String(index).padStart(3, "0");
    const path = join(sessionDir, id + ".jsonl");
    const text = index === count - 1 ? oldestText : "history-prompt-" + String(index).padStart(3, "0");
    writeFileSync(path, sessionJsonl({ id, cwd: "/tmp/history-project", text, timestamp }));
    utimesSync(path, timestamp / 1000, timestamp / 1000);
  }
  const started = performance.now();
  let firstPageMs;
  let indexed = [];
  for await (const batch of iterateHistoryCatalogPages({ root: sessionDir, includeSubdirectories: false })) {
    if (firstPageMs === undefined) firstPageMs = performance.now() - started;
    indexed = batch.entries;
  }
  const fullIndexMs = performance.now() - started;
  t.diagnostic("history N=" + count + " firstPage=" + firstPageMs.toFixed(1) + "ms fullIndex=" + fullIndexMs.toFixed(1) + "ms");
  const all = await indexHistoryFromCatalog({ root: sessionDir, includeSubdirectories: false });
  assert.equal(all.some((entry) => entry.text === oldestText), true);
  assert.equal(all.some((entry) => entry.text === "history-prompt-000"), true);
  assert.equal(indexed.some((entry) => entry.text === oldestText), true);

  process.env.PI_CODING_AGENT_DIR = join(scratch, "history-agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const fixture = await startSession({
    name: "history",
    factories: createUserCommandSessionFactories(),
    sessionDir,
  });
  t.after(() => fixture.close());
  await fixture.session.prompt("/history");
  const overlay = fixture.rendered.at(-1).component;
  assert.match(fixture.rendered.at(-1).text, /Search prompt history/);
  assert.match(fixture.rendered.at(-1).text, /history-prompt-000/);
  await waitUntil(() => overlay.getFilteredEntries().some((entry) => entry.text === oldestText), "oldest prompt indexed into overlay");
  overlay.searchInput.setValue(oldestText);
  overlay.rebuild();
  assert.match(overlay.render(80).join("\n"), /oldest-prompt-should-render/);
});
test("/diff and /files render lists and launch VS Code through a spawn mock", async (t) => {
  const cwd = join(scratch, "git-project");
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.name", "Rubato test"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(cwd, "tracked.txt"), "one\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-m", "init"]);
  writeFileSync(join(cwd, "tracked.txt"), "two\n");
  writeFileSync(join(cwd, "fresh.txt"), "untracked\n");

  const launches = [];
  const exec = (command, args, options, pi) => {
    if (command === "code" || command === "cmd" || (command === "git" && args[0] === "difftool")) {
      launches.push({ command, args, cwd: options?.cwd });
      return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
    }
    return pi.exec(command, args, options);
  };
  const fixture = await startSession({
    name: "diff-files",
    cwd,
    factories: createUserCommandSessionFactories({ exec }),
  });
  t.after(() => fixture.close());

  await fixture.session.prompt("/diff");
  assert.match(fixture.rendered.at(-1).text, /Select file to diff/);
  assert.match(fixture.rendered.at(-1).text, /tracked.txt/);
  const diffList = fixture.rendered.at(-1).component;
  diffList.handleInput?.("\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(launches.length > 0, true);
  assert.equal(launches.every((launch) => launch.command !== "code" || launch.args.includes("-g")), true);
  assert.equal(launches.some((launch) => launch.command === "git" && launch.args[0] === "difftool"), true);

  fixture.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "tracked.txt" } }],
    timestamp: Date.now(),
  });
  fixture.session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    timestamp: Date.now() + 1,
  });
  await fixture.session.prompt("/files");
  assert.match(fixture.rendered.at(-1).text, /Select file to open/);
  assert.match(fixture.rendered.at(-1).text, /tracked.txt/);
  const filesList = fixture.rendered.at(-1).component;
  filesList.handleInput?.("\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(launches.some((launch) => launch.command === "code" && launch.args.includes("tracked.txt")), true);
});
