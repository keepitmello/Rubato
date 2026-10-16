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
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
  type SubagentUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";

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
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of agents) {
    // A team with members is a container, not work of its own.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
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
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

/** T3's runtime rows with no Rubato extras yet. */
export function withoutRubatoExtras(agents: ReadonlyArray<RuntimeSubagent>): RubatoSubagent[] {
  return agents.map((agent) => ({ ...agent, label: null, modelLabel: null, memberName: null, board: null }));
}

/** The thread's subagents as the V2 projection holds them. */
export function rubatoAgentsFromProjection(
  projection: { readonly subagents: Parameters<typeof projectedSubagentsToRuntime>[0] } | null,
): RubatoSubagent[] {
  return projection ? withoutRubatoExtras(projectedSubagentsToRuntime(projection.subagents)) : [];
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
