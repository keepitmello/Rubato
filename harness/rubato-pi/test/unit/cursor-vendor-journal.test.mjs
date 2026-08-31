import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { senpiDir } from "../../src/engine-paths.mjs";
import { vendorFileStates } from "./support/vendor-file-states.mjs";
import * as journal from "../../src/transforms/cursor-exec-journal.mjs";

test("cursor-exec-journal.js is a created vendor file (pristine empty)", () => {
  const pair = vendorFileStates("senpi", "dist/core/cursor-exec-journal.js");
  assert.ok(pair);
  assert.equal(pair.pristine, "");
  assert.ok(pair.patched.length > 0);
  assert.equal(pair.applied, 3);
});

test("in-repo journal exports match the fully-patched vendor module", async () => {
  // Deviation: created file + import rewrite (proper-lockfile / config / lockfile-policy
  // resolved via senpiDir). Byte equality against vendor journal.js is impossible.
  const vendor = await import(pathToFileURL(`${senpiDir}/dist/core/cursor-exec-journal.js`).href);
  const skip = new Set(["cursorExecJournalHref", "default"]);
  const ours = Object.keys(journal).filter((key) => !skip.has(key)).sort();
  const theirs = Object.keys(vendor).filter((key) => key !== "default").sort();
  assert.deepEqual(ours, theirs);
  for (const key of ours) {
    assert.equal(typeof journal[key], typeof vendor[key], key);
  }
  assert.match(journal.cursorExecJournalHref(), /cursor-exec-journal\.mjs$/);
});

test("in-repo journal prepare/complete replays a completed tool call", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-vendor-journal-"));
  try {
    const instance = journal.createCursorExecJournal({ agentDir: dir });
    const first = instance.prepare({
      lineageId: "lin-1",
      toolCallId: "tc-1",
      toolName: "bash",
    });
    assert.equal(first.decision, "execute");
    instance.markExecuting("lin-1", "tc-1");
    instance.complete("lin-1", "tc-1", {
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    const again = instance.prepare({
      lineageId: "lin-1",
      toolCallId: "tc-1",
      toolName: "bash",
    });
    assert.equal(again.decision, "replay");
    assert.equal(again.entry.state, journal.CURSOR_EXEC_COMPLETED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
