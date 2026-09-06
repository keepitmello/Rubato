import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fakeSession } from "../helpers/context-notes-fake.mjs";
import { ContextNotesController } from "../../src/context-notes/controller.mjs";
import { contextNotesConfig } from "../../src/context-notes/config.mjs";
import { REMINDER_ENTRY, NOTE_ENTRY, SOURCE, INIT_ENTRY, messageText, initialWindow, nextWindow,
  encodeBootstrap, validateWindow, branchWindow, notePrefix } from "../../src/context-notes/protocol.mjs";
import { REMINDER_TEXT } from "../../src/context-notes/reminder.mjs";
import { ContextNotesStore } from "../../src/context-notes/store.mjs";
import { readAuthoritativeBranch } from "../../src/context-notes/history-source.mjs";
import { assertTransitionCommit, registerSessionGate } from "../../src/context-notes/engine-gate.mjs";
import { applyContextNotesTransforms } from "../../src/transforms/core-context-notes.mjs";

function setup(t) {
  const f = fakeSession(t);
  f.addMessage("user", "Keep public behavior unchanged");
  const options = { requireEngine: false, config: contextNotesConfig({ RUBATO_CONTEXT_WINDOW_TOKENS: "12000" }) };
  const c = new ContextNotesController(f.pi, f.ctx, options);
  t.after(() => c.close());
  return { ...f, c, options };
}
function save(f, text = "Goal / decisions / current progress / next steps") {
  return f.c.writeNote({ path: "work.md", text }, f.ctx, { operationId: "note-call" });
}
function near(f) { f.addMessage("toolResult", "a".repeat(19000), { toolName: "read", toolCallId: "read1" }); }
function prepared(f) { return f.c.prepareContext({ messages: f.build().messages }, f.ctx).messages; }
function withNotes(fn) {
  const previous = process.env.RUBATO_CONTEXT_MODE;
  process.env.RUBATO_CONTEXT_MODE = "history-notes";
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.RUBATO_CONTEXT_MODE; else process.env.RUBATO_CONTEXT_MODE = previous;
  }
}

