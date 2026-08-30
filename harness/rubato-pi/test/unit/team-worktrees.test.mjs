import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isGitWorktree } from "../../src/worktree.mjs";
import { provisionSpecWorktrees } from "../../src/team-worktrees.mjs";

test("fills worktreePath with a real git worktree per member", async () => {
  const root = mkdtempSync(join(tmpdir(), "rubato-pi-spec-wt-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "wt@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "wt"], { cwd: repo });
  writeFileSync(join(repo, "README"), "ok\n");
  spawnSync("git", ["add", "README"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
  const spec = await provisionSpecWorktrees(
    { members: [{ name: "owner-a" }] },
    { repo, destRoot: join(root, "trees") },
  );
  assert.equal(isGitWorktree(spec.members[0].worktreePath), true);
});
