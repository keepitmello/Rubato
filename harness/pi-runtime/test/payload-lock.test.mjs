import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stageAndPublishInstall } from "../scripts/install-transaction.mjs";
import { retirePath } from "../scripts/install-candidate.mjs";
import { lockPublishedPayload, unlockPublishedPayload } from "../scripts/payload-lock.mjs";

const run = promisify(execFile);
const darwin = process.platform === "darwin";

async function scratch() {
  return mkdtemp(join(tmpdir(), "rubato-payload-lock-"));
}

async function writeStage(root, body) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "payload.mjs"), body);
  await writeFile(join(root, "rubato-pi-stage.json"), `${JSON.stringify({
    files: [],
    addedFiles: [{ path: "payload.mjs", sha256: "a".repeat(64) }],
    binShims: [],
  })}\n`);
}

test("a published payload rejects an in-place overwrite", { skip: !darwin }, async (t) => {
  const root = await scratch();
  t.after(async () => {
    await unlockPublishedPayload(root);
    await rm(root, { recursive: true, force: true });
  });
  await writeStage(root, "old\n");
  const locked = await lockPublishedPayload(root);
  assert.equal(locked.locked, true);
  assert.ok(locked.count >= 4);
  await assert.rejects(writeFile(join(root, "payload.mjs"), "patched\n"), { code: "EPERM" });
  assert.equal(await readFile(join(root, "payload.mjs"), "utf8"), "old\n");
});

test("directory rename still replaces a locked install", { skip: !darwin }, async (t) => {
  const home = await scratch();
  const trash = join(home, "trash");
  t.after(async () => {
    await run("chflags", ["-R", "nouchg", home]);
    await rm(home, { recursive: true, force: true });
  });
  const dest = join(home, "engine");
  const retire = (path) => retirePath(path, { trashRoot: trash });
  await stageAndPublishInstall(dest, {
    mode: "install",
    retire,
    async build(stage) { await writeStage(stage, "first\n"); },
  });
  await lockPublishedPayload(dest);
  await stageAndPublishInstall(dest, {
    mode: "update",
    retire,
    async build(stage) { await writeStage(stage, "second\n"); },
  });
  assert.equal(await readFile(join(dest, "payload.mjs"), "utf8"), "second\n");
  assert.equal(await readFile(join(`${dest}.previous`, "payload.mjs"), "utf8"), "first\n");
  // The locked tree is now the snapshot. The next update has to retire it
  // without deleting the immutable files in place.
  await stageAndPublishInstall(dest, {
    mode: "update",
    retire,
    async build(stage) { await writeStage(stage, "third\n"); },
  });
  assert.equal(await readFile(join(dest, "payload.mjs"), "utf8"), "third\n");
  assert.equal(await readFile(join(`${dest}.previous`, "payload.mjs"), "utf8"), "second\n");
});
