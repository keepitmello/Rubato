/**
 * The small pieces every agent list draws: what state an agent is in and how that state looks,
 * live or ended, elapsed time, the task line and a team's members. The Agents surface
 * (RubatoAgentsPanel) and the thread details' Team and Agents sections
 * (chat/RubatoThreadDetailsAgents) share them, so a state reads the same in both. This file
 * stays free of the conversation viewer, so the details panel does not load it.
 */
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type {
  AgentPanelWorkflowGroup,
  RubatoSubagent as RuntimeSubagent,
} from "./rubatoAgentPanelModel";

/**
 * What an agent is doing, as a person reads it:
 * - working: a turn runs (in-flight states all read as one).
 * - background: its turn ended on work of its own that will wake it (a bounded background
 *   command, a monitor that has not reported); `awaiting` names it.
 * - waiting: a team member resting with nothing of its own pending; only a message wakes it.
 * - idle: the same outside a team (resumable with a message).
 * - completed, failed, stopped: it ended.
 */
export type AgentDisplayState =
  | "working"
  | "background"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

export function agentDisplayState(
  agent: Pick<RuntimeSubagent, "status"> & { readonly awaiting?: RuntimeSubagent["awaiting"] },
  inTeam = false,
): AgentDisplayState {
  switch (agent.status) {
    case "pending":
    case "running":
    case "waiting":
      return "working";
    case "idle":
      return (agent.awaiting?.length ?? 0) > 0 ? "background" : inTeam ? "waiting" : "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

const RESTING_RING = "bg-transparent ring-1 ring-inset ring-muted-foreground";
const ON_JOB = "bg-info/30 ring-1 ring-inset ring-info";

/**
 * The one look of each state: the dot in lists, the glyph in the thread details' team strip
 * (fill and motion only; its shape says the role), the label and the word a count uses.
 * Blue says something of the agent's own is under way; a hollow ring says only a message wakes it.
 */
export const AGENT_STATE_VISUALS: Record<
  AgentDisplayState,
  { readonly dotClass: string; readonly glyphClass: string; readonly label: string; readonly countWord: string }
> = {
  working: { dotClass: "bg-info", glyphClass: "bg-info ring-2 ring-info/25 animate-pulse", label: "Working", countWord: "working" },
  background: { dotClass: ON_JOB, glyphClass: ON_JOB, label: "Background job", countWord: "on a job" },
  waiting: { dotClass: RESTING_RING, glyphClass: RESTING_RING, label: "Waiting for instructions", countWord: "waiting" },
  idle: { dotClass: RESTING_RING, glyphClass: RESTING_RING, label: "Idle · resumable", countWord: "idle" },
  completed: { dotClass: "bg-success", glyphClass: "bg-success", label: "Completed", countWord: "done" },
  failed: { dotClass: "bg-destructive", glyphClass: "bg-destructive", label: "Failed", countWord: "failed" },
  stopped: { dotClass: "bg-muted-foreground/60", glyphClass: "bg-muted-foreground/40", label: "Stopped", countWord: "stopped" },
};

/** "2 working", "1 on a job", … in the states' order, nonzero only; each part is its own entry for translation. */
export function stateCountParts(states: ReadonlyArray<AgentDisplayState>): string[] {
  const order = Object.keys(AGENT_STATE_VISUALS) as AgentDisplayState[];
  return order.flatMap((state) => {
    const count = states.filter((value) => value === state).length;
    return count > 0 ? [`${count} ${AGENT_STATE_VISUALS[state].countWord}`] : [];
  });
}

/** The bounded command or monitor a resting agent waits on, with a count of any more. */
export function awaitedWorkLabel(agent: Pick<RuntimeSubagent, "awaiting">): string | null {
  const [first, ...rest] = agent.awaiting;
  if (!first) return null;
  return rest.length > 0 ? `${first.description} +${rest.length}` : first.description;
}

export function isLive(status: RuntimeSubagent["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/** Working, or resting on a job of its own that will wake it: either way something of its own runs. */
export function isUnderWay(agent: Pick<RuntimeSubagent, "status" | "awaiting">): boolean {
  const state = agentDisplayState(agent);
  return state === "working" || state === "background";
}

export function isSettled(status: RuntimeSubagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function StatusDot({ state }: { state: AgentDisplayState }) {
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn("size-1.5 shrink-0 rounded-full", AGENT_STATE_VISUALS[state].dotClass)}
    />
  );
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Live agents self-tick through DOM writes (no React commit per second). A team counts from its
 * start until it ends: all its members resting is still the team's time, not a pause.
 */
export function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live =
    agent.status === "running" ||
    agent.status === "waiting" ||
    (agent.kind === "workflow" && !isSettled(agent.status));
  const startedAt = agent.startedAt;
  useEffect(() => {
    if (!live || !startedAt) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = elapsedBetween(startedAt, null);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);
  if (!startedAt) return null;
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : (agent.completedAt ?? agent.updatedAt))}
    </span>
  );
}

/** First line: the task alone. Old rows without `label` fall back to the title. */
export function agentTaskLabel(agent: RuntimeSubagent): string {
  return agent.label ?? agent.title;
}

export function teamMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}
