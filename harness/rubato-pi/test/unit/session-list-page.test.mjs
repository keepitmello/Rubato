import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { pathsNewestFirst, SESSION_LIST_PAGE_SIZE, sliceNewestPage } from "../../src/session-list-page.mjs";
import { applyCoreSessionTransforms } from "../../src/transforms/core-session.mjs";
import {
  injectInteractiveSessionListPage,
  injectMainSessionListPage,
  injectSessionDiscoveryPage,
  injectSessionManagerPage,
  injectSessionSelectorPage,
  isBootMainSessionListUrl,
  isInteractiveModeSessionListUrl,
  isSessionDiscoveryUrl,
  isSessionSelectorUrl,
} from "../../src/transforms/core-session-list-page.mjs";
import { isSessionManagerUrl } from "../../src/transforms/core-session-persist.mjs";

function applyNoThrow(url, source) {
  const warnings = [];
  const next = applyCoreSessionTransforms(url, source, (text, transform) => {
    try {
      const out = transform(text);
      return typeof out === "string" ? out : text;
    } catch (error) {
      warnings.push(error.message);
      return text;
    }
  });
  return { next, warnings };
}

function sessionJsonl(id, cwd, text, timestamp) {
  return [
    JSON.stringify({ type: "session", id, cwd, timestamp: new Date(timestamp).toISOString() }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }], timestamp },
    }),
  ].join("\n") + "\n";
}

test("newest-first helpers cut from the latest files", () => {
  const paths = pathsNewestFirst([
    { filePath: "old.jsonl", mtimeMs: 1 },
    { filePath: "new.jsonl", mtimeMs: 3 },
    { filePath: "mid.jsonl", mtimeMs: 2 },
    null,
  ]);
  assert.deepEqual(paths, ["new.jsonl", "mid.jsonl", "old.jsonl"]);
  const page = sliceNewestPage(paths, 0, 2);
  assert.deepEqual(page.page, ["new.jsonl", "mid.jsonl"]);
  assert.equal(page.total, 3);
  assert.equal(page.hasMore, true);
  const rest = sliceNewestPage(paths, 2, 2);
  assert.deepEqual(rest.page, ["old.jsonl"]);
  assert.equal(rest.hasMore, false);
  assert.equal(SESSION_LIST_PAGE_SIZE, 12);
});

test("session list page transforms apply to pinned senpi without drift", () => {
  const discoveryPath = join(senpiDir, "dist/core/session-discovery.js");
  const managerPath = join(senpiDir, "dist/core/session-manager.js");
  const selectorPath = join(senpiDir, "dist/modes/interactive/components/session-selector.js");
  const interactivePath = join(senpiDir, "dist/modes/interactive/interactive-mode.js");
  const mainPath = join(senpiDir, "dist/main.js");

  const discovery = injectSessionDiscoveryPage(readFileSync(discoveryPath, "utf8"));
  assert.match(discovery, /export async function listSessionsPage/);
  assert.match(discovery, /sortFilesNewestFirst/);
  assert.throws(() => injectSessionDiscoveryPage(discovery));

  const manager = injectSessionManagerPage(readFileSync(managerPath, "utf8"));
  assert.match(manager, /static async listPage/);
  assert.match(manager, /static async listAllPage/);
  assert.throws(() => injectSessionManagerPage(manager));

  const selector = injectSessionSelectorPage(readFileSync(selectorPath, "utf8"));
  assert.match(selector, /maybeRequestMore/);
  assert.match(selector, /async loadMore\(scope, remaining\)/);
  assert.match(selector, /limit: this\.pageSize\(\)/);
  assert.throws(() => injectSessionSelectorPage(selector));

  const interactive = injectInteractiveSessionListPage(readFileSync(interactivePath, "utf8"));
  assert.match(interactive, /SessionManager\.listPage/);
  assert.match(interactive, /SessionManager\.listAllPage/);
  assert.throws(() => injectInteractiveSessionListPage(interactive));

  const main = injectMainSessionListPage(readFileSync(mainPath, "utf8"));
  assert.match(main, /SessionManager\.listPage/);
});

test("core-session cluster injects paging without drift", () => {
  const cases = [
    [join(senpiDir, "dist/core/session-discovery.js"), isSessionDiscoveryUrl, /listSessionsPage/],
    [join(senpiDir, "dist/core/session-manager.js"), isSessionManagerUrl, /listPage/],
    [join(senpiDir, "dist/modes/interactive/components/session-selector.js"), isSessionSelectorUrl, /loadMore/],
    [join(senpiDir, "dist/modes/interactive/interactive-mode.js"), isInteractiveModeSessionListUrl, /listPage/],
    [join(senpiDir, "dist/main.js"), isBootMainSessionListUrl, /listPage/],
  ];
  for (const [filePath, match, pattern] of cases) {
    const url = pathToFileURL(filePath).href;
    assert.equal(match(url), true, filePath);
    const { next, warnings } = applyNoThrow(url, readFileSync(filePath, "utf8"));
    assert.equal(warnings.length, 0, `${filePath}: ${warnings.join("; ")}`);
    assert.match(next, pattern);
  }
});

test("runtime listPage returns newest sessions first", async () => {
  const { SessionManager } = await import(pathToFileURL(join(senpiDir, "dist/core/session-manager.js")).href);
  const dir = mkdtempSync(join(tmpdir(), "rubato-session-list-page-"));
  const cwd = dir;
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const ts = now - (20 - i) * 1000;
    const file = join(dir, `session-${String(i).padStart(2, "0")}.jsonl`);
    writeFileSync(file, sessionJsonl(`id-${i}`, cwd, `message-${i}`, ts));
    const atime = ts / 1000;
    utimesSync(file, atime, atime);
  }
  const first = await SessionManager.listPage(cwd, dir, undefined, { offset: 0, limit: 12 });
  assert.equal(first.sessions.length, 12);
  assert.equal(first.total, 20);
  assert.equal(first.hasMore, true);
  assert.equal(first.sessions[0].firstMessage, "message-19");
  assert.equal(first.sessions[11].firstMessage, "message-8");
  const second = await SessionManager.listPage(cwd, dir, undefined, { offset: 12, limit: 12 });
  assert.equal(second.sessions.length, 8);
  assert.equal(second.hasMore, false);
  assert.equal(second.sessions[0].firstMessage, "message-7");
  assert.equal(second.sessions.at(-1).firstMessage, "message-0");
});
