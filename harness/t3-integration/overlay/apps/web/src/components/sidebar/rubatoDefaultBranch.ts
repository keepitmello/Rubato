// Rubato (polish-edits.mjs): the sidebar card's third line names the branch only
// when it tells threads apart. Nearly every thread runs on the repository's
// default branch, so "main" under every title repeated one word. The repository's
// own default (origin/HEAD) needs a git query per project, so the conventional
// names stand in for it.
const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set(["main", "master"]);

export function isDefaultBranchName(branch: string): boolean {
  return DEFAULT_BRANCH_NAMES.has(branch);
}
