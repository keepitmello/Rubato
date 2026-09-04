import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistWriteToHostDisk } from "../../src/transforms/cursor-write-host-fs.mjs";

test("host persist creates the file, fsyncs, and refuses a mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rubato-write-host-"));
  const path = join(dir, "nested", "out.txt");
  const absolute = await persistWriteToHostDisk(path, "hello-disk\n");
  assert.equal(absolute, path);
  assert.equal(await readFile(path, "utf8"), "hello-disk\n");
});
