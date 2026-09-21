import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { PI_PACKAGES, PI_VERSION, resolvePiRuntime } from "../resolve-runtime.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 레지스트리 tarball 의 SRI. 락이 진짜 값을 들고 있는지 보는 독립 기준이라
// 락에서 읽으면 동어반복이 된다 — 그래서 손으로 박는다.
//
// **핀을 올릴 때 여기도 같이 갱신해야 한다.** `pi-coding-agent` 의
// `npm-shrinkwrap.json` 이 형제 패키지들을 integrity 없이 싣기 때문에
// `npm install` 로는 락에 이 값이 안 채워지고, 채우는 사람이 여기를 잊으면
// 이 테스트가 낡은 값을 들고 조용히 통과한다 (2026-09-20 0.86.1 에서 실측).
// 값은 `curl -sL $(npm view <pkg>@<ver> dist.tarball) | openssl dgst -sha512 -binary | openssl base64 -A`.
const expectedIntegrity = {
  "@earendil-works/chord":
    "sha512-GzUr5n4tFBHUYxN9CjcRHK8QWo9tbxNrZu6iWPQ+PFiFrLASvSZOKeAVAgh3gHv/t0X5OvUpFlrMQ/nEFfCYpg==",
  "@earendil-works/pi-agent-core":
    "sha512-8TbBzhYsDeu5V1Zl2NsyrBqJAzX1EiEL3Np3ZjGpy0pSDdGRVOpcyW1qruLqfWmEqGcnxmvgnTMLS/wJNZO2XQ==",
  "@earendil-works/pi-ai":
    "sha512-1XHhI6D/fyQdsBieHC/E/4zGKVOoGe4yDyX67VXvzoYkFsX/qE7NpZE7E1RC8e6Bz8B9oG/P+MQFXikv2/BGEg==",
  "@earendil-works/pi-telemetry":
    "sha512-SOcEqOS3oVGgKeahs2jHB906d8hFjuLP+RBee8xKYMRgw5KAeWHNg+YABfL0ALlp3Bt6tW4b632MLghc3vnTog==",
  "@earendil-works/pi-tui":
    "sha512-FU/zU/zG4RWokcZt+BVXXcieWi5ggvYnWP2kkB5XXjMaHRoy5BDhcZJ9JAnLTN9MwrCRoXgPQxOI0bFqwYeZkQ==",
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
    assert.equal(entry.version, PI_VERSION, packageName);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${packageName}/-/${packageName.split("/")[1]}-${PI_VERSION}.tgz`);
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
  assert.deepEqual(Object.keys(runtime.packages), PI_PACKAGES);

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
      version: PI_VERSION,
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
      assert.equal(result.stdout.trim(), PI_VERSION, label);
      assert.equal(result.stderr, "", label);
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
