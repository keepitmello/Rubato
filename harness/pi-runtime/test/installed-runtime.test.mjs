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
// 1.0.1 ships no npm-shrinkwrap.json, so pi's siblings are hoisted next to it and only our
// lock pins them. Values are the registry's dist.integrity for 1.0.1.
const expectedIntegrity = {
  "@earendil-works/chord":
    "sha512-woq15kjUZ38fUIMqFrFzTeT0fYYM0CfGS2ELCUE5Ufni32tdxfs0Av2+zz8PXFNxyiC3SB1EnyGPp63CLtp8Fg==",
  "@earendil-works/pi-agent-core":
    "sha512-os85rJM2hgCOOLdtcQ5WxRRhAbQiTNq9+48/pj6dOUU7czJhU8NTdHmDs41hBfAXR/ZQgstIgrjowEICEXimbQ==",
  "@earendil-works/pi-ai":
    "sha512-eSA53pdfDLuQTTJn3yz1VC8BBmcX33OKkk8WihOXdVBvbgqqC4zuR6Sf+TeeWuAmh8LuqARoK14R1s2HZqVcsw==",
  "@earendil-works/pi-codemode":
    "sha512-RpZKpdKceYmIODfqKLJtZWUvfkbDGmEHxEEEYN+i21OFm8uY0sTcBMP4oaLf6SkBVBMPae1Z9GtW27+dIRAYPw==",
  "@earendil-works/pi-mcp":
    "sha512-XuhcCpNT9FgsMQTzjmwy2hbakg9CODcDHtC+KeHfr37HjKdj4QsfOrOThxLXYRN4kmC5HDvFyLzthAnHe/T4jw==",
  "@earendil-works/pi-telemetry":
    "sha512-SuJ/4KyqZ6j6Whlau710DmusWDKMWCxKXpWqZclY/Cl3tGUuX8IFmbTbW2VRoVuoJpZYVMg6DJmt1mwHMUt9uw==",
  "@earendil-works/pi-tui":
    "sha512-Rk/pWLoDKWI7WvywhLxf+DTYppS7XWTN5IacpqlD+QF+CbrT/y5CCnAHqPEoF41y+XtQJKbNjjzUuJE4yq0Dfg==",
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

test("lock pins hoisted stock Pi integrity and the Windows shim generator", () => {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(runtimeRoot, "package-lock.json"), "utf8"));

  for (const [packageName, integrity] of Object.entries(expectedIntegrity)) {
    const path = `node_modules/${packageName}`;
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
