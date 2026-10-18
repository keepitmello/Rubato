/**
 * The Team and Agents sections of the thread details, between Workspace and Version Control
 * (floating-menu-edits.mjs). They answer "what is running for this thread" at a glance:
 * - Team: every taskforce that has not ended, one row each, its members as a strip of glyphs.
 *   Shape says the role (circle owner, diamond verifier, owners first); fill and motion say the
 *   state with the Agents surface's colors, so a role never borrows a state's color. The strip is
 *   the whole summary: no count text beside it.
 * - Agents: agents working outside a team, up to AGENT_ROW_LIMIT rows, the rest counted. A row
 *   gives the task its own line and puts the model and elapsed time under it.
 * A section shows only while something in it is running; finished work is a count that opens
 * the Agents surface, where the full list lives (RubatoAgentsPanel). An agent row opens that
 * agent's conversation there; a team row and the arrow open the surface itself.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowUpRightIcon, UsersIcon } from "lucide-react";
import { Fragment, useCallback } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { setOpenedInPanel } from "../../rubatoPanelViews";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AgentElapsed,
  STATUS_VISUALS,
  StatusDot,
  agentTaskLabel,
  isLive,
  isSettled,
  teamMembers,
} from "../rubatoAgentStatus";
import {
  formatSubagentModelLabel,
  type AgentPanelModel,
  type RubatoSubagent,
} from "../rubatoAgentPanelModel";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export const AGENT_ROW_LIMIT = 3;

type Status = RubatoSubagent["status"];

export type TeamMemberRole = "owner" | "verifier";

export interface ThreadDetailsTeamMember {
  readonly id: string;
  readonly name: string;
  readonly role: TeamMemberRole;
  readonly status: Status;
}

export interface ThreadDetailsTeamRow {
  readonly id: string;
  readonly name: string;
  /** Owners, then verifiers; each group keeps the team's order. */
  readonly members: ReadonlyArray<ThreadDetailsTeamMember>;
}

export interface ThreadDetailsAgentsSummary {
  readonly teams: ReadonlyArray<ThreadDetailsTeamRow>;
  readonly finishedTeamCount: number;
  readonly agents: ReadonlyArray<RubatoSubagent>;
  readonly moreAgentCount: number;
  readonly finishedAgentCount: number;
}

/** A member without a role (an older answer) draws as an owner. */
function memberRole(member: RubatoSubagent): TeamMemberRole {
  return member.role === "verifier" ? "verifier" : "owner";
}

/** The rows both sections draw: running teams, then at most `limit` working direct agents. */
export function summarizeThreadDetailsAgents(
  model: AgentPanelModel,
  limit: number = AGENT_ROW_LIMIT,
): ThreadDetailsAgentsSummary {
  const running = model.workflows.filter((group) => !isSettled(group.workflow.status));
  const teams = running.map((group) => {
    const all = teamMembers(group).map((member) => ({
      id: member.id,
      name: member.memberName ?? agentTaskLabel(member),
      role: memberRole(member),
      status: member.status,
    }));
    const members = [
      ...all.filter((member) => member.role === "owner"),
      ...all.filter((member) => member.role === "verifier"),
    ];
    return {
      id: group.workflow.id,
      name: group.workflow.workflowName ?? agentTaskLabel(group.workflow),
      members,
    };
  });
  const live = model.directAgents.filter((agent) => isLive(agent.status));
  return {
    teams,
    finishedTeamCount: model.workflows.length - running.length,
    agents: live.slice(0, limit),
    moreAgentCount: Math.max(0, live.length - limit),
    finishedAgentCount: model.directAgents.length - live.length,
  };
}

/** "Opus 5.5" from "Opus 5.5 · High": the row has room for the model, not the effort. */
export function shortModelLabel(agent: RubatoSubagent): string | null {
  const label = agent.modelLabel ?? formatSubagentModelLabel(agent.model, agent.effort);
  return label ? (label.split(" · ")[0] ?? label) : null;
}

/** "+2 more · 3 finished", nonzero parts only; null when there is nothing to count. */
export function overflowLabel(more: number, finished: number): string | null {
  const parts = [more > 0 ? `+${more} more` : null, finished > 0 ? `${finished} finished` : null];
  const shown = parts.filter((part): part is string => part !== null);
  return shown.length > 0 ? shown.join(" · ") : null;
}

/** Circle for an owner; a verifier's square turned on its corner reads as the same size. */
const GLYPH_SHAPE_CLASS: Record<TeamMemberRole, string> = {
  owner: "size-2.5 rounded-full",
  verifier: "size-2 rotate-45 rounded-[2px]",
};

/** Same colors as the Agents surface's dots: filled and breathing works, a hollow ring rests. */
const GLYPH_STATUS_CLASS: Record<Status, string> = {
  pending: "bg-info ring-2 ring-info/25 animate-pulse",
  running: "bg-info ring-2 ring-info/25 animate-pulse",
  waiting: "bg-info ring-2 ring-info/25 animate-pulse",
  idle: "bg-transparent ring-1 ring-inset ring-muted-foreground/70",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/40",
  interrupted: "bg-muted-foreground/40",
};

