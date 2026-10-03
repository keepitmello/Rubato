import type { DreamRunSummary, MemoryStoreSummary } from "../../state/rubatoMemory";

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
