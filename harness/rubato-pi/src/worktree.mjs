import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function isGitWorktree(dir) {
  if (!existsSync(dir)) return false;
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function addWorktree({ repo, dest, branch }) {
  if (existsSync(dest) && !isGitWorktree(dest)) {
    throw new Error(`${dest} exists and is not a git worktree`);
  }
  const args = ["worktree", "add", dest];
  if (branch) args.push(branch);
  runGit(args, repo);
  return dest;
}

export function removeWorktree({ repo, dest }) {
  runGit(["worktree", "remove", "--force", dest], repo);
}
