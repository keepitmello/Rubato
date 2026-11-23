import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("T3 checks use the pin and remove the isolated checkout on success and failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rubato-t3-runner-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const source = join(root, "source");
  const scratch = join(root, "scratch");
  mkdirSync(source);
  mkdirSync(scratch);
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(source, "marker"), "pinned");
  git("add", "marker");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "pin");
  writeFileSync(join(root, "upstream.json"), JSON.stringify({ upstreamCommit: git("rev-parse", "HEAD") }));
  writeFileSync(join(source, "marker"), "running desktop");
  mkdirSync(join(source, "node_modules"));
  const runner = join(root, "with-test-tree.sh");
  copyFileSync(new URL("../with-test-tree.sh", import.meta.url), runner);
  writeFileSync(join(root, "apply.mjs"), `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    writeFileSync(join(process.argv[3], "overlay"), "applied");
  `);
  const before = git("worktree", "list", "--porcelain");
  for (const exit of [0, 19]) {
    const result = spawnSync("bash", [runner, "--", "bash", "-ec", `
      test "$(cat marker)" = pinned
      test "$(cat overlay)" = applied
      test ! -e node_modules
      mkdir node_modules
      exit "$1"
    `, "test", String(exit)], { env: { ...process.env, TMPDIR: scratch, RUBATO_T3_SOURCE: source }, encoding: "utf8" });
    assert.equal(result.status, exit, result.stderr);
    assert.deepEqual(readdirSync(scratch), []);
    assert.equal(git("worktree", "list", "--porcelain"), before);
    assert.equal(readFileSync(join(source, "marker"), "utf8"), "running desktop");
  }
});
