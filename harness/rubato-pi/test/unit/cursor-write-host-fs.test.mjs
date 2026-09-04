import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  applyUniqueEdits,
  persistEditToHostDisk,
  persistWriteToHostDisk,
  resolveHostPath,
} from "../../src/transforms/cursor-write-host-fs.mjs";

test("host persist creates the file, fsyncs, and refuses a mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rubato-write-host-"));
  const path = join(dir, "nested", "out.txt");
  const absolute = await persistWriteToHostDisk(path, "hello-disk\n");
  assert.equal(absolute, path);
  assert.equal(await readFile(path, "utf8"), "hello-disk\n");
});

test("relative writes land in the session cwd, not process.cwd()", async () => {
  const sessionCwd = await mkdtemp(join(tmpdir(), "other-repo-"));
  const absolute = await persistWriteToHostDisk("src/note.txt", "from-other-repo\n", sessionCwd);
  assert.equal(absolute, resolve(sessionCwd, "src/note.txt"));
  assert.equal(await readFile(absolute, "utf8"), "from-other-repo\n");
  assert.equal(resolveHostPath("src/note.txt", sessionCwd), absolute);
});

test("edit persist applies a unique replacement on the host disk in any cwd", async () => {
  const sessionCwd = await mkdtemp(join(tmpdir(), "edit-repo-"));
  await writeFile(join(sessionCwd, "app.ts"), "const x = 1;\n", "utf8");
  const absolute = await persistEditToHostDisk("app.ts", [{ oldText: "const x = 1;", newText: "const x = 2;" }], sessionCwd);
  assert.equal(absolute, resolve(sessionCwd, "app.ts"));
  assert.equal(await readFile(absolute, "utf8"), "const x = 2;\n");
});

test("edit persist refuses a non-unique replacement", () => {
  assert.throws(
    () => applyUniqueEdits("aa", [{ oldText: "a", newText: "b" }]),
    /exactly once/,
  );
});
