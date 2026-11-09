// A work card: the chat's card for a conversation another one started or forked (session_create,
// session_fork in harness/pi-runtime/features/session-link/tools.mjs). It shows how that
// conversation is doing now — working, waiting for the person, done, failed or stopped — with
// its title, model and last update, and opens it (RubatoWorkCard.tsx, work-card-edits.mjs).
//
// The launched conversation is a thread like any other: the inventory imports a session the engine
// started within seconds (RubatoPiInventory.ts), so its state is the thread shell the client
// already keeps live. Until that thread is found the card says it is starting; it never claims
// an outcome it has not seen.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import type { SegnoLaunch } from "../../state/rubatoCompanion";

export const LAUNCH_TOOL_KINDS: Readonly<Record<string, "create" | "fork">> = {
  session_create: "create",
  session_fork: "fork",
};

/** What the call says about the conversation it launched. */
export interface RubatoLaunch {
  readonly tool: "create" | "fork";
  /** Null while the call runs, and when it failed. */
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly model: string | null;
  /** A fork without a first message waits for the person; anything else starts working at once. */
  readonly startsWork: boolean;
  /** The call itself failed: no conversation was started. */
  readonly error: string | null;
  /** The call still runs. */
  readonly pending: boolean;
  /** When the call returned (ms); null while it runs or when unknown. */
  readonly launchedAt: number | null;
}

/**
 * `idle`: the thread shows no run of its own — the engine finished (or never ran) it before the app
 * imported it — so the card names no outcome it has not seen.
 */
export type WorkCardState = "starting" | "working" | "waiting" | "done" | "failed" | "stopped" | "idle";

/** How long after its launch a conversation with no run yet still counts as starting. */
export const START_GRACE_MS = 90_000;

/**
 * The new conversation's id, title and model from a launch call's result text: it opens with
 * `Created "<title>" (<id>)` or `Forked into "<title>" (<id>)` and ends with the engine's JSON.
 */
export function launchResultOf(text: string): { sessionId: string; title: string | null; model: string | null } | null {
  const json = text.indexOf("\n{");
  if (json >= 0) {
    try {
      const parsed = JSON.parse(text.slice(json + 1)) as Record<string, unknown>;
      if (typeof parsed.sessionId === "string" && parsed.sessionId !== "")
        return {
          sessionId: parsed.sessionId,
          title: typeof parsed.title === "string" ? parsed.title : null,
          model: typeof parsed.model === "string" ? parsed.model : null,
        };
    } catch {
      // Cut short: the first line still names it.
    }
  }
  const head = /^(?:Created|Forked into) "([^]*?)" \(([^()\s]+)\)/.exec(text);
  return head ? { sessionId: head[2]!, title: head[1]!, model: null } : null;
}

/** The text of a tool item's output: a plain string, or MCP-style content blocks. */
export function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && Array.isArray((output as { content?: unknown }).content))
    return ((output as { content: ReadonlyArray<unknown> }).content)
      .map((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  return "";
}

const stringField = (value: unknown, key: string): string | null => {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof field === "string" && field.trim() !== "" ? field : null;
};

/** Whether a turn item is a launch call; the timeline shows it as a card (session-logic.ts). */
export function isRubatoLaunchItem(item: Pick<OrchestrationV2TurnItem, "type"> & { readonly toolName?: string | null }): boolean {
  return item.type === "dynamic_tool" && typeof item.toolName === "string" && item.toolName in LAUNCH_TOOL_KINDS;
}

/**
 * The launch a lead thread's tool item is, or null for any other item. The timeline withholds a
 * tool's output until it is asked for (turnItemNeedsDetailFetch); `outputPending` says that ask is
 * still out, so a finished call reads as starting until its result names the conversation.
 */
export function rubatoLaunchOfItem(item: OrchestrationV2TurnItem, options: { outputPending?: boolean } = {}): RubatoLaunch | null {
  if (item.type !== "dynamic_tool" || item.toolName === null || !(item.toolName in LAUNCH_TOOL_KINDS)) return null;
  const tool = LAUNCH_TOOL_KINDS[item.toolName]!;
  const input = item.input;
  const text = toolOutputText(item.output);
  const failed = item.status === "failed" || item.status === "interrupted" || item.status === "cancelled";
  const pending = !failed && (item.status !== "completed" || options.outputPending === true);
  const result = failed || pending ? null : launchResultOf(text);
  return {
    tool,
    sessionId: result?.sessionId ?? null,
    title: result?.title ?? stringField(input, "title"),
    model: result?.model ?? stringField(input, "model"),
    startsWork: tool === "create" || stringField(input, "text") !== null,
    error: failed
      ? text.trim() || (options.outputPending ? "" : "The conversation did not start.")
      : !pending && result === null ? "The result names no conversation." : null,
    pending,
    launchedAt: item.completedAt ? Date.parse(String(item.completedAt)) || null : null,
  };
}

/** The launch a companion's room read from its session file (bridge companion/inner.mjs). */
export function rubatoLaunchOfSegno(launch: SegnoLaunch): RubatoLaunch {
  const pending = launch.done === null && launch.error === null;
  return {
    tool: launch.tool,
    sessionId: launch.sessionId,
    title: launch.title,
    model: launch.model,
    startsWork: launch.startsWork !== false,
    error: launch.error ?? (!pending && launch.sessionId === null ? "The result names no conversation." : null),
    pending,
    launchedAt: launch.done,
  };
}

type ShellState = Pick<
  EnvironmentThreadShell,
  "runtime" | "latestRun" | "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest"
>;

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * How the launched conversation is doing, from its thread (null while the thread is not found). Only a
 * run the thread shows says it finished, failed or stopped: the messages a fork or an import brings
 * along are no proof that the requested work ran.
 */
export function workCardState(
  launch: Pick<RubatoLaunch, "error" | "pending" | "startsWork" | "launchedAt">,
  shell: ShellState | null,
  now: number = Date.now(),
): WorkCardState {
  if (launch.error !== null) return "failed";
  if (launch.pending || shell === null) return "starting";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || (shell.pendingSubagentRequest ?? null) !== null) return "waiting";
  if (shell.runtime !== null && ACTIVE.has(shell.runtime.status)) return "working";
  if (shell.runtime?.status === "failed") return "failed";
  const run = shell.latestRun;
  if (run !== null) {
    if (ACTIVE.has(run.status)) return "working";
    if (run.status === "completed") return "done";
    if (run.status === "failed") return "failed";
    return "stopped";
  }
  // No run yet: a fork without a message is ready for the person; otherwise the inventory shows the
  // first run within seconds, and past that the card says only that nothing runs.
  if (!launch.startsWork) return "waiting";
  return launch.launchedAt === null || now - launch.launchedAt < START_GRACE_MS ? "starting" : "idle";
}

export const WORK_CARD_WORDS: Record<WorkCardState, string> = {
  starting: "Starting",
  working: "Working",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Not running",
};

/** "anthropic/claude-opus-5-5-sub" → "opus-5-5-sub": the model id without its vendor. */
export function workCardModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const id = model.split("/").at(-1) ?? model;
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "") || null;
}

/** The latest moment the thread moved: its run's end or start, its runtime, else the shell. */
export function workCardUpdatedAt(shell: Pick<EnvironmentThreadShell, "latestRun" | "runtime" | "updatedAt"> | null): string | null {
  if (shell === null) return null;
  const times = [shell.latestRun?.completedAt, shell.latestRun?.startedAt, shell.runtime?.updatedAt, shell.updatedAt]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
