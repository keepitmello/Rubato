import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { senpiDir } from "../../src/engine-paths.mjs";
import { injectSessionPersist, isSessionManagerUrl } from "../../src/transforms/core-session-persist.mjs";

function pinnedSessionManager() {
  return readFileSync(join(senpiDir, "dist/core/session-manager.js"), "utf8");
}

test("session manager url matcher hits senpi session-manager", () => {
  assert.equal(isSessionManagerUrl("file:///x/@code-yeongyu/senpi/dist/core/session-manager.js"), true);
  assert.equal(isSessionManagerUrl("file:///x/@code-yeongyu/senpi/dist/core/agent-session.js"), false);
});

test("first user message is enough to create the session jsonl", () => {
  const source = pinnedSessionManager();
  const persist = source.slice(source.indexOf("_persist(entry)"));
  assert.match(persist, /const hasAssistant = this\.fileEntries\.some/);
  const next = injectSessionPersist(source);
  const nextPersist = next.slice(next.indexOf("_persist(entry)"));
  assert.match(nextPersist, /const hasMessage = this\.fileEntries\.some\(\(e\) => e\.type === "message" && \(e\.message\.role === "assistant" \|\| e\.message\.role === "user"\)\)/);
  assert.doesNotMatch(nextPersist.slice(0, 600), /const hasAssistant = this\.fileEntries\.some/);
  assert.throws(() => injectSessionPersist(next));
});

test("runtime: first user message creates the jsonl", async () => {
  const { SessionManager } = await import(pathToFileURL(join(senpiDir, "dist/core/session-manager.js")).href);
  const dir = mkdtempSync(join(tmpdir(), "rubato-session-persist-"));
  const mgr = SessionManager.create(dir, dir);
  assert.equal(existsSync(mgr.getSessionFile()), false);
  mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
  assert.equal(existsSync(mgr.getSessionFile()), true, mgr.getSessionFile());
  const body = readFileSync(mgr.getSessionFile(), "utf8");
  assert.match(body, /"type":"session"/);
  assert.match(body, /"role":"user"/);
});
