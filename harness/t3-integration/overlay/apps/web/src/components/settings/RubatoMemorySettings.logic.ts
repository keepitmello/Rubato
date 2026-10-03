import type { DreamRunDetail, DreamRunSummary, MemoryStoreSummary } from "../../state/rubatoMemory";

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
 * What a new thread about a memory starts with: where it is, the file or dream run asked about, and
 * how to change it. The question itself is left for the user to type.
 */
export function chatPrompt(
  store: Pick<MemoryStoreSummary, "store" | "repo">,
  about: { readonly file?: string; readonly run?: Pick<DreamRunDetail, "runId" | "sources"> } = {},
): string {
  const lines = [`About the \`${store.store}\` memory (\`${store.repo}\`). Change it with the memory tools, so every edit is committed with its reason.`];
  if (about.file) lines.push(`- The file: \`${about.file}\``);
  if (about.run) {
    lines.push(`- The dream run \`${about.run.runId}\``);
    if (about.run.sources.report) lines.push(`- Its report: ${about.run.sources.report}`);
    if (about.run.sources.range)
      lines.push(`- What it changed: \`git -C ${store.repo} diff ${about.run.sources.range.base} ${about.run.sources.range.head}\``);
  }
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

/** How a run reads in the history: what it did to memory, not only how the run ended. */
export function runLabel(
  run: Pick<DreamRunSummary, "status" | "review" | "landed">,
): { label: string; variant: BadgeVariant } {
  if (run.review === "reverted") return { label: "Undone", variant: "secondary" };
  if (run.review === "rejected") return { label: "Discarded", variant: "secondary" };
  if (run.landed) return { label: "Changed memory", variant: "success" };
  switch (run.status) {
    case "noop":
      return { label: "Nothing to change", variant: "secondary" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case "busy":
      return { label: "Skipped", variant: "secondary" };
    case "trial":
      return { label: "Trial", variant: "info" };
    // Runs from before dreams landed on their own, never approved.
    case "pending":
      return { label: "Not applied", variant: "secondary" };
    default:
      return { label: run.status, variant: "outline" };
  }
}

/** One line on a project's row about its daily dream: off, never ran, or how the last run went. */
export function lastDreamLine(
  enabled: boolean,
  lastRun: MemoryStoreSummary["lastRun"],
  ago: (iso: string) => string,
): { text: string; tone: "muted" | "error" } {
  const when = lastRun ? ago(lastRun.finishedAt ?? lastRun.startedAt ?? "") : null;
  if (!enabled) return { text: when ? `Daily dream off · last ran ${when}` : "Daily dream off", tone: "muted" };
  if (!lastRun || when === null) return { text: "Daily dream on · has not run yet", tone: "muted" };
  if (lastRun.status === "failed")
    return { text: `Last dream ${when} failed: ${(lastRun.reason ?? "").split("\n")[0]}`, tone: "error" };
  if (lastRun.landed) return { text: `Last dream ${when} changed memory`, tone: "muted" };
  return { text: `Last dream ${when}: nothing to change`, tone: "muted" };
}

/** Why a run ended on a later model: the models before it that failed. Null when the first one answered. */
export function fallbackNote(attempts: DreamRunSummary["attempts"]): string | null {
  const failed = attempts.filter((attempt) => !attempt.ok);
  if (failed.length === 0) return null;
  const last = attempts.at(-1);
  const names = failed.map((attempt) => attempt.model).join(", ");
  return last?.ok ? `Fell back after ${names} failed` : `Every model failed: ${names}`;
}
