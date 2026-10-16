/**
 * The chat's line for a Rubato spawn. On T3's V2 orchestrator an Agent, task or team_create
 * call arrives as a plain tool row; this draws it as the agent (or taskforce) it started,
 * from the roster the Agents panel reads (state/rubatoSessionState.ts), with the panel's row
 * grammar: the task first, then what it is doing or how it ended, then
 * role · model · Speed · turn (RubatoAgentsPanel agentTaskLabel, agentMetaParts).
 */
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { type KeyboardEvent, type SyntheticEvent, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { type RubatoSessionState, usePublishedRubatoSessionState } from "../../state/rubatoSessionState";
import { agentMetaParts, agentTaskLabel, teamCountsLabel } from "../RubatoAgentsPanel";
import { type RubatoSubagent, rubatoAgentsFromSessionState } from "../rubatoAgentPanelModel";

const SPAWN_TOOLS = new Set(["Agent", "task", "team_create"]);

const STATUS_WORD: Record<RubatoSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export type RubatoSpawn =
  | { readonly kind: "agent"; readonly agent: RubatoSubagent }
  | { readonly kind: "team"; readonly team: RubatoSubagent; readonly members: ReadonlyArray<RubatoSubagent> };

/** The spawn call a tool row is, by its Pi call id; null for any other row. */
export function spawnCallId(item: OrchestrationV2TurnItem | undefined): string | null {
  return item?.type === "dynamic_tool" && item.toolName !== null && SPAWN_TOOLS.has(item.toolName)
    ? (item.nativeItemRef?.nativeId ?? null)
    : null;
}

/** The agent or taskforce a spawn call started, once the roster knows it. */
export function rubatoSpawnFor(state: RubatoSessionState, callId: string): RubatoSpawn | null {
  const team = state.teams.find((entry) => entry.spawnToolCallId === callId);
  const agent = state.agents.find((entry) => entry.spawnToolCallId === callId);
  if (!team && !agent) return null;
  const rows = rubatoAgentsFromSessionState(state);
  if (team) {
    const teamRow = rows.find((row) => row.id === team.teamRunId);
    return teamRow
      ? { kind: "team", team: teamRow, members: rows.filter((row) => row.parentAgentId === team.teamRunId) }
      : null;
  }
  const row = rows.find((entry) => entry.id === agent!.taskId);
  return row ? { kind: "agent", agent: row } : null;
}

export function useRubatoSpawn(threadKey: string, item: OrchestrationV2TurnItem | undefined): RubatoSpawn | null {
  const callId = spawnCallId(item);
  const state = usePublishedRubatoSessionState(callId === null ? null : threadKey);
  return useMemo(() => (callId === null ? null : rubatoSpawnFor(state, callId)), [callId, state]);
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function RubatoSpawnRow({ spawn }: { spawn: RubatoSpawn }) {
  const [open, setOpen] = useState(false);
  const agent = spawn.kind === "agent" ? spawn.agent : spawn.team;
  const live = isActiveSubagentStatus(agent.status);
  const activity =
    spawn.kind === "team"
      ? teamCountsLabel(spawn.members, "waiting")
      : live
        ? (agent.progress ?? (agent.lastToolName ? `▸ ${agent.lastToolName}` : null))
        : (agent.error ?? agent.result ?? agent.progress ?? null);
  const durationMs =
    agent.startedAt && agent.completedAt ? Date.parse(agent.completedAt) - Date.parse(agent.startedAt) : null;
  const statusLabel =
    !live && durationMs !== null && durationMs >= 0
      ? agent.status === "completed"
        ? formatDuration(durationMs)
        : `${STATUS_WORD[agent.status]} · ${formatDuration(durationMs)}`
      : STATUS_WORD[agent.status];
  const task = spawn.kind === "team" ? `Taskforce · ${agent.title}` : agentTaskLabel(agent);
  const metaLine = spawn.kind === "agent" ? agentMetaParts(agent).join(" · ") : "";
  const body = activity?.trim() ?? "";
  const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? null;
  const canExpand = body.length > 0 && body !== firstLine;
  const toggle = () => setOpen((value) => !value);

  return (
    <div
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={canExpand ? `${task}, ${statusLabel}` : undefined}
      aria-expanded={canExpand ? open : undefined}
      onClick={canExpand ? toggle : undefined}
      onKeyDown={
        canExpand
          ? (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
              }
            }
          : undefined
      }
      data-rubato-spawn-row={spawn.kind}
      className={cn(
        "flex flex-col rounded-md px-1 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      <div className="flex select-none items-center gap-1.5">
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
          <span className={cn("min-w-0 truncate", agent.status === "failed" ? "text-tool-error-icon/40" : "text-foreground/80")}>
            {task}
          </span>
        </p>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">{statusLabel}</span>
      </div>
      {!open && firstLine ? <p className="truncate text-xs text-muted-foreground">{firstLine}</p> : null}
      {metaLine ? (
        <p className="truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">{metaLine}</p>
      ) : null}
      {open ? (
        <div className="mt-1 cursor-default rounded-md bg-muted/40 px-3 py-2" onClick={stop} onPointerDown={stop}>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{body}</pre>
        </div>
      ) : null}
    </div>
  );
}
