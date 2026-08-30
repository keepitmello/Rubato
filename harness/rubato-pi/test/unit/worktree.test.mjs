import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addWorktree, isGitWorktree, removeWorktree } from "../../src/worktree.mjs";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("provisions a real git worktree and refuses a plain directory", () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-pi-wt-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(["init"], repo);
  git(["config", "user.email", "wt@example.com"], repo);
  git(["config", "user.name", "wt"], repo);
  writeFileSync(join(repo, "README"), "ok\n");
  git(["add", "README"], repo);
  git(["commit", "-m", "init"], repo);
  const dest = join(root, "member");
  addWorktree({ repo, dest, branch: "HEAD" });
  assert.equal(isGitWorktree(dest), true);
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.throws(() => addWorktree({ repo, dest: plain }), /not a git worktree/);
  removeWorktree({ repo, dest });
});
