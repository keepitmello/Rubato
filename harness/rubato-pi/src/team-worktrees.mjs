import { join } from "node:path";
import { addWorktree } from "./worktree.mjs";

export function memberWorktreeDest(destRoot, memberName) {
  return join(destRoot, memberName);
}

export async function provisionSpecWorktrees(spec, { repo, destRoot }) {
  if (!spec || !Array.isArray(spec.members)) return spec;
  const members = [];
  for (const member of spec.members) {
    const name = member.name;
    const dest = member.worktreePath ?? member.worktree_path ?? memberWorktreeDest(destRoot, name);
    addWorktree({ repo, dest, branch: member.worktreeBranch ?? "HEAD" });
    members.push({ ...member, worktreePath: dest });
  }
  return { ...spec, members };
}
