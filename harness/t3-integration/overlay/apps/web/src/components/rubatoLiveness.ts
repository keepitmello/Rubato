/**
 * Whether an agent is alive, one rule for the status board (RubatoStatusBoardPage) and the Agents
 * panel (RubatoAgentsPanel), over the facts the server reads off disk (Rubato's
 * src/status-board/scan.mjs):
 *
 *   lifecycle      live | ended | failed | stopped | lost (its process died or it was evicted)
 *   turnOpen       its transcript ends inside a turn
 *   lastActivityAt when its transcript last grew (session_read's lastActivityAt)
 *
 *   lost/ended/failed/stopped          → that, whatever the record says
 *   live, turn open, quiet < threshold → working
 *   live, turn open, quiet ≥ threshold → stalled
 *   live, turn closed                  → resting (waiting for a message or its own job)
 *
 * The time rule lives here, not on the server, because the page counts between polls.
 */
export const STALL_AFTER_MS = 5 * 60_000;

export type Lifecycle = "live" | "ended" | "failed" | "stopped" | "lost";
export type Liveness = "working" | "stalled" | "resting" | "done" | "failed" | "stopped" | "lost";

export interface LivenessFacts {
  readonly lifecycle: Lifecycle;
  readonly turnOpen: boolean;
  readonly lastActivityAt: number | null;
}

export function livenessOf(facts: LivenessFacts, now: number): Liveness {
  switch (facts.lifecycle) {
    case "lost":
      return "lost";
    case "ended":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      break;
  }
  if (!facts.turnOpen) return "resting";
  // Never heard from at all: nothing says it is working.
  if (facts.lastActivityAt === null) return "stalled";
  return now - facts.lastActivityAt >= STALL_AFTER_MS ? "stalled" : "working";
}

/** Still something to watch: its run has not ended. */
export function isOnBoard(liveness: Liveness): boolean {
  return liveness === "working" || liveness === "stalled" || liveness === "resting";
}

/** "12s ago", "3m ago", "2h ago", "4d ago": the dictionary reads these as "12초 전" and so on. */
export function formatAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** How each state reads and looks. The colors are the Agents panel's: blue works, a ring rests. */
export const LIVENESS_VISUALS: Record<
  Liveness,
  { readonly label: string; readonly dotClass: string; readonly textClass: string }
> = {
  working: { label: "Working", dotClass: "bg-info animate-pulse", textClass: "text-info-foreground" },
  stalled: { label: "Stalled", dotClass: "bg-warning", textClass: "text-warning-foreground" },
  resting: {
    label: "Waiting",
    dotClass: "bg-transparent ring-1 ring-inset ring-muted-foreground",
    textClass: "text-muted-foreground",
  },
  done: { label: "Done", dotClass: "bg-success", textClass: "text-success-foreground" },
  failed: { label: "Failed", dotClass: "bg-destructive", textClass: "text-destructive-foreground" },
  stopped: { label: "Stopped", dotClass: "bg-muted-foreground/50", textClass: "text-muted-foreground" },
  lost: { label: "Lost", dotClass: "bg-destructive/70", textClass: "text-destructive-foreground" },
};

export interface LivenessCounts {
  readonly working: number;
  readonly stalled: number;
  readonly resting: number;
  readonly lost: number;
  readonly ended: number;
}

export function countLiveness(states: ReadonlyArray<Liveness>): LivenessCounts {
  let working = 0;
  let stalled = 0;
  let resting = 0;
  let lost = 0;
  let ended = 0;
  for (const state of states) {
    if (state === "working") working += 1;
    else if (state === "stalled") stalled += 1;
    else if (state === "resting") resting += 1;
    else if (state === "lost") lost += 1;
    else ended += 1;
  }
  return { working, stalled, resting, lost, ended };
}
