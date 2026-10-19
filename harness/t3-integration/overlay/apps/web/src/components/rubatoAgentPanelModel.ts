/**
 * The Agents panel's view model (RubatoAgentsPanel). T3 v0.1.0 dropped its right-panel
 * Agents surface and the panel model with it; Rubato keeps the panel, so the model lives
 * here, over T3's own runtime rows plus the fields only Rubato's engine knows: the spawn's
 * own words, the picker's model name, a taskforce member's name, Speed and turns, and a
 * taskforce's shared board.
 *
 * Teams are workflow rows (kind "workflow"); their members point at them with
 * parentAgentId. Everything else is a direct agent.
 */
import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
  type SubagentUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";

import type { RubatoSessionAgent, RubatoSessionState } from "../state/rubatoSessionState";

export interface SubagentBoardTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly descriptionTruncated: boolean;
  readonly status: "pending" | "claimed" | "in_progress" | "completed";
  readonly owner: string | null;
  readonly blockedBy: ReadonlyArray<string>;
  readonly updatedAt: string | null;
}

export interface SubagentBoard {
  readonly tasks: ReadonlyArray<SubagentBoardTask>;
}

export interface RubatoSubagentUsage extends SubagentUsage {
  readonly speedIndex?: number;
  readonly turns?: number;
}

export interface RubatoSubagentExtras {
  /** The spawn's own words, uncut (title may carry a phone-sized model tag). */
  readonly label: string | null;
  /** The model as the picker names it, with effort: "Opus 5.5 · High". */
  readonly modelLabel: string | null;
  /** A taskforce member's name in its team: "backend". */
  readonly memberName: string | null;
  /** A taskforce's shared board, latest snapshot. */
  readonly board: SubagentBoard | null;
  /** Work of its own a resting agent will be woken by (a bounded background command, a monitor). */
  readonly awaiting: ReadonlyArray<{ readonly id: string; readonly description: string }>;
  /** The latest team message it received: who sent it and the summary they gave, if they gave one. */
  readonly assignment: { readonly from: string; readonly summary: string | null } | null;
}

export type RubatoSubagent = Omit<RuntimeSubagent, "usage"> &
  RubatoSubagentExtras & { readonly usage: RubatoSubagentUsage | null };

export interface AgentPanelWorkflowGroup {
  readonly workflow: RubatoSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RubatoSubagent>;
    /** done = every member settled (success or error); running = any active. */
    readonly state: "pending" | "running" | "done";
    readonly activeCount: number;
    readonly settledCount: number;
  }>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RubatoSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RubatoSubagent>;
  readonly runningCount: number;
  readonly waitingCount: number;
  /** Resting on work of its own that will wake it (rubatoAgentStatus "background"). */
  readonly backgroundCount: number;
  /** Resting with nothing of its own pending. */
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  backgroundCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

const byFirstSeen = (a: RubatoSubagent, b: RubatoSubagent) =>
  a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id);
const byAgentIndex = (a: RubatoSubagent, b: RubatoSubagent) =>
  (a.agentIndex ?? 0) - (b.agentIndex ?? 0);

