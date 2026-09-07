import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { STOCK_PI_PACKAGES, STOCK_PI_VERSION, resolvePiRuntime } from "../resolve-runtime.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expectedIntegrity = {
  "@earendil-works/chord":
    "sha512-VDlkEC3dhCzQ5fcyH1OhG19dq+6jCn+rqc/iXFivwDYGR5anwo2RCiXij9PpHhqNR5GuhhE+Er69Zi1Sn4eY6w==",
  "@earendil-works/pi-agent-core":
    "sha512-hIXIP3eAWueAYiAl8aMvWCvvZ8Q5gT3Dip5bE5uJyIGh4+YlWRjtMLI4BaeoXoSs93zndjue61u1B/vhefLnuA==",
  "@earendil-works/pi-ai":
    "sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==",
  "@earendil-works/pi-telemetry":
    "sha512-Bg/YN6kA7Swja/NQxka8xFdecb4E/auIEGF2G5A25EaQXhRnPj300/7/KpgsDDMYUzHTDAv4RyUxaQPJKW81Rw==",
  "@earendil-works/pi-tui":
    "sha512-OIzw9efInmO4WOBnD4TxcTdBjmzvYJpzslkgoUro946nEGoYWg5rwv1p4fDt3/JvMx9QybryUCUwlm7j8Dreig==",
};

function cleanEnv(profile) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: profile };
  delete env.NODE_OPTIONS;
  return env;
}

function runNode(args, profile) {
  return spawnSync(process.execPath, args, {
    cwd: runtimeRoot,
    encoding: "utf8",
    env: cleanEnv(profile),
    timeout: 10_000,
  });
}

function assertSuccess(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${label}: terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
}

test("lock pins nested stock Pi integrity and the Windows shim generator", () => {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(runtimeRoot, "package-lock.json"), "utf8"));

  for (const [packageName, integrity] of Object.entries(expectedIntegrity)) {
    const path = `node_modules/@earendil-works/pi-coding-agent/node_modules/${packageName}`;
    const entry = lock.packages[path];
    assert.equal(entry.version, STOCK_PI_VERSION, packageName);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${packageName}/-/${packageName.split("/")[1]}-0.85.1.tgz`);
    assert.equal(entry.integrity, integrity, packageName);
  }

  assert.equal(manifest.dependencies["cmd-shim"], "8.0.0");
  assert.deepEqual(lock.packages["node_modules/cmd-shim"], {
    version: "8.0.0",
    resolved: "https://registry.npmjs.org/cmd-shim/-/cmd-shim-8.0.0.tgz",
    integrity:
      "sha512-Jk/BK6NCapZ58BKUxlSI+ouKRbjH1NLZCgJkYoab+vEHUY3f6OzpNBN9u7HFSv9J6TRDGs4PLOHezoKGaFRSCA==",
    license: "ISC",
    engines: { node: "^20.17.0 || >=22.9.0" },
  });
});

test("installed runtime exposes one coherent stock suite and an importable SDK", () => {
  const runtime = resolvePiRuntime({ root: runtimeRoot });
  assert.deepEqual(Object.keys(runtime.packages), STOCK_PI_PACKAGES);

  const profile = realpathSync(mkdtempSync(join(tmpdir(), "rubato-pi-sdk-profile-")));
  try {
    const result = runNode(
      [
        "--input-type=module",
        "-e",
        'const sdk = await import(process.argv[1]); process.stdout.write(JSON.stringify({ version: sdk.VERSION, createAgentSession: typeof sdk.createAgentSession, discoverAndLoadExtensions: typeof sdk.discoverAndLoadExtensions }));',
        pathToFileURL(runtime.sdkEntry).href,
      ],
      profile,
    );
    assertSuccess(result, "SDK import");
    assert.deepEqual(JSON.parse(result.stdout), {
      version: STOCK_PI_VERSION,
      createAgentSession: "function",
      discoverAndLoadExtensions: "function",
    });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test("bundled and unbundled CLI/RPC entries report the selected stock version", () => {
  const runtime = resolvePiRuntime({ root: runtimeRoot });
  const profile = realpathSync(mkdtempSync(join(tmpdir(), "rubato-pi-entry-profile-")));

  try {
    for (const [label, entry] of [
      ["bundled CLI", runtime.cliEntry],
      ["unbundled CLI", runtime.patchableCliEntry],
      ["bundled RPC", runtime.rpcEntry],
      ["unbundled RPC", runtime.patchableRpcEntry],
    ]) {
      const result = runNode([entry, "--version"], profile);
      assertSuccess(result, label);
      assert.equal(result.stdout.trim(), STOCK_PI_VERSION, label);
      assert.equal(result.stderr, "", label);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
