import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { STOCK_PI_PACKAGES, STOCK_PI_VERSION } from "../resolve-runtime.mjs";
import { stagePiRuntime } from "../stage-runtime.mjs";

const CODE = "#!/usr/bin/env node\nexport const marker = 'stock';\n";
const digest = (source) => createHash("sha256").update(source).digest("hex");

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "rubato-pi-stage-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = join(parent, "source");
  await mkdir(sourceRoot);
  const manifest = { name: "fixture", private: true, dependencies: { [STOCK_PI_PACKAGES[0]]: STOCK_PI_VERSION } };
  const lock = { lockfileVersion: 3, packages: { "": manifest } };
  await writeFile(join(sourceRoot, "package.json"), JSON.stringify(manifest));
  for (const name of STOCK_PI_PACKAGES) {
    lock.packages[`node_modules/${name}`] = {
      version: STOCK_PI_VERSION,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${STOCK_PI_VERSION}.tgz`,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    };
    const root = join(sourceRoot, "node_modules", name);
    await mkdir(join(root, "dist", "bundle"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name,
      version: STOCK_PI_VERSION,
      type: "module",
      main: "./dist/index.js",
      exports: { ".": { import: "./dist/index.js" }, "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" } },
      bin: { pi: "dist/bundle/cli.js" },
    }));
    for (const path of ["dist/index.js", "dist/cli.js", "dist/rpc-entry.js", "dist/bundle/cli.js", "dist/bundle/rpc-entry.js"]) {
      await writeFile(join(root, path), CODE);
    }
  }
  await writeFile(join(sourceRoot, "package-lock.json"), JSON.stringify(lock));
  return { sourceRoot, outputRoot: join(parent, "output"), parent };
}

function patch(id, apply, overrides = {}) {
  return {
    id,
    packageName: "@earendil-works/pi-coding-agent",
    version: STOCK_PI_VERSION,
    path: "dist/index.js",
    preimageSha256: digest(CODE),
    apply,
    ...overrides,
  };
}

test("stage keeps pristine source and records selected hooks on unbundled entries", async (t) => {
  const input = await fixture(t);
  const result = await stagePiRuntime({ ...input, features: [{ id: "test", patches: [patch("marker", (text) => text.replace("stock", "adapted"))] }] });
  assert.equal(result.receipt.state, "ready");
  assert.equal(result.receipt.fullRubatoParity, false);
  assert.equal(result.receipt.entryMode, "unbundled");
  assert.match(result.receipt.cliEntry, /\/dist\/cli\.js$/);
  assert.doesNotMatch(result.receipt.rpcEntry, /bundle/);
  const target = "node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  assert.equal(await readFile(join(input.sourceRoot, target), "utf8"), CODE);
  assert.equal(await readFile(join(input.outputRoot, target), "utf8"), CODE.replace("stock", "adapted"));
  assert.equal(result.receipt.files[0].after, digest(CODE.replace("stock", "adapted")));
  assert.equal(JSON.parse(await readFile(join(input.outputRoot, "rubato-pi-stage.json"), "utf8")).state, "ready");
  assert.equal(result.receipt.lockedPackages.length, 6);
  assert.equal(result.receipt.binShims.length, 3);
  for (const shim of result.receipt.binShims) {
    const text = await readFile(join(input.outputRoot, shim.path), "utf8");
    assert.match(text, /dist[\\/]cli\.js/);
    assert.doesNotMatch(text, /bundle/);
    assert.equal(digest(text), shim.sha256);
  }
});

test("different hooks on one file validate against pristine bytes then compose in order", async (t) => {
  const input = await fixture(t);
  const features = [
    { id: "first", patches: [patch("one", (text) => text.replace("stock", "first"))] },
    { id: "second", patches: [patch("two", (text) => text.replace("first", "second"))] },
  ];
  const { receipt } = await stagePiRuntime({ ...input, features });
  assert.equal(receipt.files.length, 1);
  assert.deepEqual(receipt.files[0].patches, ["first/one", "second/two"]);
  assert.equal(receipt.files[0].before, digest(CODE));
  assert.equal(receipt.files[0].after, digest(CODE.replace("stock", "second")));
});

test("hash drift, invalid target, and inert patch fail before creating output", async (t) => {
  const input = await fixture(t);
  for (const bad of [
    patch("hash", (text) => `${text}// changed`, { preimageSha256: "0".repeat(64) }),
    patch("traversal", (text) => text, { path: "../../outside.js" }),
    patch("inert", (text) => text),
    patch("version", (text) => `${text}// changed`, { version: "0.84.2" }),
  ]) {
    await assert.rejects(stagePiRuntime({ ...input, features: [{ id: "invalid", patches: [bad] }] }));
    assert.equal(existsSync(input.outputRoot), false);
  }
});

