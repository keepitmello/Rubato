import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const enabled = process.env.RUBATO_TEST_CONTEXT_NOTES_ENGINE === "1";
test("actual pinned SessionManager preserves full history across mirror trim and reload", { skip: !enabled }, async () => {
  process.env.RUBATO_CONTEXT_MODE = "history-notes";
  await import("../../src/no-changelog-register.mjs");
  const { senpiDir } = await import("../../src/engine-paths.mjs");
  const { SessionManager } = await import(pathToFileURL(join(senpiDir, "dist/core/session-manager.js")).href);
  const { ContextNotesController } = await import("../../src/context-notes/controller.mjs");
  const { messageText } = await import("../../src/context-notes/protocol.mjs");
  const dir = mkdtempSync(join(tmpdir(), "rubato-real-notes-"));
  let controller;
  try {
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "ORIGINAL REQUIREMENT" }], timestamp: Date.now() });
    // The real session-manager storage/projection is under test here. This
    // adapter does NOT claim to test the complete AgentSession lifecycle.
    const context = (sm) => ({ sessionManager: sm, agentDir: dir,
      model: { provider: "test", id: "test", contextWindow: 32000 }, ui: {},
      getContextUsage: () => ({ tokens: 0 }), getSystemPrompt: () => "system", isIdle: () => true,
      getMessageRevision: () => sm.getEntries().length,
      async applyCompaction(result, options) {
        if (options.expectedRevision !== sm.getEntries().length) return { applied: false, reason: "stale" };
        sm.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
        return { applied: true, reason: "ok" };
      } });
    let ctx = context(manager);
    const pi = { appendEntry: (name, data) => ctx.sessionManager.appendCustomEntry(name, data) };
    controller = new ContextNotesController(pi, ctx, { requireEngine: false });
    const oldWindow = controller.window.windowId;
    const original = manager.getEntries().find((e) => e.type === "message");
    controller.writeNote({ path: "work.md", text: "CHECKPOINT BODY" }, ctx, { operationId: "n1" });
    await controller.roll(ctx, "tool");
    assert.equal(manager.buildSessionContext().messages.length, 1);
    assert.ok(messageText(manager.buildSessionContext().messages[0]).includes("work.md"));
    assert.ok(!messageText(manager.buildSessionContext().messages[0]).includes("CHECKPOINT BODY"));
    assert.equal(controller.store.readItem({ window_id: oldWindow, item_id: original.id }).content, "ORIGINAL REQUIREMENT");
    const newId = controller.window.windowId;
    controller.close();
    const reopened = SessionManager.open(manager.getSessionFile()); ctx = context(reopened);
    controller = new ContextNotesController(pi, ctx, { requireEngine: false });
    assert.equal(controller.window.windowId, newId);
    assert.equal(controller.store.noteText("work.md"), "CHECKPOINT BODY");
    assert.equal(controller.store.readItem({ window_id: oldWindow, item_id: original.id }).content, "ORIGINAL REQUIREMENT");
  } finally { controller?.close(); rmSync(dir, { recursive: true, force: true }); }
});
