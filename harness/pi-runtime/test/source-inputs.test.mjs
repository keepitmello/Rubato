import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  describeSourceInputs, inputFingerprint, snapshotFingerprint, snapshotSources,
} from "../scripts/source-fingerprint.mjs";

async function repoFixture(t) {
  const repo = await mkdtemp(join(tmpdir(), "rubato-source-inputs-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const files = {
    "package.json": "{}\n",
    "bun.lock": "lock\n",
    "LICENSE.md": "license\n",
    "harness/pi-runtime/package.json": "{}\n",
    "harness/pi-runtime/features/providers/patches.mjs": "export const files = [];\n",
    "harness/pi-runtime/features/providers/patches.test.mjs": "test\n",
    "harness/pi-runtime/test/fixture.mjs": "fixture\n",
    // Staged only through a template-string source(), never imported.
    "harness/rubato-pi/src/transforms/cursor-read-image.mjs": "export default 1;\n",
    "harness/rubato-pi/src/transforms/cursor-read-image.test.mjs": "test\n",
    "harness/rubato-pi/data/speed-index-baseline-v0.json": "{}\n",
    "harness/scripts/kiro-setup.sh": "#!/bin/sh\n",
    "packages/model-core/package.json": "{}\n",
    "packages/model-core/src/model-label.mjs": "export const label = 1;\n",
    "packages/model-core/src/model-label.test.mjs": "test\n",
    "harness/skills/demo/SKILL.md": "skill\n",
    "harness/t3-integration/apply.mjs": "overlay\n",
    // Bundled by a bun subprocess while remote-surface loads, not by an import.
    "packages/rubato-remote-protocol/package.json": "{}\n",
    "packages/rubato-remote-protocol/src/index.ts": "export * from './codec.ts';\n",
    "packages/rubato-remote-protocol/src/codec.ts": "export const codec = 1;\n",
    "packages/rubato-remote-protocol/test/codec.test.ts": "test\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const inputs = await describeSourceInputs(repo, [
    join(repo, "harness/rubato-pi/src/transforms/cursor-read-image.mjs"),
    join(repo, "harness/rubato-pi/data/speed-index-baseline-v0.json"),
    join(repo, "harness/scripts/kiro-setup.sh"),
    "packages/model-core/src/model-label.mjs",
    "LICENSE.md",
    "/somewhere/else/node_modules/dep/index.js",
  ]);
  return { repo, inputs };
}

test("sourceInputs name what the build read plus the pi-runtime tree, not skills, tests or other trees", async (t) => {
  const { repo, inputs } = await repoFixture(t);
  assert.deepEqual(inputs.trees, ["harness/pi-runtime", "packages/rubato-remote-protocol"]);
  for (const path of ["harness/rubato-pi/src/transforms/cursor-read-image.mjs", "harness/scripts/kiro-setup.sh",
    "packages/model-core/src/model-label.mjs", "LICENSE.md", "package.json", "bun.lock", "packages/model-core/package.json"]) {
    assert.ok(inputs.files.includes(path), path);
  }
  assert.equal(inputs.files.some((path) => path.includes("node_modules") || path.startsWith("/")), false);
  const initial = await inputFingerprint(repo, inputs);
  assert.match(initial, /^[a-f0-9]{64}$/);
  assert.equal(snapshotFingerprint(await snapshotSources(repo), inputs), initial, "snapshot and disk agree on the same tree");
});

test("editing files the build does not read keeps the fingerprint", async (t) => {
  const { repo, inputs } = await repoFixture(t);
  const initial = await inputFingerprint(repo, inputs);
  for (const path of ["harness/skills/demo/SKILL.md", "harness/pi-runtime/features/providers/patches.test.mjs",
    "harness/pi-runtime/test/fixture.mjs", "harness/rubato-pi/src/transforms/cursor-read-image.test.mjs",
    "packages/model-core/src/model-label.test.mjs", "harness/t3-integration/apply.mjs",
    "packages/rubato-remote-protocol/test/codec.test.ts"]) {
    await writeFile(join(repo, path), "edited while the engine builds\n");
    assert.equal(await inputFingerprint(repo, inputs), initial, path);
  }
  await writeFile(join(repo, "harness/skills/demo/NEW.md"), "new\n");
  assert.equal(await inputFingerprint(repo, inputs), initial);
});

test("editing a build input changes the fingerprint, including sources reached only by path", async (t) => {
  for (const path of ["harness/rubato-pi/src/transforms/cursor-read-image.mjs", "harness/rubato-pi/data/speed-index-baseline-v0.json",
    "harness/scripts/kiro-setup.sh", "packages/model-core/src/model-label.mjs", "LICENSE.md", "bun.lock",
    "harness/pi-runtime/features/providers/patches.mjs", "harness/pi-runtime/package.json",
    "packages/rubato-remote-protocol/src/codec.ts"]) {
    const { repo, inputs } = await repoFixture(t);
    const initial = await inputFingerprint(repo, inputs);
    await writeFile(join(repo, path), "changed\n");
    assert.notEqual(await inputFingerprint(repo, inputs), initial, path);
  }
});

test("a new non-test file in the pi-runtime tree or a removed input is a change", async (t) => {
  const { repo, inputs } = await repoFixture(t);
  const initial = await inputFingerprint(repo, inputs);
  // Features that walk their directory (codemode, media-tools) would stage it.
  await mkdir(join(repo, "harness/pi-runtime/features/codemode/src"), { recursive: true });
  await writeFile(join(repo, "harness/pi-runtime/features/codemode/src/new.ts"), "new\n");
  assert.notEqual(await inputFingerprint(repo, inputs), initial);
  const other = await repoFixture(t);
  const before = await inputFingerprint(other.repo, other.inputs);
  await rm(join(other.repo, "harness/scripts/kiro-setup.sh"));
  assert.notEqual(await inputFingerprint(other.repo, other.inputs), before);
});

test("the during-build guard compares the start snapshot with disk for the inputs only", async (t) => {
  const { repo, inputs } = await repoFixture(t);
  const snapshot = await snapshotSources(repo);
  await writeFile(join(repo, "harness/skills/demo/SKILL.md"), "another session\n");
  await writeFile(join(repo, "harness/pi-runtime/test/fixture.mjs"), "another session\n");
  assert.equal(await inputFingerprint(repo, inputs), snapshotFingerprint(snapshot, inputs), "unread edits do not abort");
  await writeFile(join(repo, "harness/rubato-pi/src/transforms/cursor-read-image.mjs"), "another session\n");
  assert.notEqual(await inputFingerprint(repo, inputs), snapshotFingerprint(snapshot, inputs), "an edited input aborts");
});

test("an input outside the snapshotted roots fails loudly instead of being ignored", async (t) => {
  const { repo } = await repoFixture(t);
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs/read-by-build.md"), "doc\n");
  const inputs = await describeSourceInputs(repo, ["docs/read-by-build.md"]);
  assert.throws(() => snapshotFingerprint({ entries: new Map(), trees: new Map(inputs.trees.map((tree) => [tree, []])),
    covers: (rel) => !rel.includes("/") || rel.startsWith("harness/") }, inputs), /outside the snapshotted roots/);
});

test("an unknown sourceInputs version is never current", async (t) => {
  const { repo, inputs } = await repoFixture(t);
  assert.equal(await inputFingerprint(repo, { ...inputs, version: 99 }), null);
});
