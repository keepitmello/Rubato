import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ContextNotesStore } from "../../src/context-notes/store.mjs";
import { INIT_ENTRY, NOTE_ENTRY, SOURCE, initialWindow, nextWindow, encodeBootstrap } from "../../src/context-notes/protocol.mjs";
import { fakeSession } from "../helpers/context-notes-fake.mjs";

function setup(t) {
  const f = fakeSession(t); const w = initialWindow();
  f.append({ type: "custom", customType: INIT_ENTRY, data: { window: w } });
  const store = new ContextNotesStore(join(f.dir, "index.sqlite"));
  t.after(() => store.close());
  return { ...f, store, w };
}
function note(f, path, text, options = {}) {
  return f.append({ type: "custom", customType: NOTE_ENTRY, data: { path, text, windowId: f.w.windowId,
    throughUserId: null, savedAtTokens: 5, ...options } });
}
test("literal case-sensitive search, role filtering and exact Unicode reads", (t) => {
  const f = setup(t);
  const user = f.addMessage("user", "가😀AbC끝"); f.addMessage("assistant", "abc");
  f.addMessage("toolResult", "AbC from tool", { toolName: "fs.read", toolCallId: "c1" });
  f.store.sync(f.branch());
  assert.equal(f.store.listItems({ query: "AbC" }, true).items.length, 2);
  assert.equal(f.store.listItems({ query: "abc" }, true).items.length, 1);
  assert.equal(f.store.listItems({ query: "AbC", role: "tool" }, true).items.length, 1);
  assert.equal(f.store.listItems({ tool_namespace: "fs" }).items.length, 1);
  assert.equal(f.store.readItem({ window_id: f.w.windowId, item_id: user.id, offset_chars: 1, limit_chars: 2 }).content, "😀A");
  assert.equal(JSON.parse(f.store.readItem({ window_id: f.w.windowId, item_id: user.id, view: "raw" }).content).message.content, "가😀AbC끝");
  assert.equal(f.store.listItems({ window_id: "missing" }).items.length, 0);
  assert.throws(() => f.store.readItem({ window_id: "missing", item_id: user.id }));
  assert.throws(() => f.store.listItems({ agent_name: "/other" }));
});
test("history paging does not repeat or omit items", (t) => {
  const f = setup(t); for (let i = 0; i < 11; i++) f.addMessage("user", `message ${i}`);
  f.store.sync(f.branch());
  let cursor; const seen = [];
  do {
    const page = f.store.listItems({ limit: 3, after_item_id: cursor, recent_first: false });
    seen.push(...page.items.map((i) => i.item_id)); cursor = page.has_more ? page.next_after_item_id : undefined;
  } while (cursor);
  assert.equal(seen.length, 11); assert.equal(new Set(seen).size, 11);
});
test("old originals remain searchable after an empty-window transition", (t) => {
  const f = setup(t); const original = f.addMessage("user", "original requirement");
  const w2 = nextWindow(f.w);
  f.append({ type: "compaction", summary: encodeBootstrap(w2), details: { source: SOURCE, window: w2 }, firstKeptEntryId: "unused" });
  f.addMessage("user", "second window"); f.store.sync(f.branch());
  assert.equal(f.store.listWindows().windows.length, 2);
  assert.equal(f.store.readItem({ window_id: f.w.windowId, item_id: original.id }).content, "original requirement");
});
test("branch rewind isolates future history and note revisions", (t) => {
  const f = setup(t); const past = f.addMessage("user", "past");
  const first = note(f, "work.md", "old");
  const future = f.addMessage("user", "future"); note(f, "work.md", "new");
  f.store.sync(f.branch()); assert.equal(f.store.noteText("work.md"), "new");
  f.rewind(first.id); f.store.sync(f.branch());
  assert.equal(f.store.noteText("work.md"), "old");
  assert.equal(f.store.listItems({ query: "future" }, true).items.length, 0);
  assert.throws(() => f.store.readItem({ window_id: f.w.windowId, item_id: future.id }));
  assert.equal(f.store.readItem({ window_id: f.w.windowId, item_id: past.id }).content, "past");
});
test("notes and originals rebuild from journal without a previous database", (t) => {
  const f = setup(t); f.addMessage("user", "keep me"); note(f, "work.md", "resume me"); f.store.sync(f.branch());
  const restored = new ContextNotesStore(join(f.dir, "fresh.sqlite"));
  try { restored.sync(f.branch()); assert.equal(restored.noteText("work.md"), "resume me"); assert.equal(restored.listItems().items.length, 1); }
  finally { restored.close(); }
});
test("line/character note reads are bounded and long lines can be fully recovered", (t) => {
  const f = setup(t); note(f, "work.md", "first\nsecond\nthird");
  note(f, "long.md", "😀".repeat(21000)); f.store.sync(f.branch());
  assert.equal(f.store.noteRead({ path: "work.md", start_line: -2, stop_line: -1 }).text, "second\nthird");
  const a = f.store.noteRead({ path: "long.md" });
  assert.equal(Array.from(a.text).length, 20000); assert.equal(a.next_offset_chars, 20000);
  assert.equal(Array.from(f.store.noteReadChars({ path: "long.md", offset_chars: a.next_offset_chars }).text).length, 1000);
});
test("hint includes only bounded filenames, not note contents", (t) => {
  const f = setup(t); for (let i=0;i<10;i++) note(f, `note-${i}.md`, `SECRET BODY ${i}`);
  f.store.sync(f.branch()); const hint = f.store.hint();
  assert.equal((hint.match(/UTF-8 bytes/g) ?? []).length, 5);
  assert.ok(!hint.includes("SECRET BODY")); assert.ok(Buffer.byteLength(hint) <= 4000);
});
test("created order differs from last update order", (t) => {
  const f = setup(t); note(f, "a", "1"); note(f, "b", "2"); note(f, "a", "3"); f.store.sync(f.branch());
  assert.deepEqual(f.store.noteList({ file_order_by: "created_at" }).files.map((x)=>x.path), ["a","b"]);
  assert.deepEqual(f.store.noteList({ file_order_by: "updated_at" }).files.map((x)=>x.path), ["b","a"]);
});
test("immutable archive rejects overwritten originals instead of corrupting history", (t) => {
  const f=setup(t); f.addMessage("user", "original"); f.store.sync(f.branch());
  const changed=structuredClone(f.branch()); changed.at(-1).message.content="changed";
  assert.throws(()=>f.store.sync(changed));
});
