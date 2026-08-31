import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../src/bootstrap.mjs";
import { claimLaunchDescriptor, OneTimeLaunchBroker } from "../src/launch-handoff.mjs";

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab";
const LIVE_ID = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab";
const ZMX_NAME = "rubato-018f0c7b2f3b";

test("one-time descriptor contains only socket coordinates and token", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rubato-handoff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const broker = new OneTimeLaunchBroker({ directory, ttlMs: 2_000 });
  const payload = {
    schemaVersion: 1,
    liveSessionId: LIVE_ID,
    hostId: HOST_ID,
    zmxName: ZMX_NAME,
    labels: { app: "rubato" },
    cwd: directory,
    argv: ["sensitive prompt"],
    env: { SECRET: "memory-only" },
    launcherPath: "/rubato",
    zmxBinary: "/zmx",
    hubSocket: "/tmp/hub.sock",
    surfaceToken: "a".repeat(64),
  };
  const prepared = await broker.prepare(payload);
  const descriptorText = readFileSync(prepared.descriptorPath, "utf8");
  const descriptor = JSON.parse(descriptorText);
  assert.equal(statSync(prepared.descriptorPath).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(descriptor).sort(), ["schemaVersion", "socketPath", "token"]);
  assert.doesNotMatch(descriptorText, /SECRET|memory-only|sensitive prompt/);
  assert.deepEqual(await claimLaunchDescriptor(prepared.descriptorPath), payload);
  await prepared.consumed;
  await assert.rejects(() => claimLaunchDescriptor(prepared.descriptorPath), /ENOENT/);
});

test("bootstrap labels its assigned zmx session and execs the existing launcher in place", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "rubato-bootstrap-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const labels = {
    app: "rubato",
    rubato_protocol: "1",
    rubato_live_id: LIVE_ID,
    rubato_host_id: HOST_ID,
    rubato_build_id: "abc",
  };
  const payload = {
    schemaVersion: 1,
    liveSessionId: LIVE_ID,
    hostId: HOST_ID,
    zmxName: ZMX_NAME,
    cwd,
    argv: ["--session", join(cwd, "session.jsonl")],
    env: { PATH: "/usr/bin", CUSTOM: "yes", ZMX_SESSION: "wrong" },
    launcherPath: "/rubato/rubato-pi.sh",
    zmxBinary: "/pinned/zmx",
    hubSocket: "/tmp/rubato-hub.sock",
    surfaceToken: "a".repeat(64),
    labels,
  };
  const calls = { labels: [], chdir: [], exec: [] };
  const sentinel = new Error("exec sentinel");
  await assert.rejects(
    () => runBootstrap("descriptor", {
      claim: async () => payload,
      env: { ZMX_SESSION: ZMX_NAME },
      zmxFactory(binary, nextEnv) {
        assert.equal(binary, "/pinned/zmx");
        assert.equal(nextEnv.ZMX_NO_DETACH_KEY, "1");
        return { setLabels(name, values) { calls.labels.push({ name, values }); } };
      },
      chdir(path) { calls.chdir.push(path); },
      execve(path, args, nextEnv) { calls.exec.push({ path, args, nextEnv }); throw sentinel; },
    }),
    (error) => error === sentinel,
  );
  assert.deepEqual(calls.labels, [{ name: ZMX_NAME, values: labels }]);
  assert.deepEqual(calls.chdir, [cwd]);
  assert.deepEqual(calls.exec[0].args, ["/rubato/rubato-pi.sh", "direct", "--session", join(cwd, "session.jsonl")]);
  assert.equal(calls.exec[0].nextEnv.ZMX_SESSION, ZMX_NAME);
  assert.equal(calls.exec[0].nextEnv.RUBATO_LIVE_SESSION_ID, LIVE_ID);
  assert.equal(calls.exec[0].nextEnv.RUBATO_HOST_ID, HOST_ID);
  assert.equal(calls.exec[0].nextEnv.RUBATO_HUB_SOCKET, "/tmp/rubato-hub.sock");
  assert.equal(calls.exec[0].nextEnv.RUBATO_SURFACE_TOKEN, "a".repeat(64));
  assert.equal(calls.exec[0].nextEnv.CUSTOM, "yes");
});
