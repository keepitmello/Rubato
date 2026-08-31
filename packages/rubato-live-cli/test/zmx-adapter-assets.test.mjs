import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZmxAdapter, fixedRubatoLabels, parseLabels } from "../src/zmx-adapter.mjs";

const HOST_ID = "018f0c7a-2f3b-7c4d-8e5f-1234567890ab";
const LIVE_ID = "018f0c7b-2f3b-7c4d-9e5f-1234567890ab";

test("zmx source, build targets, no-detach environment, and vendored MIT text are pinned", () => {
  const lock = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../third_party/zmx-lock.json"), "utf8"));
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.commit, "0266042ca8f399c9d76825739b93443e2d5bf47a");
  assert.equal(lock.baseRelease, "0.7.1");
  assert.equal(lock.baseReleaseCommit, "1cea103fef83cd53586fcb2c5f90d693fc9f5a30");
  assert.equal(lock.releaseLineRelation, "diverged-not-ancestor");
  assert.equal(lock.describe, "v0.7.0-47-g0266042");
  assert.equal(lock.binaryVersion, "0.7.0");
  assert.equal(lock.buildTool, "zig-0.16.0");
  assert.equal(lock.qualifiedAssets.status, "release-manifest-required");
  assert.equal(lock.qualifiedAssets.reason.includes("not byte-reproducible"), true);
  assert.equal("assets" in lock, false, "unqualified local rebuild hashes must not be pinned");
  assert.equal(lock.environment.ZMX_NO_DETACH_KEY, "1");
  assert.deepEqual(lock.build.targets, { "darwin-arm64": "aarch64-macos", "darwin-x64": "x86_64-macos" });
  const licensePath = resolve(import.meta.dirname, "../../../third_party/zmx/LICENSE");
  assert.equal(createHash("sha256").update(readFileSync(licensePath)).digest("hex"), lock.license.sha256);
  assert.match(readFileSync(licensePath, "utf8"), /Copyright \(c\) 2025 Eric Bower/);
});

test("zmx adapter discovers only protocol-derived Rubato labels", () => {
  const calls = [];
  const labels = fixedRubatoLabels({ liveSessionId: LIVE_ID, hostId: HOST_ID, buildId: "abc" });
  const spawn = (_binary, args, options) => {
    calls.push({ args, options });
    if (args[0] === "list") return { status: 0, stdout: "rubato-018f0c7b2f3b\nforeign\n", stderr: "" };
    if (args[0] === "get") return { status: 0, stdout: Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(" "), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const adapter = new ZmxAdapter({ binary: "/pinned/zmx", spawn, env: { ZMX_SESSION: "rubato-parent", PATH: "/bin" } });
  assert.deepEqual(adapter.reconcile(), [{
    liveSessionId: LIVE_ID,
    zmxName: "rubato-018f0c7b2f3b",
    hostId: HOST_ID,
    buildId: "abc",
    managed: true,
  }]);
  adapter.attach("rubato-018f0c7b2f3b");
  assert.equal(calls.at(-1).options.env.ZMX_SESSION, undefined);
  assert.equal(calls.at(-1).options.env.ZMX_NO_DETACH_KEY, "1");
  assert.deepEqual(parseLabels("a=1 b=two\n"), { a: "1", b: "two" });
});