test("one-shot reminder retains exact request prefix after another round", (t) => {
  const f = setup(t); near(f);
  const first = prepared(f); const original = JSON.stringify(first);
  f.addMessage("assistant", [{ type: "toolCall", id: "r2", name: "get_context_remaining", arguments: {} }]);
  f.addMessage("toolResult", "remaining changed", { toolName: "get_context_remaining", toolCallId: "r2" });
  const second = prepared(f);
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(JSON.stringify(first), original);
  assert.equal(second.filter(m => messageText(m) === REMINDER_TEXT).length, 1);
  assert.equal(f.branch().filter(e => e.customType === REMINDER_ENTRY).length, 1);
  assert.ok(!REMINDER_TEXT.includes("tokens remain"));
});
test("preparing twice does not add a second reminder or mutate original input", (t) => {
  const f = setup(t); near(f); const input = f.build().messages; const original = JSON.stringify(input);
  assert.deepEqual(prepared(f), prepared(f));
  assert.equal(JSON.stringify(input), original);
  assert.equal(f.branch().filter(e => e.customType === REMINDER_ENTRY).length, 1);
});
test("reminder position and content survive controller restart", (t) => {
  const f = setup(t); near(f); const first = prepared(f); f.c.close();
  const c = new ContextNotesController(f.pi, f.ctx, f.options); t.after(() => c.close());
  assert.deepEqual(c.prepareContext({ messages: f.build().messages }, f.ctx).messages, first);
});
test("rewinding before reminder does not expose the abandoned branch reminder", (t) => {
  const f = setup(t); const oldLeaf = f.manager.getLeafId(); near(f); prepared(f);
  f.rewind(oldLeaf); f.c.refresh(f.ctx, true);
  assert.equal(prepared(f).some(m => messageText(m) === REMINDER_TEXT), false);
});
test("next window has no reminder until it reaches its own threshold", async (t) => {
  const f = setup(t); near(f); prepared(f); save(f); await f.c.roll(f.ctx);
  assert.equal(prepared(f).some(m => messageText(m) === REMINDER_TEXT), false);
});
test("a missing reminder anchor stops instead of rewriting the old prefix", (t) => {
  const f = setup(t); near(f); prepared(f);
  assert.throws(() => f.c.prepareContext({ messages: [] }, f.ctx), /위치/);
});
test("reminder durability failure fails before returning an input", (t) => {
  const f = setup(t); near(f); f.c.flushJournal = () => { throw new Error("flush-failed"); };
  assert.throws(() => prepared(f), /flush-failed/);
  assert.ok(f.c.fatal);
});
test("window bootstrap does not change when working notes are updated", async (t) => {
  const f = setup(t); save(f); await f.c.roll(f.ctx); const first = prepared(f);
  f.c.writeNote({ path: "other.md", text: "Different note" }, f.ctx, { operationId: "other" });
  assert.equal(messageText(prepared(f)[0]), messageText(first[0]));
});
test("work result after note blocks both explicit and automatic transition", async (t) => {
  const f = setup(t); save(f);
  f.addMessage("toolResult", "tests failed", { toolName: "bash", toolCallId: "job1" });
  assert.throws(() => f.c.requestWindow(f.ctx), /최신 상태/);
  await assert.rejects(f.c.roll(f.ctx, "budget"), /최신 상태/);
  assert.equal(f.c.window.number, 0);
});
test("new work in the same tool batch is not dropped by scheduled new_context", async (t) => {
  const f = setup(t); save(f); f.c.requestWindow(f.ctx);
  f.addMessage("toolResult", "FILE WAS CHANGED", { toolName: "write", toolCallId: "late" });
  await f.c.turnEnd({}, f.ctx);
  assert.equal(f.c.window.number, 0); assert.ok(f.c.paused);
});
test("management-only rounds after a checkpoint may transition", async (t) => {
  const f = setup(t); save(f);
  f.addMessage("assistant", [{ type: "toolCall", name: "new_context", id: "switch1", arguments: {} }]);
  f.addMessage("toolResult", "scheduled", { toolName: "new_context", toolCallId: "switch1" });
  await f.c.roll(f.ctx); assert.equal(f.c.window.number, 1);
});
test("manual transition requests a fresh checkpoint when an old note is stale", async (t) => {
  const f = setup(t); save(f); f.addMessage("toolResult", "new failure", { toolName: "bash" });
  assert.equal((await f.c.manual(f.ctx)).requested, true);
  assert.equal(f.sent.length, 1); assert.equal(f.c.window.number, 0);
});
test("a provider error never triggers a scheduled reset", async (t) => {
  const f = setup(t); save(f); f.c.requestWindow(f.ctx);
  await f.c.turnEnd({ message: { stopReason: "error" } }, f.ctx);
  assert.equal(f.c.window.number, 0); assert.equal(f.c.pending, null);
});
test("a thrown post-commit failure quarantines, then reopening can recover", async (t) => {
  const f = setup(t); save(f); const apply = f.ctx.applyCompaction;
  f.ctx.applyCompaction = async (...args) => { await apply(...args); throw new Error("hook failure"); };
  await assert.rejects(f.c.roll(f.ctx), /후처리/);
  assert.equal(f.c.window.number, 1); assert.throws(() => prepared(f), /후처리/);
  const id = f.c.window.windowId; f.c.close();
  const c = new ContextNotesController(f.pi, f.ctx, f.options); t.after(() => c.close());
  assert.equal(c.window.windowId, id); assert.ok(c.store.noteText("work.md"));
});
test("same call id with different parameters is rejected without another write", (t) => {
  const f = setup(t); save(f, "first");
  assert.throws(() => save(f, "second"), /같은 도구 호출/);
  assert.equal(f.c.store.noteText("work.md"), "first");
});
test("duplicate session gate cannot overwrite a live owner", () => withNotes(() => {
  const close = registerSessionGate("duplicate-owner", () => {});
  try { assert.throws(() => registerSessionGate("duplicate-owner", () => {}), /이미 실행/); }
  finally { close(); }
}));
test("commit fence detects input appended after the initial revision check", async (t) => {
  const f = setup(t); save(f);
  f.ctx.applyCompaction = async (result) => {
    await Promise.resolve(); f.addMessage("user", "NEW REQUIREMENT");
    withNotes(() => assertTransitionCommit({ precomputed: result }, f.manager));
    assert.fail("must never append a boundary");
  };
  await assert.rejects(f.c.roll(f.ctx));
  assert.equal(f.entries.filter(e => e.type === "compaction").length, 0);
  assert.ok(f.build().messages.some(m => messageText(m) === "NEW REQUIREMENT"));
});
test("commit fence accepts an intact marker and blocks cancellation", async (t) => {
  const f = setup(t); save(f); const apply = f.ctx.applyCompaction;
  f.ctx.applyCompaction = async (result, options) => {
    withNotes(() => assertTransitionCommit({ precomputed: result }, f.manager));
    assert.throws(() => withNotes(() => assertTransitionCommit({ precomputed: result,
      controller: { signal: AbortSignal.abort() } }, f.manager)));
    return apply(result, options);
  };
  await f.c.roll(f.ctx); assert.equal(f.c.window.number, 1);
});
test("source projection rejects duplicate ids instead of silently choosing one", (t) => {
  const f = setup(t); const all = f.entries;
  assert.throws(() => readAuthoritativeBranch({ getEntries: () => [...all, all[0]], getLeafId: f.manager.getLeafId }), /중복/);
});
test("window lineage must have consistent root, predecessor and sequence", () => {
  const root = initialWindow(); assert.throws(() => validateWindow({ ...root, previousWindowId: root.windowId }));
  const second = nextWindow(root); const wrong = { ...second, number: 3 };
  assert.throws(() => branchWindow([
    { type: "custom", customType: INIT_ENTRY, data: { window: root } },
    { type: "compaction", summary: encodeBootstrap(wrong), details: { source: SOURCE, window: wrong } },
  ]), /연결/);
});
test("note root and directory prefixes preserve their intended scope", () => {
  assert.equal(notePrefix("/root/notes/"), ""); assert.equal(notePrefix("/root/notes/a/"), "a/");
  assert.throws(() => notePrefix("../")); assert.throws(() => notePrefix(123));
});
test("note list has a usable cursor and directory prefix does not match sibling names", (t) => {
  const f = setup(t);
  for (const path of ["a/one", "a/two", "ab/three"]) f.c.writeNote({ path, text: path }, f.ctx);
  const a = f.c.store.noteList({ prefix: "a/", max_results: 1 });
  const b = f.c.store.noteList({ prefix: "a/", max_results: 1, after_path: a.next_after_path });
  assert.deepEqual([...a.files, ...b.files].map(x => x.path), ["a/one", "a/two"]);
  assert.equal(b.has_more, false);
});
test("empty historical windows remain reachable with pagination", async (t) => {
  const f = setup(t); save(f); await f.c.roll(f.ctx);
  f.c.writeNote({ path: "work.md", text: "next" }, f.ctx); await f.c.roll(f.ctx);
  const a = f.c.store.listWindows({ limit: 1 });
  const b = f.c.store.listWindows({ limit: 1, after_window_id: a.next_after_window_id });
  const c = f.c.store.listWindows({ limit: 1, after_window_id: b.next_after_window_id });
  assert.deepEqual([a, b, c].map(p => p.windows[0].number), [2, 1, 0]);
  assert.equal(c.has_more, false);
});
test("same note id cannot change path while retaining the same text", (t) => {
  const f = setup(t); save(f); const changed = structuredClone(f.branch());
  changed.findLast(e => e.customType === NOTE_ENTRY).data.path = "other.md";
  assert.throws(() => f.c.store.sync(changed), /변경/);
});
test("SQLite database and sidecars use private permissions", { skip: process.platform === "win32" }, (t) => {
  const f = setup(t); save(f);
  for (const path of [f.c.store.path, `${f.c.store.path}-wal`, `${f.c.store.path}-shm`]) {
    assert.equal(statSync(path).mode & 0o077, 0);
  }
});
test("a symlinked database directory is refused", { skip: process.platform === "win32" }, (t) => {
  const f = fakeSession(t); const link = join(f.dir, "link"); symlinkSync(f.dir, link, "dir");
  assert.throws(() => new ContextNotesStore(join(link, "db.sqlite")), /심볼릭/);
});
test("a v1 pretransformed engine cannot masquerade as a v2 engine", () => {
  assert.throws(() => applyContextNotesTransforms("file:///node_modules/@code-yeongyu/senpi/dist/core/messages.js",
    "// rubato-history-notes-transform-v1:messages", { enabled: true }), /이전 문맥/);
});

