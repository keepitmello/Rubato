import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadPiFeatures } from "../../feature-catalog.mjs";
import { stagePiRuntime } from "../../stage-runtime.mjs";
import { resolvePiRuntime } from "../../resolve-runtime.mjs";
import { patches } from "./patches.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "../..");
test("session transport is additive, version-pinned and rejects patch drift", async () => {
  const { codingAgentDir } = resolvePiRuntime({ root: sourceRoot });
  for (const patch of patches) {
    const original = await readFile(path.join(codingAgentDir, patch.path), "utf8");
    assert.equal(createHash("sha256").update(original).digest("hex"), patch.preimageSha256);
    const changed = patch.apply(original);
    assert.throws(() => patch.apply(changed), /anchor mismatch/);
    if (patch.path.endsWith("rpc-mode.js")) {
      assert.ok(changed.includes("if (!transport) takeOverStdout();"));
      assert.ok(changed.includes("if (!transport) registerSignalHandlers();"));
    }
  }
});

test("real SDK sessions keep RPC questions, streams, abort and shutdown independent", { timeout: 60000 }, async (t) => {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "rb-session-transport-")));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stage = await stagePiRuntime({ sourceRoot, outputRoot: path.join(scratch, "stage"),
    features: await loadPiFeatures(["session-transport"]) });
  const home = path.join(scratch, "home");
  await mkdir(home);
  let executable = process.execPath;
  let args = [path.join(here, "session-transport-fixture.mjs"), stage.root];
  if (process.platform === "darwin") {
    const policy = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "${scratch}") (subpath "/dev"))(deny network*)(deny signal)(allow signal (target self))`;
    args = ["-p", policy, executable, ...args];
    executable = "/usr/bin/sandbox-exec";
  }
  const child = spawn(executable, args, { cwd: home, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, PI_OFFLINE: "1", NODE_NO_WARNINGS: "1",
      PI_CODING_AGENT_DIR: path.join(home, "agent") } });
  let output = "";
  child.stdout.on("data", value => output += value); child.stderr.on("data", value => output += value);
  const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 25000);
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  assert.equal(result.code, 0, output);
  assert.match(output, /SESSION_TRANSPORT_OK/);
});