function useOpenAgents(environmentId: EnvironmentId, threadId: ThreadId) {
  return useCallback(
    (agentId: string | null) => {
      const ref = scopeThreadRef(environmentId, threadId);
      setOpenedInPanel("agents", scopedThreadKey(ref), agentId);
      useRightPanelStore.getState().open(ref, "agents");
    },
    [environmentId, threadId],
  );
}

function OpenAgentsAction({ onOpen }: { onOpen: () => void }) {
  return (
    <ThreadDetailsControl part="icon" aria-label="Open Agents" title="Open Agents" onClick={onOpen}>
      <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
    </ThreadDetailsControl>
  );
}

function OverflowRow({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <ThreadDetailsControl part="meta" className="ms-7.5 self-start" onClick={onOpen}>
      {label}
    </ThreadDetailsControl>
  );
}

function TeamRow({ team, onOpen }: { team: ThreadDetailsTeamRow; onOpen: () => void }) {
  const total = team.members.length;
  const firstVerifier = team.members.findIndex((member) => member.role === "verifier");
  return (
    <ThreadDetailsControl multiline onClick={onOpen} aria-label={`${team.name}: open Agents`}>
      <UsersIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
        <span className={cn("block truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{team.name}</span>
        {total > 0 ? (
          <span aria-hidden className="flex items-center gap-1.5 px-0.5 py-0.5">
            {team.members.map((member, index) => (
              <Fragment key={member.id}>
                {index === firstVerifier && index > 0 ? (
                  <span className="mx-0.5 h-2.5 w-px bg-border" />
                ) : null}
                <MemberGlyph member={member} />
              </Fragment>
            ))}
          </span>
        ) : null}
      </span>
    </ThreadDetailsControl>
  );
}

/** One member; hovering it names the member and its state, since the strip only draws them. */
function MemberGlyph({ member }: { member: ThreadDetailsTeamMember }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-role={member.role}
            data-status={member.status}
            data-name={member.name}
            className={cn(
              "shrink-0",
              GLYPH_SHAPE_CLASS[member.role],
              GLYPH_STATUS_CLASS[member.status],
            )}
          />
        }
      />
      <TooltipPopup side="top">
        <span className="flex items-center gap-1.5">
          <span className="font-medium">{member.name}</span>
          <span className="text-muted-foreground">{STATUS_VISUALS[member.status].label}</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function AgentRow({ agent, onOpen }: { agent: RubatoSubagent; onOpen: () => void }) {
  const task = agentTaskLabel(agent);
  const model = shortModelLabel(agent);
  return (
    <ThreadDetailsControl multiline onClick={onOpen} aria-label={`${task}: open conversation`}>
      <span className="flex size-4 shrink-0 items-center justify-center self-start pt-1.5">
        <StatusDot status={agent.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 py-1">
        <span className={cn("block truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{task}</span>
        <span className="flex min-w-0 items-center gap-1 font-mono text-[.7rem] font-normal text-muted-foreground">
          {model ? <span className="truncate">{model}</span> : null}
          {model && agent.startedAt ? <span>·</span> : null}
          <AgentElapsed agent={agent} />
        </span>
      </span>
    </ThreadDetailsControl>
  );
}

export function RubatoThreadDetailsAgents({
  model,
  environmentId,
  threadId,
  separated,
}: {
  model: AgentPanelModel;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  separated: boolean;
}) {
  const openAgents = useOpenAgents(environmentId, threadId);
  const openSurface = useCallback(() => openAgents(null), [openAgents]);
  const summary = summarizeThreadDetailsAgents(model);
  const workingCount = summary.agents.length + summary.moreAgentCount;
  const teamOverflow = overflowLabel(0, summary.finishedTeamCount);
  const agentOverflow = overflowLabel(summary.moreAgentCount, summary.finishedAgentCount);
  return (
    <>
      {summary.teams.length > 0 ? (
        <ThreadDetailsSection
          headingId="thread-details-team-heading"
          title="Team"
          separated={separated}
          actions={<OpenAgentsAction onOpen={openSurface} />}
        >
          <div className="flex flex-col">
            {summary.teams.map((team) => (
              <TeamRow key={team.id} team={team} onOpen={openSurface} />
            ))}
            {teamOverflow ? <OverflowRow label={teamOverflow} onOpen={openSurface} /> : null}
          </div>
        </ThreadDetailsSection>
      ) : null}
      {workingCount > 0 ? (
        <ThreadDetailsSection
          headingId="thread-details-agents-heading"
          title="Agents"
          separated={separated}
          actions={
            <>
              <span className="flex items-center gap-1.5 font-mono text-[.7rem] text-info-foreground">
                <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-info" />
                {workingCount} working
              </span>
              <OpenAgentsAction onOpen={openSurface} />
            </>
          }
        >
          <div className="flex flex-col">
            {summary.agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onOpen={() => openAgents(agent.id)} />
            ))}
            {agentOverflow ? <OverflowRow label={agentOverflow} onOpen={openSurface} /> : null}
          </div>
        </ThreadDetailsSection>
      ) : null}
    </>
  );
}
