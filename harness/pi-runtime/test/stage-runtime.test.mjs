import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  assert.deepEqual(result.receipt.directDependencies.map(({ name }) => name), [STOCK_PI_PACKAGES[0]]);
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

test("root runtime dependencies must actually be installed with their pinned identity", async (t) => {
  for (const scenario of ["missing", "wrong-version", "alias", "outside", "range"]) {
    const input = await fixture(t);
    const manifestPath = join(input.sourceRoot, "package.json");
    const lockPath = join(input.sourceRoot, "package-lock.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    const name = "fixture-dependency";
    manifest.dependencies[name] = scenario === "range" ? "^1.0.0" : "1.0.0";
    lock.packages[""].dependencies = manifest.dependencies;
    lock.packages[`node_modules/${name}`] = {
      version: "1.0.0", resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(lockPath, JSON.stringify(lock));
    if (scenario !== "missing") {
      const packageRoot = scenario === "outside"
        ? join(input.parent, "node_modules", name)
        : join(input.sourceRoot, "node_modules", name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({
        name: scenario === "alias" ? "different-dependency" : name,
        version: scenario === "wrong-version" ? "2.0.0" : "1.0.0",
        main: "index.js",
      }));
      await writeFile(join(packageRoot, "index.js"), "module.exports = {};\n");
    }
    await assert.rejects(stagePiRuntime(input), /direct dependency|lock identity/, scenario);
    assert.equal(existsSync(input.outputRoot), false, scenario);
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

test("owned modules are added separately from stock hooks with hashes and working imports", async (t) => {
  const input = await fixture(t);
  const sourcePath = join(input.parent, "state.mjs");
  const code = "export let count = 0; export const increment = () => ++count;\n";
  await writeFile(sourcePath, code);
  const file = { packageName: STOCK_PI_PACKAGES[0], version: STOCK_PI_VERSION, path: "dist/rubato-features/counter/state.mjs", sourcePath };
  const staged = await stagePiRuntime({ ...input, features: [{ id: "counter", patches: [], files: [file] }] });
  assert.equal(staged.receipt.files.length, 0);
  assert.equal(staged.receipt.addedFiles.length, 1);
  const added = staged.receipt.addedFiles[0];
  assert.equal(added.feature, "counter");
  assert.equal(added.sha256, digest(code));
  assert.equal(existsSync(join(input.sourceRoot, added.path)), false);
  const state = await import(pathToFileURL(join(input.outputRoot, added.path)));
  assert.equal(state.increment(), 1);
  assert.equal(state.increment(), 2);
  assert.equal(await readFile(sourcePath, "utf8"), code);
});

test("owned executable file permissions and receipt stay identical under a restrictive umask", async (t) => {
  const input = await fixture(t);
  const sourcePath = join(input.parent, "worker.mjs");
  await writeFile(sourcePath, "#!/usr/bin/env node\nexport {};\n");
  await chmod(sourcePath, 0o755);
  const previous = process.umask(0o077);
  try {
    const { receipt } = await stagePiRuntime({ ...input, features: [{ id: "worker", patches: [], files: [{
      target: "runtime", version: STOCK_PI_VERSION, path: "rubato-features/worker/main.mjs", sourcePath,
    }] }] });
    assert.equal(receipt.addedFiles[0].mode, 0o755);
    assert.equal((await stat(join(input.outputRoot, receipt.addedFiles[0].path))).mode & 0o777, 0o755);
  } finally {
    process.umask(previous);
  }
});

test("added files reject overwrites, duplicates, traversal, and invalid sources before output", async (t) => {
  const input = await fixture(t);
  const sourcePath = join(input.parent, "owned.mjs");
  await writeFile(sourcePath, "export {};\n");
  const file = { packageName: STOCK_PI_PACKAGES[0], version: STOCK_PI_VERSION, path: "dist/rubato-features/owned.mjs", sourcePath };
  for (const files of [
    [{ ...file, path: "dist/index.js" }],
    [file, file],
    [{ ...file, path: "../../outside.mjs" }],
    [{ ...file, version: "0.84.2" }],
    [{ ...file, sourcePath: "relative.mjs" }],
    [{ ...file, sourcePath: input.parent }],
  ]) {
    await assert.rejects(stagePiRuntime({ ...input, features: [{ id: "invalid", patches: [], files }] }));
    assert.equal(existsSync(input.outputRoot), false);
  }
});

test("an added module cannot follow an ancestor symlink into another package", async (t) => {
  const input = await fixture(t);
  const packageDir = join(input.sourceRoot, "node_modules", STOCK_PI_PACKAGES[0]);
  await symlink("../../pi-ai/dist", join(packageDir, "dist/bridge"));
  const sourcePath = join(input.parent, "owned.mjs");
  await writeFile(sourcePath, "export {};\n");
  await assert.rejects(stagePiRuntime({ ...input, features: [{ id: "escape", patches: [], files: [{
    packageName: STOCK_PI_PACKAGES[0], version: STOCK_PI_VERSION, path: "dist/bridge/unsafe.mjs", sourcePath,
  }] }] }), /parent escapes/);
  assert.equal(existsSync(input.outputRoot), false);
  assert.equal(existsSync(join(input.sourceRoot, "node_modules/@earendil-works/pi-ai/dist/unsafe.mjs")), false);
});

test("independent runtime modules resolve root dependencies instead of Pi's nested versions", async (t) => {
  const input = await fixture(t);
  for (const [parent, version] of [[input.sourceRoot, "new"], [join(input.sourceRoot, "node_modules", STOCK_PI_PACKAGES[0]), "pi-nested"]]) {
    const dependency = join(parent, "node_modules/fixture-schema");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "fixture-schema", type: "module", exports: "./index.mjs" }));
    await writeFile(join(dependency, "index.mjs"), `export const version = ${JSON.stringify(version)};\n`);
  }
  const sourcePath = join(input.parent, "consumer.mjs");
  await writeFile(sourcePath, 'export { version } from "fixture-schema";\n');
  const result = await stagePiRuntime({ ...input, features: [{ id: "independent", patches: [], files: [{
    target: "runtime", version: STOCK_PI_VERSION, path: "rubato-features/independent/consumer.mjs", sourcePath,
  }] }] });
  const added = result.receipt.addedFiles[0];
  assert.equal(added.target, "runtime");
  assert.equal(added.path, "rubato-features/independent/consumer.mjs");
  const consumer = await import(pathToFileURL(join(input.outputRoot, added.path)));
  assert.equal(consumer.version, "new");
  const nested = await import(pathToFileURL(join(input.outputRoot, "node_modules", STOCK_PI_PACKAGES[0], "node_modules/fixture-schema/index.mjs")));
  assert.equal(nested.version, "pi-nested");
});

test("runtime-owned files cannot escape their feature namespace or claim a package too", async (t) => {
  const input = await fixture(t);
  const sourcePath = join(input.parent, "owned.mjs");
  await writeFile(sourcePath, "export {};\n");
  const file = { target: "runtime", version: STOCK_PI_VERSION, path: "rubato-features/owned/test.mjs", sourcePath };
  for (const bad of [
    { ...file, path: "node_modules/new/other.mjs" },
    { ...file, path: "rubato-features/elsewhere/other.mjs" },
    { ...file, path: "rubato-features/owned/../../other.mjs" },
    { ...file, packageName: STOCK_PI_PACKAGES[0] },
  ]) {
    await assert.rejects(stagePiRuntime({ ...input, features: [{ id: "owned", patches: [], files: [bad] }] }));
    assert.equal(existsSync(input.outputRoot), false);
  }
});