test("existing output is never reused or overwritten", async (t) => {
  const input = await fixture(t);
  await mkdir(input.outputRoot);
  const owned = join(input.outputRoot, "keep.txt");
  await writeFile(owned, "user-owned");
  await assert.rejects(stagePiRuntime(input), { code: "EEXIST" });
  assert.equal(await readFile(owned, "utf8"), "user-owned");
  assert.equal(existsSync(join(input.outputRoot, "node_modules")), false);
});

test("output may not be inside the source installation or its ancestor", async (t) => {
  const input = await fixture(t);
  await assert.rejects(stagePiRuntime({ ...input, outputRoot: join(input.sourceRoot, "nested") }), /separate/);
  await assert.rejects(stagePiRuntime({ ...input, outputRoot: dirname(input.sourceRoot) }), /separate/);
});

test("duplicate feature ids fail before writing output", async (t) => {
  const input = await fixture(t);
  await assert.rejects(stagePiRuntime({ ...input, features: [{ id: "same", patches: [] }, { id: "same", patches: [] }] }), /unique ids/);
  assert.equal(existsSync(input.outputRoot), false);
});

test("lock drift is rejected before any output exists", async (t) => {
  const input = await fixture(t);
  const lockPath = join(input.sourceRoot, "package-lock.json");
  const pristine = JSON.parse(await readFile(lockPath, "utf8"));
  const name = STOCK_PI_PACKAGES[0];
  for (const mutate of [
    (lock) => { delete lock.packages[""]; },
    (lock) => { lock.packages[""].dependencies[name] = "^0.85.1"; },
    (lock) => { lock.packages[`node_modules/${name}`].version = "0.84.2"; },
    (lock) => { lock.packages[`node_modules/${name}`].resolved = "file:elsewhere"; },
    (lock) => { delete lock.packages[`node_modules/${name}`].integrity; },
    (lock) => { lock.packages[`node_modules/${name}`].dependencies = { uninstalled: "1.0.0" }; },
  ]) {
    const lock = structuredClone(pristine);
    mutate(lock);
    await writeFile(lockPath, JSON.stringify(lock));
    await assert.rejects(stagePiRuntime(input), /lock/);
    assert.equal(existsSync(input.outputRoot), false);
  }
});

test("relative dependency symlinks survive; escaping links fail before output", async (t) => {
  const input = await fixture(t);
  const modules = join(input.sourceRoot, "node_modules");
  await symlink("@earendil-works/pi-ai", join(modules, "local-alias"));
  await stagePiRuntime(input);
  assert.equal(await readlink(join(input.outputRoot, "node_modules/local-alias")), "@earendil-works/pi-ai");
  const second = await fixture(t);
  await symlink(second.parent, join(second.sourceRoot, "node_modules/escape"));
  await assert.rejects(stagePiRuntime(second), /symlink/);
  assert.equal(existsSync(second.outputRoot), false);
});

test("all npm platform shims replace stale bundled targets", async (t) => {
  const input = await fixture(t);
  const bin = join(input.sourceRoot, "node_modules/.bin");
  await mkdir(bin);
  for (const suffix of ["", ".cmd", ".ps1"]) {
    await writeFile(join(bin, `pi${suffix}`), "old dist/bundle/cli.js");
  }
  await stagePiRuntime(input);
  for (const suffix of ["", ".cmd", ".ps1"]) {
    const text = await readFile(join(input.outputRoot, `node_modules/.bin/pi${suffix}`), "utf8");
    assert.match(text, /dist[\\/]cli\.js/);
    assert.doesNotMatch(text, /bundle/);
    assert.equal(await readFile(join(bin, `pi${suffix}`), "utf8"), "old dist/bundle/cli.js");
  }
});

test("relocated symlinks cannot send staged patch writes back to pristine source", async (t) => {
  const input = await fixture(t);
  const dist = join(input.sourceRoot, "node_modules/@earendil-works/pi-coding-agent/dist");
  const backing = join(dist, "backing.js");
  await writeFile(backing, CODE);
  await unlink(join(dist, "index.js"));
  // In source this resolves inside the package, but verbatim in output it would
  // resolve back to source. Checking only the source realpath misses that.
  await symlink("../../../../../source/node_modules/@earendil-works/pi-coding-agent/dist/backing.js", join(dist, "index.js"));
  await assert.rejects(stagePiRuntime({ ...input, features: [{
    id: "probe", patches: [patch("marker", (text) => text.replace("stock", "probe-change"))],
  }] }), /symlink/);
  assert.equal(await readFile(backing, "utf8"), CODE);
  assert.equal(JSON.parse(await readFile(join(input.outputRoot, "rubato-pi-stage.json"), "utf8")).state, "failed");
});