export function deriveAgentPanelModel({
  agents,
}: {
  readonly agents: ReadonlyArray<RubatoSubagent>;
}): AgentPanelModel {
  if (agents.length === 0) return EMPTY_PANEL_MODEL;

  const workflows = agents.filter((agent) => agent.kind === "workflow").toSorted(byFirstSeen);
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RubatoSubagent[]>();
  const direct: RubatoSubagent[] = [];
  for (const agent of agents) {
    if (agent.kind === "workflow") continue;
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      // Orphaned members (coordinator aged out) fall back to the direct list.
      direct.push(agent);
    }
  }

  const workflowGroups: AgentPanelWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const derived = new Map<number, string>();
    for (const member of workflowMembers) {
      if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
        derived.set(member.phaseIndex, member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`);
      }
    }
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : Array.from(derived.entries())
            .map(([index, title]) => ({ index, title }))
            .toSorted((a, b) => a.index - b.index);
    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .toSorted(byAgentIndex);
      // Idle members count as active for phase-liveness: a resumable member has not finished.
      const activeCount = phaseMembers.filter(
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? "pending"
          : activeCount > 0
            ? "running"
            : settledCount === phaseMembers.length
              ? "done"
              : "pending";
      return { index: phase.index, title: phase.title, members: phaseMembers, state, activeCount, settledCount };
    });
    // A member must never vanish because its phase row was lost.
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .toSorted(byAgentIndex);
    return { workflow, phases, unphasedMembers };
  });

  let runningCount = 0;
  let waitingCount = 0;
  let backgroundCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of agents) {
    // A team with members is a container, not work of its own.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle" && agent.awaiting.length > 0) backgroundCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    // Updates must never reshuffle rows that remain visible.
    directAgents: direct.toSorted(byFirstSeen),
    runningCount,
    waitingCount,
    backgroundCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

const STATUS: Record<RubatoSessionAgent["status"], RuntimeSubagentStatus> = {
  running: "running",
  waiting: "waiting",
  idle: "idle",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled",
};

const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

/**
 * The panel's rows from the server's fold of the engine (state/rubatoSessionState.ts): one row
 * per agent, and a workflow row per taskforce that its members point at.
 */
export function rubatoAgentsFromSessionState(state: RubatoSessionState): RubatoSubagent[] {
  const teamOf = new Map<string, string>();
  for (const team of state.teams) for (const member of team.members) teamOf.set(member, team.teamRunId);
  const agents = state.agents.map((agent): RubatoSubagent => {
    const usage: RubatoSubagentUsage | null =
      agent.speedIndex == null && agent.turns == null && agent.totalTokens == null && agent.toolUses == null
        ? null
        : {
            totalTokens: agent.totalTokens ?? 0,
            ...(agent.toolUses == null ? {} : { toolUses: agent.toolUses }),
            ...(agent.speedIndex == null ? {} : { speedIndex: agent.speedIndex }),
            ...(agent.turns == null ? {} : { turns: agent.turns }),
          };
    return {
      id: agent.taskId,
      kind: "subagent",
      title: agent.title,
      label: orNull(agent.label),
      modelLabel: orNull(agent.modelLabel),
      memberName: orNull(agent.memberName),
      board: null,
      awaiting: agent.awaiting ?? [],
      assignment: agent.assignment ? { from: agent.assignment.from, summary: agent.assignment.summary ?? null } : null,
      role: orNull(agent.role),
      model: orNull(agent.model),
      effort: orNull(agent.effort),
      status: STATUS[agent.status] ?? "running",
      activationCount: agent.activationCount ?? 1,
      usage,
      progress: orNull(agent.activity),
      lastToolName: orNull(agent.lastToolName),
      result: orNull(agent.result),
      error: orNull(agent.error),
      outputFile: null,
      parentAgentId: teamOf.get(agent.taskId) ?? orNull(agent.teamRunId) ?? orNull(agent.parentAgentId),
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      childThreadId: null,
      recentActivity: [],
      firstSeenAt: agent.startedAt,
      startedAt: agent.startedAt,
      completedAt: orNull(agent.completedAt),
      updatedAt: agent.updatedAt,
    };
  });
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const teams = state.teams.map((team): RubatoSubagent => {
    const members = team.members.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    // The server's team status wins; an older answer without one follows the members.
    const live =
      team.status !== undefined
        ? isActiveSubagentStatus(STATUS[team.status] ?? "running")
        : members.some((member) => isActiveSubagentStatus(member.status) || member.status === "idle");
    const first =
      team.startedAt ?? members.map((member) => member.firstSeenAt).toSorted()[0] ?? new Date(0).toISOString();
    const last = team.updatedAt ?? members.map((member) => member.updatedAt).toSorted().at(-1) ?? first;
    return {
      id: team.teamRunId,
      kind: "workflow",
      title: team.name,
      label: team.name,
      modelLabel: null,
      memberName: null,
      awaiting: [],
      assignment: null,
      board: team.board
        ? {
            tasks: team.board.tasks.map((task) => ({
              id: task.id,
              subject: task.subject,
              description: task.description,
              descriptionTruncated: task.descriptionTruncated === true,
              status: task.status,
              owner: orNull(task.owner),
              blockedBy: task.blockedBy ?? [],
              updatedAt: orNull(task.updatedAt),
            })),
          }
        : null,
      role: null,
      model: null,
      effort: null,
      status: team.status !== undefined ? (STATUS[team.status] ?? "running") : live ? "running" : "completed",
      activationCount: 1,
      usage: null,
      progress: null,
      lastToolName: null,
      result: null,
      error: null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: team.name,
      phases: [],
      runHandles: null,
      childThreadId: null,
      recentActivity: [],
      firstSeenAt: first,
      startedAt: first,
      completedAt: team.completedAt ?? (live ? null : last),
      updatedAt: last,
    };
  });
  return [...teams, ...agents];
}

/**
 * Compact model chip text: strips vendor prefixes and date suffixes
 * ("claude-opus-4-20250514" → "opus-4"); effort appends as "· high".
 */
export function formatSubagentModelLabel(model: string | null, effort: string | null): string | null {
  if (!model) return null;
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

export function formatSpeedLabel(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? `Speed ${Math.round(score)}` : "Speed —";
}
