import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PiRuntimeResolutionError,
  STOCK_PI_PACKAGES,
  STOCK_PI_VERSION,
  resolvePiRuntime,
} from "../resolve-runtime.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const installedRuntimeRoot = resolve(testDir, "..");
const disposableRoots = new Set();

test.afterEach(() => {
  for (const root of disposableRoots) rmSync(root, { recursive: true, force: true });
  disposableRoots.clear();
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "rubato-pi-runtime-test-"));
  disposableRoots.add(root);
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(packageDir, manifest, entries = ["dist/index.js"]) {
  writeJson(join(packageDir, "package.json"), manifest);
  for (const entry of entries) {
    const entryPath = join(packageDir, entry);
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(entryPath, "export {};\n");
  }
}

function packageDir(modulesDir, packageName) {
  return join(modulesDir, ...packageName.split("/"));
}

function makeStockFixture() {
  const root = tempRoot();
  const modulesDir = join(root, "node_modules");
  const codingDir = packageDir(modulesDir, "@earendil-works/pi-coding-agent");
  const suiteModulesDir = join(codingDir, "node_modules");

  writePackage(
    codingDir,
    {
      name: "@earendil-works/pi-coding-agent",
      version: STOCK_PI_VERSION,
      type: "module",
      main: "./dist/index.js",
      exports: {
        ".": { import: "./dist/index.js" },
        "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" },
      },
      bin: { pi: "dist/bundle/cli.js" },
    },
    [
      "dist/index.js",
      "dist/bundle/cli.js",
      "dist/bundle/rpc-entry.js",
      "dist/cli.js",
      "dist/rpc-entry.js",
    ],
  );

  for (const packageName of STOCK_PI_PACKAGES.slice(1)) {
    const manifest = {
      name: packageName,
      version: STOCK_PI_VERSION,
      type: "module",
      main: "./dist/index.js",
    };
    if (packageName !== "@earendil-works/pi-tui") {
      manifest.exports = { ".": { import: "./dist/index.js" } };
    }
    writePackage(packageDir(suiteModulesDir, packageName), manifest);
  }

  return root;
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectResolutionError(code) {
  return (error) => error instanceof PiRuntimeResolutionError && error.code === code;
}

test("resolves the installed stock 0.85.1 distribution and keeps stock and patchable entries distinct", () => {
  const runtime = resolvePiRuntime({ root: installedRuntimeRoot });

  assert.equal(runtime.version, STOCK_PI_VERSION);
  assert.equal(runtime.root, installedRuntimeRoot);
  assert.match(runtime.sdkEntry, /pi-coding-agent\/dist\/index\.js$/);
  assert.match(runtime.cliEntry, /pi-coding-agent\/dist\/bundle\/cli\.js$/);
  assert.match(runtime.rpcEntry, /pi-coding-agent\/dist\/bundle\/rpc-entry\.js$/);
  assert.match(runtime.patchableCliEntry, /pi-coding-agent\/dist\/cli\.js$/);
  assert.match(runtime.patchableRpcEntry, /pi-coding-agent\/dist\/rpc-entry\.js$/);
  assert.notEqual(runtime.cliEntry, runtime.patchableCliEntry);
  assert.notEqual(runtime.rpcEntry, runtime.patchableRpcEntry);
  assert.deepEqual(Object.keys(runtime.packages), STOCK_PI_PACKAGES);

  for (const packageName of STOCK_PI_PACKAGES) {
    assert.equal(runtime.packages[packageName].name, packageName);
    assert.equal(runtime.packages[packageName].version, STOCK_PI_VERSION);
    assert.ok(runtime.packages[packageName].packageJsonPath.startsWith(`${runtime.root}/node_modules/`));
  }
});

test("follows Node dependency resolution through the coding-agent nested node_modules", () => {
  const root = makeStockFixture();
  const runtime = resolvePiRuntime({ root });

  assert.equal(runtime.root, realpathSync(root));
  assert.match(
    runtime.packages["@earendil-works/pi-ai"].packageJsonPath,
    /pi-coding-agent\/node_modules\/@earendil-works\/pi-ai\/package\.json$/,
  );
});

