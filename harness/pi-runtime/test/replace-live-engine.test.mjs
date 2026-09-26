// A build that replaces the installed engine restarts the profile engine onto it — once, and
// only when it really replaced something. Every collaborator is a fake: nothing here reaches a
// real profile engine or the real ~/.rubato-pi.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildActiveEngine } from "../../scripts/build-active-engine.mjs";
import { HOSTED_EXIT, replaceLiveEngine } from "../../scripts/replace-live-engine.mjs";
import { installPiEngine } from "../scripts/switch-engine.mjs";
import { sourceFingerprint } from "../scripts/source-fingerprint.mjs";
import { PI_VERSION } from "../pi-version.mjs";

function sink() {
  const sink = { text: "", write(chunk) { sink.text += chunk; return true; } };
  return sink;
}

function recorder({ hosted = false, restartResult = { ok: true, token: "restarted" } } = {}) {
  const calls = [];
  return {
    calls,
    replace: async () => { calls.push("replace"); },
    hostsCaller: async () => { calls.push("host-check"); return hosted; },
    restart: async () => { calls.push("restart"); return restartResult; },
  };
}

test("a replacement restarts the live engine exactly once, after the build", async () => {
  const r = recorder();
  const stderr = sink();
  assert.equal(await replaceLiveEngine({ ...r, env: {}, stderr }), 0);
  assert.deepEqual(r.calls, ["host-check", "replace", "restart"]);
  assert.match(stderr.text, /새 엔진으로 프로필 엔진을 다시 띄웠습니다/);
});

test("no engine to restart is still a clean build and says nothing about restarting", async () => {
  for (const token of ["missing", "dead"]) {
    const r = recorder({ restartResult: { ok: true, token } });
    const stderr = sink();
    assert.equal(await replaceLiveEngine({ ...r, env: {}, stderr }), 0);
    assert.deepEqual(r.calls, ["host-check", "replace", "restart"]);
    assert.equal(stderr.text, "");
  }
});

test("a caller that owns the restart gets the build alone", async () => {
  const r = recorder();
  assert.equal(await replaceLiveEngine({ ...r, env: { RUBATO_PROFILE_RESTART_OWNER: "1" }, stderr: sink() }), 0);
  assert.deepEqual(r.calls, ["replace"]);
});

test("inside a conversation the engine hosts, nothing is built and nothing is restarted", async () => {
  const r = recorder({ hosted: true });
  const stderr = sink();
  assert.equal(await replaceLiveEngine({ ...r, env: {}, stderr }), HOSTED_EXIT);
  assert.deepEqual(r.calls, ["host-check"]);
  assert.match(stderr.text, /다시 만들지 않았습니다/);
  assert.match(stderr.text, /rubato restart/);
});

test("a restart that fails after the build says the old engine is running on the new install", async () => {
  for (const token of ["no-pid", "timeout 4902"]) {
    const r = recorder({ restartResult: { ok: false, token } });
    const stderr = sink();
    assert.equal(await replaceLiveEngine({ ...r, env: {}, stderr }), 1);
    assert.deepEqual(r.calls, ["host-check", "replace", "restart"]);
    assert.match(stderr.text, new RegExp(`다시 띄우지 못했습니다 \\(${token}\\)`));
    assert.match(stderr.text, /옛 코드가 새 설치본 위에서 돌고 있습니다/);
  }
});

test("a failed build restarts nothing", async () => {
  const r = recorder();
  await assert.rejects(replaceLiveEngine({ ...r, replace: async () => { throw new Error("build failed"); }, env: {}, stderr: sink() }));
  assert.deepEqual(r.calls, ["host-check"]);
});

test("build-active-engine: a real rebuild restarts once, a current install and --check restart nothing", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "rubato-replace-live-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  await mkdir(repo);
  const env = { HOME: home };
  const installed = await installPiEngine({ home, env, install: async ({ outputRoot }) => {
    await mkdir(outputRoot, { recursive: true });
    const receipt = { version: 1, state: "ready", stockVersion: PI_VERSION, features: ["fixture"], candidateEntry: "candidate.mjs" };
    await writeFile(join(outputRoot, "candidate.mjs"), "export {};\n");
    await writeFile(join(outputRoot, "rubato-install.json"), JSON.stringify(receipt));
    return { root: outputRoot, receipt };
  } });
  const events = [];
  const opts = {
    env, repoRoot: repo, startSpeedData: () => {},
    update: async () => { events.push("build"); },
    replaceEngine: (options) => replaceLiveEngine({ ...options, stderr: sink(),
      hostsCaller: async () => false, restart: async () => { events.push("restart"); return { ok: true, token: "restarted" }; } }),
  };

  assert.equal(await buildActiveEngine({ ...opts, args: ["--check"] }), 10);
  assert.deepEqual(events, [], "--check never builds or restarts");

  assert.equal(await buildActiveEngine(opts), 0);
  assert.deepEqual(events, ["build", "restart"], "a stale install is rebuilt and the engine restarted once");

  events.length = 0;
  const receipt = { ...installed.receipt, sourceSha256: await sourceFingerprint(repo) };
  await writeFile(join(installed.root, "rubato-install.json"), JSON.stringify(receipt));
  assert.equal(await buildActiveEngine(opts), 0);
  assert.deepEqual(events, [], "a current install is a no-op: no build, no restart");

  assert.equal(await buildActiveEngine({ ...opts, args: ["--force"] }), 0);
  assert.deepEqual(events, ["build", "restart"], "--force is a real rebuild too");

  events.length = 0;
  assert.equal(await buildActiveEngine({ ...opts, args: ["--force"], env: { ...env, RUBATO_PROFILE_RESTART_OWNER: "1" } }), 0);
  assert.deepEqual(events, ["build"], "restart/update own their restart");
});

test("build-active-engine: with no profile engine on this HOME the default restart is a quiet no-op", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "rubato-replace-none-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  await mkdir(repo);
  let builds = 0;
  // The default hostsCaller/restart read <HOME>/.rubato-pi/agent/server/connection.json, which
  // this scratch HOME does not have — so neither loads the pi-server client.
  assert.equal(await buildActiveEngine({ env: { HOME: home }, repoRoot: repo, args: ["--force"],
    startSpeedData: () => {}, update: async () => { builds += 1; } }), 0);
  assert.equal(builds, 1);
});
