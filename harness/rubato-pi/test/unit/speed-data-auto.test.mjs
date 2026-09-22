import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { startSpeedDataUpload, MAINTAINER_SPEED_DATA_REPO } from "../../src/speed-data-auto.mjs";
import { syncSpeedData } from "../../scripts/sync-speed-data.mjs";
import { buildActiveEngine } from "../../../scripts/build-active-engine.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "rubato-speed-auto-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agentDir = join(home, "agent");
  const root = join(agentDir, "speed-index");
  const samples = join(root, "samples");
  mkdirSync(samples, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, RUBATO_PI_CODING_AGENT_DIR: agentDir };
  return { home, agentDir, root, samples, env };
}

test("auto starter detaches the existing uploader, passing no shared token and claiming only startup", (t) => {
  const f = fixture(t);
  const child = new EventEmitter();
  child.pid = 123;
  child.unref = () => { child.unrefCalled = true; };
  let launch;
  const result = startSpeedDataUpload({ ...f, node: "/test/node", runner: (...args) => { launch = args; return child; } });
  assert.equal(result.status, "started");
  assert.equal(child.unrefCalled, true);
  assert.equal(launch[0], "/test/node");
  assert.equal(launch[1][launch[1].indexOf("--repo") + 1], MAINTAINER_SPEED_DATA_REPO);
  assert.equal(launch[2].detached, true);
  assert.equal(launch[2].stdio[0], "ignore");
  assert.equal(launch[2].env.RUBATO_SPEED_INDEX, "0");
  assert.equal(launch[2].env.RUBATO_SPEED_INDEX_PROBE, "0");
  assert.equal(launch[2].env.GH_TOKEN, undefined);
  assert.equal(existsSync(join(f.root, "github-sync.json")), false, "starter must not create an identity or outbox");
});

test("test contexts, environment disable, persistent disable and no samples do not start a child", (t) => {
  const f = fixture(t);
  const runner = () => { throw new Error("must not spawn"); };
  assert.equal(startSpeedDataUpload({ ...f, runner, env: { ...f.env, NODE_TEST_CONTEXT: "child-v8" } }).reason, "test");
  assert.equal(startSpeedDataUpload({ ...f, runner, env: { ...f.env, RUBATO_SPEED_DATA_UPLOAD: "0" } }).reason, "disabled");
  writeFileSync(join(f.root, "github-sync.disabled"), "");
  assert.equal(startSpeedDataUpload({ ...f, runner }).reason, "disabled");
  const disabled = syncSpeedData({ repo: MAINTAINER_SPEED_DATA_REPO, samplesDir: f.samples,
    statePath: join(f.root, "github-sync.json"), upload: true, api: runner });
  assert.equal(disabled.mode, "disabled", "persistent stop also covers the existing daily/manual uploader");
  rmSync(join(f.root, "github-sync.disabled"));
  rmSync(f.samples, { recursive: true });
  assert.equal(startSpeedDataUpload({ ...f, runner }).reason, "no_samples");
});

test("spawn failures are local log failures, never thrown into the updater", (t) => {
  const f = fixture(t);
  assert.equal(startSpeedDataUpload({ ...f, runner: () => { throw new Error("private error"); } }).reason, "start_failed");
  const child = new EventEmitter();
  child.unref = () => {};
  const result = startSpeedDataUpload({ ...f, runner: () => child });
  assert.equal(result.reason, "spawn_failed");
  child.emit("error", Object.assign(new Error("SECRET"), { code: "ENOENT" }));
  const log = readFileSync(join(f.root, "github-sync.log"), "utf8");
  assert.match(log, /ENOENT/);
  assert.doesNotMatch(log, /SECRET/);
});

test("a real detached uploader completes with isolated gh and writes only the selected test profile", async (t) => {
  const f = fixture(t);
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(f.samples, "123456-123-aabbccdd.jsonl"), JSON.stringify({
    schemaVersion: 1, epoch: "v1", captureVersion: 1, streamKind: "main",
    at: new Date(Date.now() - 60000).toISOString(), provider: "test", model: "test-model",
    effort: "high", effortSource: "options.reasoning", requestKind: "user",
    clientDurationMs: 100, streamEventCount: 0, streamTerminalObserved: false,
  }) + "\n");
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const {createHash}=require("node:crypto");
const {readFileSync}=require("node:fs");
const a=process.argv.slice(2), method=a[a.indexOf("--method")+1], endpoint=a[a.indexOf("--method")+2];
if(endpoint==="repos/${MAINTAINER_SPEED_DATA_REPO}") {
 console.log(JSON.stringify({full_name:"${MAINTAINER_SPEED_DATA_REPO}",private:true,permissions:{push:true}}));
} else if(method==="GET") {
 console.log(JSON.stringify({status:"404"})); process.exitCode=1;
} else {
 const body=JSON.parse(readFileSync(0,"utf8")), bytes=Buffer.from(body.content,"base64");
 const sha=createHash("sha1").update("blob "+bytes.length+"\\0").update(bytes).digest("hex");
 console.log(JSON.stringify({content:{sha}}));
}
`);
  chmodSync(gh, 0o755);
  let child;
  let exited;
  const env = { ...f.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const result = startSpeedDataUpload({ ...f, env, runner: (...args) => {
    child = spawn(...args);
    exited = once(child, "exit");
    return child;
  } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.equal(result.status, "started");
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [code] = await exited;
    assert.equal(code, 0, readFileSync(join(f.root, "github-sync.log"), "utf8"));
  } finally { clearTimeout(timeout); }
  const report = JSON.parse(readFileSync(join(f.root, "github-sync.log"), "utf8").trim());
  assert.equal(report.records, 1);
  assert.equal(report.uploaded, 1);
  assert.equal(JSON.parse(readFileSync(join(f.root, "github-sync.json"))).pending, null);
});

test("freshly pulled builder supports old updaters; checks, failures and new updater ownership do not upload", async (t) => {
  const f = fixture(t);
  const repo = join(f.home, "repo");
  mkdirSync(repo);
  const calls = [];
  const options = { env: f.env, repoRoot: repo, update: async () => { calls.push("build"); },
    startSpeedData: () => { calls.push("collection"); } };
  assert.equal(await buildActiveEngine({ ...options, args: ["--check"] }), 10);
  assert.deepEqual(calls, []);
  assert.equal(await buildActiveEngine({ ...options, args: ["--force"] }), 0);
  assert.deepEqual(calls, ["build", "collection"]);
  calls.length = 0;
  await buildActiveEngine({ ...options, env: { ...f.env, RUBATO_SPEED_DATA_UPDATE_OWNER: "1" } });
  assert.deepEqual(calls, ["build"]);
  calls.length = 0;
  await assert.rejects(buildActiveEngine({ ...options, update: async () => { throw new Error("build failed"); } }));
  assert.deepEqual(calls, []);
  assert.equal(await buildActiveEngine({ ...options, startSpeedData: () => { throw new Error("collector failed"); } }), 0);
});
