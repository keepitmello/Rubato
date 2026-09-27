import type { DreamRunDetail, DreamRunSummary } from "../../state/rubatoMemory";

/** Just what matching needs from an app project. */
export interface ProjectLike {
  readonly workspaceRoot: string;
}

/**
 * The app project a store's conversation belongs in: one opened at a folder the store serves, else
 * one opened inside such a folder (the shallowest). A store with no known folder has none.
 */
export function projectForStore<P extends ProjectLike>(
  projects: readonly P[],
  roots: readonly string[] | null,
): P | null {
  if (!roots || roots.length === 0) return null;
  const exact = projects.find((project) => roots.includes(project.workspaceRoot));
  if (exact) return exact;
  const inside = projects.filter((project) =>
    roots.some((root) => project.workspaceRoot.startsWith(`${root}/`)),
  );
  return inside.toSorted((a, b) => a.workspaceRoot.length - b.workspaceRoot.length)[0] ?? null;
}

/**
 * What a new thread about a dream starts with: where its report and changes are, and the file when
 * the question is about one. The question itself is left for the user to type.
 */
export function askPrompt(detail: DreamRunDetail, file?: string): string {
  const state = detail.pending ? "is waiting for review" : detail.landed ? "landed in the store" : "ran";
  const lines = [`A dream on the \`${detail.store}\` memory store ${state} (run \`${detail.runId}\`).`];
  if (detail.sources.report) lines.push(`- Report: ${detail.sources.report}`);
  if (detail.sources.range)
    lines.push(
      `- Changes: \`git -C ${detail.sources.repo} diff ${detail.sources.range.base} ${detail.sources.range.head}\``,
    );
  if (file) lines.push(`- About the file: \`${file}\``);
  if (detail.uncommitted.length > 0)
    lines.push(
      `- The store has edits nobody committed, which block adding or undoing: ${detail.uncommitted.map((path) => `\`${path}\``).join(", ")}`,
    );
  return `${lines.join("\n")}\n\n`;
}

/** The text of a file a diff adds, front matter left out. */
export function addedContent(diff: string): string {
  const rows = diff.split("\n");
  const start = rows.findIndex((row) => row.startsWith("@@"));
  if (start === -1) return "";
  const text = rows
    .slice(start + 1)
    .filter((row) => row.startsWith("+"))
    .map((row) => row.slice(1))
    .join("\n");
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export type BadgeVariant = "success" | "warning" | "error" | "info" | "secondary" | "outline";

/** How a run reads in the history: where its edits are now, not only how the run ended. */
export function runLabel(
  run: Pick<DreamRunSummary, "status" | "review" | "pending" | "landed">,
): { label: string; variant: BadgeVariant } {
  if (run.pending) return { label: "Needs review", variant: "warning" };
  if (run.review === "reverted") return { label: "Undone", variant: "secondary" };
  if (run.review === "rejected") return { label: "Discarded", variant: "secondary" };
  if (run.landed) return { label: "In memory", variant: "success" };
  switch (run.status) {
    case "noop":
      return { label: "No changes", variant: "secondary" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case "busy":
      return { label: "Already running", variant: "secondary" };
    case "trial":
      return { label: "Trial", variant: "info" };
    case "pending":
      return { label: "Closed", variant: "secondary" };
    default:
      return { label: run.status, variant: "outline" };
  }
}
