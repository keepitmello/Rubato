import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dispatchSource = fileURLToPath(new URL("../../../scripts/rubato-dispatch.sh", import.meta.url));

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "rubato-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "rubato-dispatch.sh"), readFileSync(dispatchSource));
  chmodSync(join(scripts, "rubato-dispatch.sh"), 0o755);
  const argsPath = join(root, "args.txt");
  const stdinPath = join(root, "stdin.txt");
  const cwdPath = join(root, "cwd.txt");
  writeFileSync(
    join(scripts, "rubato-pi.sh"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$RUBATO_TEST_ARGS"\npwd > "$RUBATO_TEST_CWD"\ncat > "$RUBATO_TEST_STDIN"\nprintf 'worker-ok\\n'\n`,
  );
  chmodSync(join(scripts, "rubato-pi.sh"), 0o755);
  const home = join(root, "home");
  mkdirSync(home);
  return {
    root,
    home,
    run(args, input = "", extraEnv = {}) {
      return spawnSync(join(scripts, "rubato-dispatch.sh"), args, {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          RUBATO_TEST_ARGS: argsPath,
          RUBATO_TEST_STDIN: stdinPath,
          RUBATO_TEST_CWD: cwdPath,
          ...extraEnv,
        },
        input,
        encoding: "utf8",
      });
    },
    args() {
      return readFileSync(argsPath, "utf8").trimEnd().split("\n");
    },
    stdin() {
      return readFileSync(stdinPath, "utf8");
    },
    cwd() {
      return readFileSync(cwdPath, "utf8").trim();
    },
  };
}

test("default lane is grok and stdout is the worker's final answer", (t) => {
  const box = harness(t);
  const result = box.run(["job-a"], "find the leak\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "worker-ok\n");
  assert.deepEqual(box.args(), [
    "--print",
    "--session-dir",
    join(box.home, ".rubato-pi", "agent", "dispatch", "job-a"),
    "--name",
    "job-a",
    "--model",
    "xai/grok-4.6",
  ]);
  assert.equal(box.stdin(), "find the leak\n");
});

test("grokfast selects the Cursor Fast wire id", (t) => {
  const box = harness(t);
  const result = box.run(["fast-job", "grokfast"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.args().at(-1), "cursor/cursor-grok-4.6-high-fast");
});

test("--continue resumes the named session without changing the model", (t) => {
  const box = harness(t);
  const result = box.run(["job-a", "--continue"], "one more thing\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.args(), [
    "--print",
    "--session-dir",
    join(box.home, ".rubato-pi", "agent", "dispatch", "job-a"),
    "--name",
    "job-a",
    "--continue",
  ]);
});

test("--cwd is the worker process directory", (t) => {
  const box = harness(t);
  const work = join(box.root, "work");
  mkdirSync(work);
  const result = box.run(["job-a", "--cwd", work]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.cwd(), work);
});

test("agent dir env owns the session folder", (t) => {
  const box = harness(t);
  const agent = join(box.root, "custom-agent");
  const result = box.run(["job-a"], "hi\n", { RUBATO_PI_CODING_AGENT_DIR: agent });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.args()[2], join(agent, "dispatch", "job-a"));
});

test("invalid names and unknown lanes fail before launch", (t) => {
  const box = harness(t);
  assert.equal(box.run(["../escape"]).status, 2);
  assert.equal(box.run(["job-a", "unknown-lane"]).status, 2);
  assert.throws(() => box.args(), /ENOENT/);
});
