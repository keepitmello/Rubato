/**
 * The small pieces every agent list draws: status colors and dot, live or ended, elapsed time,
 * the task line and a team's members. The Agents surface (RubatoAgentsPanel) and the thread
 * details' Team and Agents sections (chat/RubatoThreadDetailsAgents) share them. This file
 * stays free of the conversation viewer, so the details panel does not load it.
 */
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type {
  AgentPanelWorkflowGroup,
  RubatoSubagent as RuntimeSubagent,
} from "./rubatoAgentPanelModel";

/** In-flight states all read as Working; only settled states differ. */
export const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  idle: { dotClass: "bg-transparent ring-1 ring-inset ring-muted-foreground", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

export function isLive(status: RuntimeSubagent["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function isSettled(status: RuntimeSubagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
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

/** Live agents self-tick through DOM writes (no React commit per second). */
export function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
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