test("user text resembling a bootstrap does not replace the actual window header", (t) => {
  const f = setup(t);
  f.addMessage("user", "<rubato_context_window_v1>not a real header");
  const messages = prepared(f);
  assert.equal(messageText(messages[0]), f.c.bootstrap);
  assert.ok(messageText(messages.at(-1)).includes("[history:"));
});
test("note search bounds each file and supports file continuation", (t) => {
  const f = setup(t);
  for (const path of ["one.md", "two.md", "three.md"]) f.c.writeNote({ path,
    text: Array.from({ length: 60 }, () => "needle " + "x".repeat(600)).join("\n") }, f.ctx);
  const first = f.c.store.noteSearch({ query: "needle", max_matches_per_file: 50 });
  assert.ok(first.files.length > 0); assert.ok(JSON.stringify(first).length < 24000);
  assert.ok(first.files[0].has_more_matches); assert.ok(first.files[0].next_start_line);
  assert.ok(first.truncated); assert.ok(first.next_after_path);
  const second = f.c.store.noteSearch({ query: "needle", max_matches_per_file: 50, after_path: first.next_after_path });
  assert.ok(second.files.length); assert.notEqual(second.files[0].path, first.files[0].path);
});
test("note data cannot override the journal entry id", (t) => {
  const f = setup(t); save(f);
  const branch = f.branch(); const entry = branch.findLast(e => e.customType === NOTE_ENTRY);
  entry.data.id = "forged-id";
  f.c.store.sync(branch);
  assert.equal(f.c.store.noteVersions.get("work.md").id, entry.id);
});
