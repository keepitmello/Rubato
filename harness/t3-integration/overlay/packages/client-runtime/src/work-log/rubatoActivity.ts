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

export type RubatoActivityKind =
  | "read"
  | "search"
  | "list"
  | "command"
  | "edit"
  | "web"
  | "wait"
  | "other";

export interface RubatoActivity {
  readonly kind: RubatoActivityKind;
  /** The file, pattern, folder, command or URL the call works on. */
  readonly target?: string;
  /** Where a search looks. */
  readonly path?: string;
  /** Files one patch touches, when more than one. */
  readonly count?: number;
  /** The call only keeps the agent's own records (notes, task list); see rubatoPiAnswers. */
  readonly bookkeeping?: true;
}

const KINDS = new Set<string>(["read", "search", "list", "command", "edit", "web", "wait", "other"]);

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
    ...(activity?.bookkeeping === true ? { bookkeeping: true as const } : {}),
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
    // An idle agent waits on its background commands and monitors.
    case "wait":
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
    case "wait":
      // What the agent ended its run on and will be woken by, not thinking.
      return `${running ? "Waiting on" : "Waited on"} ${target ?? "background work"}`;
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

/** One entry of a turn, as the answer rule sees it. */
export interface RubatoAnswerItem {
  readonly id: string;
  readonly kind: "answer" | "thought" | "tool" | "other";
  /** The stored message id, for an answer or a thought. */
  readonly messageId?: string;
  readonly phase?: RubatoAssistantPhase | undefined;
  readonly streaming?: boolean;
  /** A tool that only keeps the agent's own records. */
  readonly bookkeeping?: boolean;
}

// One Pi assistant message is one answer row, and its thought row carries the same key.
const PI_ANSWER_ID = /^assistant:pi:([^:]+:[a-f0-9]{24})$/;
const PI_THOUGHT_ID = /^(?:reasoning:[a-z]+|assistant):pi:([^:]+:[a-f0-9]{24}):/;

/**
 * Which of a turn's Pi answers are commentary and which are final, and which stay
 * in sight once the turn has folded. A message tagged by the bridge says its own
 * phase. One stored before tags ended with tool calls exactly when its tool rows
 * follow it (its own thought may sit between), which is what the tag would have
 * said. Final answers stay; so does a last word that no tool followed, such as
 * commentary cut short by a stop, and an answer that only bookkeeping followed: an
 * agent that writes its answer and then saves its notes or ticks its task list ends
 * that message in a tool call, yet no work came after it. Other providers' messages
 * are not answered here.
 */
export function rubatoPiAnswers(items: ReadonlyArray<RubatoAnswerItem>): {
  readonly phases: ReadonlyMap<string, RubatoAssistantPhase>;
  readonly visible: ReadonlySet<string>;
} {
  const phases = new Map<string, RubatoAssistantPhase>();
  const visible = new Set<string>();
  const lastAnswerIndex = items.findLastIndex((item) => item.kind === "answer");
  const lastWorkIndex = items.findLastIndex((item) => item.kind === "tool" && !item.bookkeeping);
  for (const [index, item] of items.entries()) {
    if (item.kind !== "answer") continue;
    const key = PI_ANSWER_ID.exec(item.messageId ?? "")?.[1];
    if (!key) continue;
    let next = index + 1;
    while (
      items[next]?.kind === "thought" &&
      PI_THOUGHT_ID.exec(items[next]!.messageId ?? "")?.[1] === key
    ) {
      next += 1;
    }
    const followedByTool = items[next]?.kind === "tool";
    if (item.phase === undefined && items[next] === undefined && item.streaming) continue;
    const phase = item.phase ?? (followedByTool ? "commentary" : "final_answer");
    phases.set(item.id, phase);
    if (
      phase === "final_answer" ||
      (!followedByTool && index === lastAnswerIndex) ||
      (followedByTool && index > lastWorkIndex)
    ) {
      visible.add(item.id);
    }
  }
  return { phases, visible };
}