test("rejects a Senpi alias installed under a stock package specifier", () => {
  const root = makeStockFixture();
  const manifestPath = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/package.json",
  );
  const manifest = readManifest(manifestPath);
  writeJson(manifestPath, { ...manifest, name: "@code-yeongyu/senpi-ai" });

  assert.throws(
    () => resolvePiRuntime({ root }),
    (error) => {
      assert.equal(error.code, "PI_RUNTIME_PACKAGE_IDENTITY_MISMATCH");
      assert.equal(error.details.packageName, "@earendil-works/pi-ai");
      assert.equal(error.details.actualName, "@code-yeongyu/senpi-ai");
      return true;
    },
  );
});

test("rejects a mixed stock Pi suite version", () => {
  const root = makeStockFixture();
  const manifestPath = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/package.json",
  );
  const manifest = readManifest(manifestPath);
  writeJson(manifestPath, { ...manifest, version: "0.84.2" });

  assert.throws(() => resolvePiRuntime({ root }), expectResolutionError("PI_RUNTIME_VERSION_MISMATCH"));
});

test("rejects package resolution that climbs outside the standalone root", () => {
  const outerRoot = makeStockFixture();
  const nestedRoot = join(outerRoot, "nested-runtime");
  mkdirSync(join(nestedRoot, "node_modules"), { recursive: true });

  assert.throws(
    () => resolvePiRuntime({ root: nestedRoot }),
    expectResolutionError("PI_RUNTIME_PACKAGE_OUTSIDE_ROOT"),
  );
});

test("rejects a node_modules symlink that escapes the standalone root", () => {
  const externalRoot = makeStockFixture();
  const root = tempRoot();
  symlinkSync(join(externalRoot, "node_modules"), join(root, "node_modules"), "dir");

  assert.throws(
    () => resolvePiRuntime({ root }),
    expectResolutionError("PI_RUNTIME_NODE_MODULES_OUTSIDE_ROOT"),
  );
});

test("rejects different physical copies selected by two suite dependency edges", () => {
  const root = makeStockFixture();
  const coreDir = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core",
  );
  writePackage(packageDir(join(coreDir, "node_modules"), "@earendil-works/pi-ai"), {
    name: "@earendil-works/pi-ai",
    version: STOCK_PI_VERSION,
    type: "module",
    main: "./dist/index.js",
    exports: { ".": { import: "./dist/index.js" } },
  });

  assert.throws(
    () => resolvePiRuntime({ root }),
    expectResolutionError("PI_RUNTIME_DEPENDENCY_DIVERGENCE"),
  );
});

test("rejects a changed public CLI distribution entry", () => {
  const root = makeStockFixture();
  const manifestPath = join(root, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const manifest = readManifest(manifestPath);
  writeJson(manifestPath, { ...manifest, bin: { pi: "dist/cli.js" } });

  assert.throws(() => resolvePiRuntime({ root }), expectResolutionError("PI_RUNTIME_EXPORT_MISMATCH"));
});

test("reports an absent SDK declaration instead of leaking a path TypeError", () => {
  const root = makeStockFixture();
  const manifestPath = join(root, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const manifest = readManifest(manifestPath);
  writeJson(manifestPath, {
    ...manifest,
    exports: { ...manifest.exports, ".": {} },
  });

  assert.throws(() => resolvePiRuntime({ root }), expectResolutionError("PI_RUNTIME_EXPORT_MISMATCH"));
});

test("rejects a package entry that is not a regular file", () => {
  const root = makeStockFixture();
  const entryPath = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
  );
  rmSync(entryPath);
  mkdirSync(entryPath);

  assert.throws(() => resolvePiRuntime({ root }), expectResolutionError("PI_RUNTIME_ENTRY_INVALID"));
});
