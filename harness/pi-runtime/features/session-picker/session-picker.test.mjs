import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTerminalSession } from "@code-yeongyu/senpi-pty";
import { loadPiFeatures, PI_FEATURE_NAMES } from "../../feature-catalog.mjs";
import { CANDIDATE_FEATURE_NAMES } from "../rubato-components/candidate-main.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import {
  SESSION_PICKER_PAGE_SIZE,
  SESSION_PICKER_SCAN_PAGE_SIZE,
  SessionPickerPager,
} from "./pager.mjs";
import { feature, files, patches } from "./patches.mjs";

const featureDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(featureDir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "rubato-pi-session-picker-"));
const outputRoot = join(scratch, "engine");

after(() => rmSync(scratch, { recursive: true, force: true }));

function withoutNodeOptions(env, extra = {}) {
  const copy = { ...env, ...extra };
  delete copy.NODE_OPTIONS;
  delete copy.NODE_COMPILE_CACHE;
  return copy;
}

function sessionJsonl({ id, cwd, text, timestamp, name, parentSession }) {
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      cwd,
      timestamp: new Date(timestamp).toISOString(),
      ...(parentSession ? { parentSession } : {}),
    },
    {
      type: "message",
      id: `entry-${id}`,
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp,
      },
    },
  ];
  if (name) {
    entries.push({
      type: "session_info",
      id: `name-${id}`,
      parentId: `entry-${id}`,
      timestamp: new Date(timestamp + 1).toISOString(),
      name,
    });
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function createSessions(directory, cwd, count = 36) {
  mkdirSync(directory, { recursive: true });
  const base = Date.now() - count * 10_000;
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const id = `picker-${String(index).padStart(3, "0")}`;
    const timestamp = base + index * 10_000;
    const text = index === 2 ? "deep-search-needle" : `picker-message-${String(index).padStart(3, "0")}`;
    const path = join(directory, `${id}.jsonl`);
    const parentSession = index === 26 ? join(directory, "picker-023.jsonl") : undefined;
    writeFileSync(path, sessionJsonl({ id, cwd, text, timestamp, parentSession }));
    utimesSync(path, timestamp / 1_000, timestamp / 1_000);
    records.push({ id, index, path, text });
  }
  return records;
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    }
    catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function visible(component, width = 100) {
  return stripVTControlCharacters(component.render(width).join("\n"));
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const dependencies = await loadPiFeatures([
  "reload",
  "service-tier",
  "input-lifecycle",
  "abort-provenance",
  "extension-rpc",
  "request-run",
  "session-catalog",
  "providers",
  "runtime-factories",
  "context-window",
]);
const staged = await stagePiRuntime({
  sourceRoot,
  outputRoot,
  features: [...dependencies, feature],
});
const runtime = resolvePiRuntime({ root: staged.root });
const { SessionManager } = await import(pathToFileURL(runtime.sdkEntry));
const { initTheme } = await import(pathToFileURL(runtime.sdkEntry));
initTheme("dark");
const { SessionSelectorComponent } = await import(pathToFileURL(join(
  runtime.codingAgentDir,
  "dist/modes/interactive/components/session-selector.js",
)));

test("descriptor is stock-locked, drift-failing, and composes at shared main/UI targets", async () => {
  assert.equal(feature.id, "session-picker");
  assert.equal(PI_FEATURE_NAMES.includes("session-picker"), true);
  assert.equal(CANDIDATE_FEATURE_NAMES.includes("session-picker"), true);
  assert.deepEqual((await loadPiFeatures(["session-picker"])).map((entry) => entry.id), [
    "session-catalog",
    "session-picker",
  ]);
  assert.equal(SESSION_PICKER_PAGE_SIZE, 12);
  assert.equal(SESSION_PICKER_SCAN_PAGE_SIZE, 200);
  assert.deepEqual(files.map((entry) => entry.path), [
    "dist/rubato-features/session-picker/pager.mjs",
  ]);
  assert.equal(patches.length, 6);
  assert.equal(new Set(patches.map((entry) => entry.path)).size, patches.length);
  assert.ok(patches.every((entry) => entry.packageName === "@earendil-works/pi-coding-agent"));
  assert.ok(patches.every((entry) => entry.version === "0.85.1"));
  assert.ok(patches.every((entry) => /^[a-f0-9]{64}$/.test(entry.preimageSha256)));

  const receiptEntries = staged.receipt.files.filter((entry) =>
    entry.patches.some((id) => id.startsWith("session-picker/")));
  assert.equal(receiptEntries.length, patches.length);
  assert.deepEqual(
    receiptEntries.find((entry) => entry.path.endsWith("dist/main.js")).patches,
    ["runtime-factories/dist/main.js", "session-picker/session-picker:dist/main.js"],
  );
  assert.deepEqual(
    receiptEntries.find((entry) => entry.path.endsWith("dist/modes/interactive/interactive-mode.js")).patches,
    [
      "reload/reload-veto:dist/modes/interactive/interactive-mode.js",
      "session-picker/session-picker:dist/modes/interactive/interactive-mode.js",
    ],
  );

  for (const entry of receiptEntries.filter((item) => item.path.endsWith(".js"))) {
    const syntax = spawnSync(process.execPath, ["--check", join(staged.root, entry.path)], {
      encoding: "utf8",
      env: withoutNodeOptions(process.env),
    });
    assert.equal(syntax.status, 0, `${entry.path}: ${syntax.stderr}`);
  }

  const stockSelector = readFileSync(join(
    sourceRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js",
  ), "utf8");
  assert.throws(
    () => patches.find((entry) => entry.path.endsWith("session-selector.js")).apply(
      stockSelector.replace("allLoadSeq = 0;", "allLoadSeq = 1;"),
    ),
    /expected anchor is missing/,
  );
});

test("pager advances a header-valid but unreadable slot instead of looping", () => {
  const pager = new SessionPickerPager();
  const generation = pager.reset();
  const request = pager.request();
  const sessions = pager.apply({ sessions: [], total: 30, offset: 0, hasMore: true }, [], { request });
  assert.deepEqual(sessions, []);
  assert.equal(pager.offset, 12);
  assert.equal(pager.hasMore, true);
  assert.equal(pager.beginMore(), generation);
  pager.finishMore(generation);
  assert.equal(pager.loadingMore, false);
});

test("actual selector renders newest first, pages near the tail, searches all pages, and selects an exact path", async () => {
  const cwd = join(scratch, "component-project");
  const sessionDir = join(scratch, "component-sessions");
  mkdirSync(cwd, { recursive: true });
  const records = createSessions(sessionDir, cwd);
  const currentCalls = [];
  let selectedPath;
  let cancelled = 0;
  const currentLoader = (onProgress, page) => {
    currentCalls.push(page);
    return page
      ? SessionManager.listPage(cwd, sessionDir, onProgress, page)
      : SessionManager.list(cwd, sessionDir, onProgress);
  };
  const allLoader = (onProgress, page) => page
    ? SessionManager.listAllPage(sessionDir, onProgress, page)
    : SessionManager.listAll(sessionDir, onProgress);
  const selector = new SessionSelectorComponent(
    currentLoader,
    allLoader,
    (path) => { selectedPath = path; },
    () => { cancelled += 1; },
    () => {},
    () => {},
    { showRenameHint: false },
  );
  const list = selector.getSessionList();

  await waitFor(() => visible(selector).includes("picker-message-035"), "initial rendered page");
  const firstFrame = visible(selector);
  assert.match(firstFrame, /picker-message-035/);
  assert.match(firstFrame, /\(1\/12\)/);
  assert.doesNotMatch(firstFrame, /picker-message-023/);
  assert.deepEqual(currentCalls[0], { offset: 0, limit: 12 });

  for (let index = 0; index < 9; index += 1) list.handleInput("\x1b[B");
  await waitFor(() => currentCalls.some((page) => page?.offset === 12), "second page request");
  await waitFor(() => visible(selector).includes("picker-message-023"), "second rendered page");
  assert.deepEqual(currentCalls.find((page) => page?.offset === 12), { offset: 12, limit: 12 });
  list.handleInput("\r");
  assert.equal(selectedPath, records[26].path, "page append preserves the selected path across tree reordering");
  selectedPath = undefined;

  for (const character of "deep-search-needle") list.handleInput(character);
  await waitFor(
    () => list.getSelectedSessionPath() === records[2].path,
    "deep search result selected from catalog pages",
  );
  assert.ok(currentCalls.some((page) => page?.offset === 24 && page?.limit === 200), JSON.stringify(currentCalls));
  assert.match(visible(selector), /deep-search-needle/);
  list.handleInput("\r");
  assert.equal(selectedPath, records[2].path, "selection returns the catalog path, not a display label");

  const cancellingSelector = new SessionSelectorComponent(
    currentLoader,
    allLoader,
    () => assert.fail("cancel must not select"),
    () => { cancelled += 1; },
    () => {},
    () => {},
    { showRenameHint: false },
  );
  await waitFor(() => visible(cancellingSelector).includes("picker-message-035"), "cancel selector page");
  cancellingSelector.getSessionList().handleInput("\x1b");
  assert.equal(cancelled, 1);
});

test("native PTY /resume searches beyond the first page and rebinds the live session", async (t) => {
  const cwd = join(scratch, "pty-project");
  const agentDir = join(scratch, "pty-agent");
  const sessionDir = join(scratch, "pty-sessions");
  const probeLog = join(scratch, "pty-session-start.jsonl");
  const probeExtension = join(scratch, "pty-probe.mjs");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const canonicalCwd = realpathSync(cwd);
  const records = createSessions(sessionDir, canonicalCwd);
  writeFileSync(probeExtension, `
import { appendFileSync } from "node:fs";
export default function sessionPickerProbe(pi) {
  pi.on("session_start", (event, ctx) => {
    appendFileSync(process.env.SESSION_PICKER_PROBE_LOG, JSON.stringify({
      reason: event.reason,
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
    }) + "\\n");
  });
}
`);

  const session = createTerminalSession({
    command: process.execPath,
    args: [
      runtime.patchableCliEntry,
      "--session-dir",
      sessionDir,
      "--offline",
      "--approve",
      "--no-skills",
      "--no-context-files",
      "--no-themes",
      "--no-extensions",
      "--extension",
      probeExtension,
    ],
    cwd: canonicalCwd,
    env: withoutNodeOptions(process.env, {
      PI_CODING_AGENT_DIR: agentDir,
      RUBATO_CONTEXT_MODE: "summary",
      SESSION_PICKER_PROBE_LOG: probeLog,
      TERM: "xterm-256color",
      FORCE_COLOR: "0",
    }),
    cols: 120,
    rows: 40,
    timeoutMs: 45_000,
  });
  assert.equal(
    session.backend,
    "native",
    session.unavailableDiagnostic?.cause ?? JSON.stringify(session.native?.diagnostic ?? session.unavailableDiagnostic),
  );
  let output = "";
  let exited = false;
  session.onData((chunk) => { output += chunk.toString("utf8"); });
  session.onExit(() => { exited = true; });
  const stopOwnedProcess = () => {
    if (session.status === "exited") return;
    session.kill("SIGTERM");
  };
  t.after(async () => {
    stopOwnedProcess();
    await Promise.race([
      session.waitExit().catch(() => undefined),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (session.status !== "exited") session.kill("SIGKILL");
  });

  await waitFor(() => {
    if (exited) throw new Error(stripVTControlCharacters(output).slice(-2_000));
    return readJsonLines(probeLog).some((entry) => entry.reason === "startup");
  }, "initial TUI session", 20_000);
  assert.equal(session.write("/resume\r").ok, true);
  await waitFor(
    () => stripVTControlCharacters(output).includes("Resume Session (Current Folder)"),
    "rendered /resume selector",
    20_000,
  );
  await waitFor(
    () => stripVTControlCharacters(output).includes("picker-message-035"),
    "newest page rendered before search",
    20_000,
  );
  assert.doesNotMatch(stripVTControlCharacters(output), /deep-search-needle/);

  for (const character of "deep-search-needle") {
    assert.equal(session.write(character).ok, true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  }
  await waitFor(
    () => /›\s*deep-search-needle/.test(stripVTControlCharacters(output)),
    "old session rendered after search",
    20_000,
  );
  assert.equal(session.write("\r").ok, true);
  const resumed = await waitFor(
    () => readJsonLines(probeLog).find((entry) => entry.reason === "resume"),
    "resumed session_start",
    20_000,
  );
  assert.equal(resumed.id, records[2].id);
  assert.equal(resumed.file, records[2].path);

  assert.equal(session.write("/quit\r").ok, true);
  await Promise.race([
    session.waitExit(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `native PTY did not exit; output=${stripVTControlCharacters(output).slice(-2_000)}`,
    )), 10_000)),
  ]);
  assert.equal(exited, true);
});
