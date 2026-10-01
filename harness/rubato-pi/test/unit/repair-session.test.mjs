import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findSessionFile, repairParentLinks, repairSessionFile } from "../../../scripts/repair-session.mjs";

const line = (value) => JSON.stringify(value);
// The 2026-09-28 shape: assistant b0088373 never reached the file (disk full), and the
// next user message a34a8bc0 still pointed at it.
const broken = [
  line({ type: "session", version: 3, id: "s1", cwd: "/w" }),
  line({ type: "message", id: "u1", parentId: null, message: { role: "user" } }),
  line({ type: "message", id: "4109cba7", parentId: "u1", message: { role: "toolResult" } }),
  line({ type: "message", id: "a34a8bc0", parentId: "b0088373", message: { role: "user" } }),
  line({ type: "message", id: "next", parentId: "a34a8bc0", message: { role: "assistant" } }),
].join("\n") + "\n";

test("an orphan hangs from the entry written right before it, and nothing else changes", () => {
  const { text, repairs, malformed } = repairParentLinks(broken);
  assert.deepEqual(repairs, [{ id: "a34a8bc0", missingParentId: "b0088373", newParentId: "4109cba7" }]);
  assert.equal(malformed, 0);
  const entries = text.trim().split("\n").map((value) => JSON.parse(value));
  const ids = new Set(entries.map((entry) => entry.id));
  assert.deepEqual(entries.filter((entry) => entry.parentId && !ids.has(entry.parentId)), []);
  assert.deepEqual(text.split("\n").filter((value, index) => value !== broken.split("\n")[index]).length, 1);
});

test("a file with no break is left untouched and no backup is made", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "repair-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-10-01T00-00-00-000Z_s1.jsonl");
  const healthy = repairParentLinks(broken).text;
  writeFileSync(file, healthy);
  const result = repairSessionFile(file);
  assert.deepEqual(result.repairs, []);
  assert.equal(result.backup, undefined);
  assert.equal(readFileSync(file, "utf8"), healthy);
});

test("repair keeps the original as a backup and the file mode", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "repair-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-10-01T00-00-00-000Z_01a0e5b9-24fb.jsonl");
  writeFileSync(file, broken);
  chmodSync(file, 0o600);
  assert.equal(findSessionFile(dir, "01a0e5b9"), file);
  const result = repairSessionFile(file, { now: new Date("2026-10-01T07:00:00Z") });
  assert.equal(readFileSync(result.backup, "utf8"), broken);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(repairParentLinks(readFileSync(file, "utf8")).repairs.length, 0);
});
