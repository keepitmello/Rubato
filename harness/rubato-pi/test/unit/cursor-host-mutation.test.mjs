import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyUniqueEdits,
  expectedWriteBytes,
  hostEdit,
  hostWrite,
  resolveSessionPath,
} from "../../src/transforms/cursor-host-mutation.mjs";
import { senpiNested } from "../../src/engine-paths.mjs";
import { injectCursorExecBridge } from "../../src/transforms/cursor-exec-bridge.mjs";
import { injectCursorExecBridgeSession } from "../../src/transforms/cursor-exec-bridge-session.mjs";

async function sessionDir() {
  return mkdtemp(join(tmpdir(), "rubato-host-mutation-"));
}

test("write lands in session cwd and readback matches", async () => {
  const cwd = await sessionDir();
  await hostWrite({ cwd, path: "note.txt", content: "hello" });
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "hello");
});

test("write replaces existing host bytes", async () => {
  const cwd = await sessionDir();
  await writeFile(join(cwd, "note.txt"), "old");
  await hostWrite({ cwd, path: "note.txt", content: "new" });
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "new");
});

test("fileBytes write keeps the original bytes", async () => {
  const cwd = await sessionDir();
  const bytes = Uint8Array.from([0, 1, 255, 10]);
  await hostWrite({ cwd, path: "blob.bin", bytes });
  assert.deepEqual(await readFile(join(cwd, "blob.bin")), Buffer.from(bytes));
});

test("edit applies on the host file once", async () => {
  const cwd = await sessionDir();
  await writeFile(join(cwd, "note.txt"), "alpha");
  await hostEdit({ cwd, path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] });
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "beta");
});

test("missing oldText fails and leaves the host file untouched", async () => {
  const cwd = await sessionDir();
  await writeFile(join(cwd, "note.txt"), "alpha");
  await assert.rejects(
    () => hostEdit({ cwd, path: "note.txt", edits: [{ oldText: "nope", newText: "beta" }] }),
    /did not persist/,
  );
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "alpha");
});

test("one failed edit in a batch leaves the host file untouched", async () => {
  const cwd = await sessionDir();
  await writeFile(join(cwd, "note.txt"), "alpha");
  await assert.rejects(
    () =>
      hostEdit({
        cwd,
        path: "note.txt",
        edits: [
          { oldText: "alpha", newText: "beta" },
          { oldText: "missing", newText: "gamma" },
        ],
      }),
    /did not persist/,
  );
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "alpha");
});

test("CRLF edit does not rewrite the rest of the file", async () => {
  const cwd = await sessionDir();
  await writeFile(join(cwd, "note.txt"), "keep\r\nalpha\r\n");
  await hostEdit({ cwd, path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] });
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "keep\r\nbeta\r\n");
});

test("relative paths ignore process.cwd()", async () => {
  const cwd = await sessionDir();
  const previous = process.cwd();
  const other = await sessionDir();
  process.chdir(other);
  try {
    await hostWrite({ cwd, path: "only-session.txt", content: "here" });
    assert.equal(await readFile(join(cwd, "only-session.txt"), "utf8"), "here");
    await assert.rejects(() => readFile(join(other, "only-session.txt")));
  } finally {
    process.chdir(previous);
  }
});

test("missing session cwd refuses to write anywhere", async () => {
  const previous = process.cwd();
  await assert.rejects(() => hostWrite({ cwd: "", path: "x.txt", content: "no" }), /missing session cwd/);
  await assert.rejects(() => hostWrite({ path: "x.txt", content: "no" }), /missing session cwd/);
  assert.equal(resolveSessionPath("/abs.txt", "/tmp/session"), "/abs.txt");
  assert.equal(process.cwd(), previous);
});

test("same-file writes serialize and the last result remains", async () => {
  const cwd = await sessionDir();
  await Promise.all([
    hostWrite({ cwd, path: "race.txt", content: "one" }),
    hostWrite({ cwd, path: "race.txt", content: "two" }),
    hostWrite({ cwd, path: "race.txt", content: "three" }),
  ]);
  const final = await readFile(join(cwd, "race.txt"), "utf8");
  assert.ok(["one", "two", "three"].includes(final));
});

test("expectedWriteBytes prefers raw bytes over text", () => {
  assert.deepEqual(expectedWriteBytes({ bytes: Uint8Array.from([9]), content: "x" }), Buffer.from([9]));
  assert.deepEqual(expectedWriteBytes({ content: "ab" }), Buffer.from("ab"));
  assert.throws(() => expectedWriteBytes({}), /missing file text/);
});

test("applyUniqueEdits rejects a duplicate match before any write", () => {
  assert.throws(() => applyUniqueEdits("aa", [{ oldText: "a", newText: "b" }]), /exactly once/);
});

test("bridge write/edit frames call the host mutation owner", () => {
  const source = readFileSync(senpiNested("@code-yeongyu/senpi/dist/core/cursor-exec-bridge.js"), "utf8");
  const next = injectCursorExecBridge(source);
  assert.match(next, /hostWriteResult\(options, args\.toolCallId, "write"/);
  assert.match(next, /hostEditResult\(options, call\.toolCallId/);
  assert.doesNotMatch(next, /write: async \(args\) => executeTool\(options, "write"/);
  assert.doesNotMatch(next, /piEdit: async \(call\) => executeTool\(options, "edit"/);
  assert.match(next, /cursor-host-mutation\.mjs/);
});

test("session bridge exposes cwd with no process.cwd fallback", () => {
  const source = readFileSync(senpiNested("@code-yeongyu/senpi/dist/core/cursor-exec-bridge-session.js"), "utf8");
  const next = injectCursorExecBridgeSession(source);
  assert.match(next, /getCwd: \(\) => sessionRef\.current\?\.cwd/);
  assert.doesNotMatch(next, /getCwd: \(\) => sessionRef\.current\?\.cwd \?\? process\.cwd\(\)/);
});
