/**
 * Rubato: how a Pi turn's work reads in the thread, in Codex's words.
 *
 * The bridge (harness/t3-integration/src/activity.mjs) tags each tool row with
 * what the call does (`data.rubatoActivity`) and each assistant message with its
 * phase (a `rubato-phase` context record). From those the timeline shows one live
 * line while a group of calls runs ("Reading events.mjs", "Running npm test"), a
 * summary once the group is done ("Read files and ran commands"), and folds the
 * commentary with the work when the turn ends, leaving the final answer.
 */

export type RubatoActivityKind = "read" | "search" | "list" | "command" | "edit" | "web" | "other";

export interface RubatoActivity {
  readonly kind: RubatoActivityKind;
  /** The file, pattern, folder, command or URL the call works on. */
  readonly target?: string;
  /** Where a search looks. */
  readonly path?: string;
  /** Files one patch touches, when more than one. */
  readonly count?: number;
}

const KINDS = new Set<string>(["read", "search", "list", "command", "edit", "web", "other"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Reads the bridge's tag off a tool activity payload's `data`. */
export function rubatoActivityOf(data: unknown): RubatoActivity | undefined {
  const activity = record(record(data)?.rubatoActivity);
  const kind = activity?.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  const target = text(activity?.target);
  const path = text(activity?.path);
  const count = activity?.count;
  return {
    kind: kind as RubatoActivityKind,
    ...(target ? { target } : {}),
    ...(path ? { path } : {}),
    ...(typeof count === "number" && Number.isInteger(count) && count > 1 ? { count } : {}),
  };
}

/** The summary group a call joins: reading, searching and listing are all exploration. */
export function rubatoActivityGroupAction(
  activity: RubatoActivity,
): "read" | "edit" | "command" | "search" | "other" {
  switch (activity.kind) {
    case "read":
    case "search":
    case "list":
      return "read";
    case "edit":
      return "edit";
    case "command":
      return "command";
    case "web":
      return "search";
    case "other":
      return "other";
  }
}

export type RubatoActivityStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The line a call reads as: present tense while it runs ("Reading a.ts"), past
 * once done ("Read a.ts"). `formatPath` shortens file paths for display. Calls
 * the bridge could not name ("other") have no line here; the caller keeps its own.
 */
export function rubatoActivityLabel(
  activity: RubatoActivity,
  status: RubatoActivityStatus,
  formatPath: (path: string) => string = (path) => path,
): string | undefined {
  const running = status === "inProgress";
  const stopped = status === "stopped";
  const target = activity.target ? oneLine(activity.target) : undefined;
  switch (activity.kind) {
    case "read":
      return target
        ? `${running ? "Reading" : "Read"} ${formatPath(target)}`
        : running
          ? "Reading files"
          : "Read files";
    case "search": {
      const where = activity.path ? ` in ${formatPath(activity.path)}` : "";
      if (target) return `${running ? "Searching" : "Searched"} for ${target}${where}`;
      return `${running ? "Searching" : "Searched"} files${where}`;
    }
    case "list":
      return target
        ? `${running ? "Listing" : "Listed"} files in ${formatPath(target)}`
        : running
          ? "Listing files"
          : "Listed files";
    case "command":
      if (!target) return stopped ? "Stopped command" : running ? "Running command" : "Ran command";
      return `${stopped ? "Stopped" : running ? "Running" : "Ran"} ${target}`;
    case "edit":
      if (!target || (activity.count ?? 1) > 1) return running ? "Editing files" : "Edited files";
      return `${running ? "Editing" : "Edited"} ${formatPath(target)}`;
    case "web":
      return target
        ? `${running ? "Searching the web for" : "Searched the web for"} ${target}`
        : running
          ? "Searching the web"
          : "Searched the web";
    case "other":
      return undefined;
  }
}

/** Codex's order for the parts of a completed group's summary. */
const SUMMARY_ORDER: Record<string, number> = {
  other: 0,
  edit: 1,
  read: 2,
  "code-search": 3,
  command: 4,
  search: 5,
};

export function rubatoSummaryOrder(action: string): number {
  return SUMMARY_ORDER[action] ?? 6;
}

/**
 * One part of a completed group's summary, in Codex's words. Counts only choose
 * between singular and plural; they are not shown.
 */
export function rubatoSummaryLabel(action: string, count: number): string | undefined {
  const one = count === 1;
  switch (action) {
    case "read":
      return "Read files";
    case "edit":
      return one ? "Edited a file" : "Edited files";
    case "command":
      return one ? "Ran a command" : "Ran commands";
    case "search":
      return "Searched the web";
    case "code-search":
      return "Searched code";
    case "other":
      return one ? "Called a tool" : "Called tools";
    case "browser":
      return "Used the browser";
    case "device":
      return "Used device controls";
    case "update":
      return one ? "Received an update" : "Received updates";
    default:
      return undefined;
  }
}

export type RubatoAssistantPhase = "commentary" | "final_answer";

/** Written by the server's ingestion (work-log-edits.mjs) from the bridge's `data.rubatoPhase`. */
export const RUBATO_PHASE_CONTEXT_KIND = "rubato-phase";

/** An assistant message's phase, from its `rubato-phase` context record. */
export function rubatoPhaseOf(message: { readonly context?: unknown }): RubatoAssistantPhase | undefined {
  const records = record(message.context)?.records;
  if (!Array.isArray(records)) return undefined;
  for (const item of records) {
    const entry = record(item);
    if (entry?.kind !== RUBATO_PHASE_CONTEXT_KIND) continue;
    const phase = record(entry.payload)?.phase;
    if (phase === "commentary" || phase === "final_answer") return phase;
  }
  return undefined;
}
