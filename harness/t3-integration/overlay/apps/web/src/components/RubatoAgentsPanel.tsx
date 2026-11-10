/**
 * Rubato's Agents panel. Replaces T3's AgentsPanel in ChatView (apply.mjs).
 *
 * Every agent row keeps three fixed lines, each with one job:
 *   1. what the agent is working on (the spawn's own words, uncut), after its team name if any
 *   2. its state (rubatoAgentStatus agentDisplayState) and what goes with it: what it does now,
 *      the job it waits on, its latest report, or how it ended
 *   3. role · model as the picker names it · Speed · turn N · when it last moved
 * Whether it is alive is the status board's rule over the same answer (rubatoLiveness.ts):
 * a member quiet past the threshold reads "Stalled", one whose process is gone "Lost", whatever
 * its record still says.
 * A team member that got a team message since the engine started watching it adds one line
 * between 2 and 3: who sent its latest assignment and the summary they gave it.
 * Taskforces (team_create) sit above plain agents as cards: members first, then the shared
 * board. A board row says its state and owner; the lead's brief to the agent unfolds on click.
 * An agent row opens that agent's whole conversation in place of the list (RubatoAgentSession),
 * where it can also be stopped or told something.
 */
import {
  formatSpeedLabel,
  formatSubagentModelLabel,
  type AgentPanelModel,
  type AgentPanelWorkflowGroup,
  type RubatoSubagent as RuntimeSubagent,
  type SubagentBoard,
  type SubagentBoardTask,
} from "./rubatoAgentPanelModel";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Lock,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { setOpenedInPanel, useOpenedInPanel } from "../rubatoPanelViews";
import { RubatoAgentSession } from "./RubatoAgentSession";
import {
  BOARD_STATE_STEP_MS,
  type BoardNode,
  useBoardNodes,
  useBoardNow,
  useStatusBoard,
  type StatusBoard,
} from "../state/rubatoStatusBoard";
import { BoardAgo } from "./RubatoBoardClock";
import { LIVENESS_VISUALS, formatAgo, livenessOf, type Liveness } from "./rubatoLiveness";
import { useBoardFolders } from "./rubatoBoardFolders";
import {
  AGENT_STATE_VISUALS,
  AgentElapsed,
  StatusDot,
  agentDisplayState,
  agentTaskLabel,
  awaitedWorkLabel,
  isLive,
  isSettled,
  isUnderWay,
  stateCountParts,
  teamMembers,
  type AgentDisplayState,
} from "./rubatoAgentStatus";

export { agentTaskLabel, formatElapsedSeconds } from "./rubatoAgentStatus";

/** A row opens its agent's conversation in place of the list. */
const OpenAgentContext = createContext<(agentId: string) => void>(() => undefined);

/** The status board's answer, which says for each agent whether it is alive and when it last moved. */
const BoardContext = createContext<{ board: StatusBoard | null; nodes: ReadonlyMap<string, BoardNode> }>({
  board: null,
  nodes: new Map(),
});

/**
 * The board's word on a row, when it has one: the liveness rule's state and "12s ago". An
 * ended agent keeps the row's own ending; the board only adds when it last moved.
 */
export function rowLiveness(
  node: BoardNode | undefined,
  now: number,
): { readonly liveness: Liveness; readonly ago: string | null } | null {
  if (!node) return null;
  return { liveness: livenessOf(node, now), ago: formatAgo(node.lastActivityAt, now) };
}

/** The row's liveness, worked out every few seconds; its "12s ago" ticks on its own (BoardAgo). */
function useRowLiveness(agent: RuntimeSubagent) {
  const { board, nodes } = useContext(BoardContext);
  const now = useBoardNow(board, BOARD_STATE_STEP_MS);
  const node = nodes.get(agent.id);
  return useMemo(() => {
    const alive = rowLiveness(node, now);
    return alive ? { ...alive, at: node?.lastActivityAt ?? null, board } : null;
  }, [node, now, board]);
}

/**
 * A row's state with the board's word: a running agent that stalled or whose process is gone reads
 * so. Working, resting and ended stay the engine's: it hears a turn start or end, a background job
 * and a member's wait before the transcript grows, so its word there is newer than the file's tail.
 * Only what the engine cannot say of a dead or silent child comes from the board.
 */
export function liveDisplayState(
  agent: RuntimeSubagent,
  inTeam: boolean,
  alive: ReturnType<typeof rowLiveness>,
): AgentDisplayState {
  const state = agentDisplayState(agent, inTeam);
  if (!alive || isSettled(agent.status)) return state;
  return alive.liveness === "stalled" || alive.liveness === "lost" ? alive.liveness : state;
}

/** Each agent's state as its row shows it, for the counts beside them. */
function useLiveStates(agents: ReadonlyArray<RuntimeSubagent>, inTeam: boolean): AgentDisplayState[] {
  const { board, nodes } = useContext(BoardContext);
  const now = useBoardNow(board, BOARD_STATE_STEP_MS);
  return agents.map((agent) => liveDisplayState(agent, inTeam, rowLiveness(nodes.get(agent.id), now)));
}

/**
 * What goes with the state. A resting agent's `progress` is the first line of its latest final
 * message (the server folds it from the engine's member_turn), newer than any earlier `result`.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  if (isLive(agent.status)) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  if (agent.status === "idle") {
    return agent.progress ?? agent.result ?? (agent.lastToolName ? `▸ ${agent.lastToolName}` : null);
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toLocaleUpperCase() + value.slice(1);
}

/** Third line without the quiet tag: role · model · Speed · turn N · run N. */
export function agentMetaParts(agent: RuntimeSubagent): string[] {
  const task = agentTaskLabel(agent).trim().toLocaleLowerCase();
  const role =
    agent.role && agent.role.trim().toLocaleLowerCase() !== task ? capitalize(agent.role) : null;
  const model = agent.modelLabel ?? formatSubagentModelLabel(agent.model, agent.effort);
  const turns = agent.usage?.turns;
  return [
    role,
    model,
    formatSpeedLabel(agent.usage?.speedIndex),
    turns !== undefined && turns > 0 ? `turn ${turns}` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);
}

function agentStatusLabel(agent: RuntimeSubagent, state: AgentDisplayState): string {
  if (agent.kind === "subagent_batch" && state === "idle") return "Idle";
  return AGENT_STATE_VISUALS[state].label;
}

/**
 * The second line: the state word, then what goes with it. A resting agent leads with what
 * wakes it, so "Waiting for instructions" and "Background job · npm test" never look alike.
 * The word is interface text; the detail is the agent's or its command's own words.
 */
export function agentStateParts(
  agent: RuntimeSubagent,
  inTeam: boolean,
): { readonly label: string | null; readonly detail: string | null } {
  const state = agentDisplayState(agent, inTeam);
  const label = agentStatusLabel(agent, state);
  const said = agentActivityText(agent);
  if (state === "background") return { label, detail: awaitedWorkLabel(agent) };
  if (state === "waiting") return { label, detail: said };
  return said ? { label: null, detail: said } : { label, detail: null };
}

export function agentStateLine(agent: RuntimeSubagent, inTeam: boolean): string {
  const { label, detail } = agentStateParts(agent, inTeam);
  return [label, detail].filter((part): part is string => part !== null).join(" · ");
}

/**
 * Who sent the member's latest team message and the summary they gave it, or why there is no
 * label to show: the sender gave none (team_send's summary is optional).
 */
export function assignmentParts(
  agent: RuntimeSubagent,
): { readonly from: string; readonly summary: string | null } | null {
  const assignment = agent.assignment;
  if (!assignment) return null;
  return { from: boardOwnerLabel(assignment.from) ?? assignment.from, summary: assignment.summary };
}

export function assignmentLabel(agent: RuntimeSubagent): string | null {
  const parts = assignmentParts(agent);
  if (!parts) return null;
  return parts.summary ? `Assigned by ${parts.from}: ${parts.summary}` : `Assigned by ${parts.from} · no summary given`;
}

/** A state word and the words that go with it, each its own text: the word is translated, the rest never. */
function StateLine({ label, detail }: { label: string | null; detail: string | null }) {
  return (
    <>
      {label ? <span>{label}</span> : null}
      {label && detail ? <span aria-hidden> · </span> : null}
      {detail ? <span translate="no">{detail}</span> : null}
    </>
  );
}

function AssignmentLine({ agent }: { agent: RuntimeSubagent }) {
  const parts = assignmentParts(agent);
  if (!parts) return null;
  return (
    <>
      <span>Assigned by {parts.from}</span>
      {parts.summary ? (
        <>
          <span aria-hidden>: </span>
          <span translate="no">{parts.summary}</span>
        </>
      ) : (
        <>
          <span aria-hidden> · </span>
          <span>no summary given</span>
        </>
      )}
    </>
  );
}

function AgentRow({ agent, inTeam = false }: { agent: RuntimeSubagent; inTeam?: boolean }) {
  const openAgent = useContext(OpenAgentContext);
  const state = agentDisplayState(agent, inTeam);
  const statusLabel = agentStatusLabel(agent, state);
  const line = agentStateParts(agent, inTeam);
  const assignment = inTeam ? assignmentLabel(agent) : null;
  const alive = useRowLiveness(agent);
  // A stalled or lost agent reads as that, even while its record says it runs.
  const live = liveDisplayState(agent, inTeam, alive);
  const override = live === "stalled" || live === "lost" ? live : null;
  const task = agentTaskLabel(agent);
  const meta = agentMetaParts(agent);
  const metaRow = assignment ? "row-start-4" : "row-start-3";
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-label={`${task}: open conversation. ${override ? AGENT_STATE_VISUALS[override].label : statusLabel}`}
        data-state={live}
        data-liveness={alive?.liveness}
        onClick={() => openAgent(agent.id)}
        className={cn(
          "grid w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          assignment
            ? "h-[4.875rem] grid-rows-[1.25rem_1.125rem_1rem_1rem]"
            : "h-[3.875rem] grid-rows-[1.25rem_1.125rem_1rem]",
        )}
      >
        <span className="col-start-1 row-start-1 flex items-center">
          <StatusDot state={live} />
        </span>
        <span className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium" title={task}>
          {inTeam && agent.memberName ? (
            <span className="mr-1.5 font-mono text-xs text-muted-foreground">{agent.memberName}</span>
          ) : null}
          {task}
        </span>
        <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
          <span className="inline-flex items-center gap-1">
            <AgentElapsed agent={agent} />
            {agent.status === "completed" ? (
              <Check aria-hidden className="size-3 text-success" />
            ) : null}
            <ChevronRight aria-hidden className="size-3" />
          </span>
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 row-start-2 block truncate text-xs",
            agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {override ? (
            <StateLine label={AGENT_STATE_VISUALS[override].label} detail={line.detail} />
          ) : (
            <StateLine {...line} />
          )}
        </span>
        {assignment ? (
          <span
            className="col-start-2 col-end-4 row-start-3 truncate text-[.7rem] text-muted-foreground/80"
            title={assignment}
          >
            <AssignmentLine agent={agent} />
          </span>
        ) : null}
        <span className={cn("col-start-2 col-end-4 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70", metaRow)}>
          {meta.join(" · ")}
          {alive?.ago ? (
            <span className={cn(override ? LIVENESS_VISUALS[override].textClass : undefined)} data-rubato-ago="">
              {" · "}
              <BoardAgo at={alive.at} board={alive.board} />
            </span>
          ) : null}
        </span>
        <span className="sr-only">{override ? AGENT_STATE_VISUALS[override].label : statusLabel}</span>
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-1.5 pt-1 pb-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** ["2 working", "1 on a job", "1 waiting"], nonzero parts only, by the same states the rows show. */
export function teamCountsParts(members: ReadonlyArray<RuntimeSubagent>, inTeam = false): string[] {
  return stateCountParts(members.map((member) => agentDisplayState(member, inTeam)));
}

/** "2 working · 1 on a job · 1 done", nonzero parts only. */
export function teamCountsLabel(members: ReadonlyArray<RuntimeSubagent>, inTeam = false): string {
  const parts = teamCountsParts(members, inTeam);
  return parts.length > 0 ? parts.join(" · ") : "starting";
}

/** The same counts with each part its own text, so the Korean interface finds every one. */
function CountParts({ members, inTeam = false }: { members: ReadonlyArray<RuntimeSubagent>; inTeam?: boolean }) {
  const parts = stateCountParts(useLiveStates(members, inTeam));
  if (parts.length === 0) return <span>starting</span>;
  return (
    <span>
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 ? <span aria-hidden> · </span> : null}
          <span>{part}</span>
        </span>
      ))}
    </span>
  );
}

function boardOwnerLabel(owner: string | null): string | null {
  if (!owner) return null;
  return owner === "lead" ? "Lead" : owner;
}

/** What a board row says at a glance: "claimed · backend", "waits on #1, #2", "done". */
export function boardTaskStateLabel(task: SubagentBoardTask, waitingOn: ReadonlyArray<string>): string {
  const owner = boardOwnerLabel(task.owner);
  const withOwner = (word: string) => (owner ? `${word} · ${owner}` : word);
  if (task.status === "completed") return withOwner("done");
  if (task.status === "in_progress") return withOwner("in progress");
  if (task.status === "claimed") return withOwner("claimed");
  if (waitingOn.length > 0) return `waits on ${waitingOn.map((id) => `#${id}`).join(", ")}`;
  return withOwner("open");
}

function BoardStatusIcon({ task, blocked }: { task: SubagentBoardTask; blocked: boolean }) {
  if (task.status === "completed") {
    return <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />;
  }
  if (task.status === "in_progress") {
    return <CircleDot aria-hidden className="size-3.5 shrink-0 text-info" />;
  }
  if (task.status === "claimed") {
    return <CircleDot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (blocked) return <Lock aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />;
  return <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />;
}

/** The row carries state and owner; the description is the lead's brief to the agent, one click away. */
function BoardTaskRow({ task, board }: { task: SubagentBoardTask; board: SubagentBoard }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const done = new Set(board.tasks.filter((item) => item.status === "completed").map((item) => item.id));
  const waitingOn = task.blockedBy.filter((id) => !done.has(id));
  const blocked = task.status === "pending" && waitingOn.length > 0;
  const state = boardTaskStateLabel(task, task.status === "pending" ? waitingOn : []);
  const hasBrief = task.description.trim().length > 0;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={hasBrief ? open : undefined}
        aria-controls={hasBrief ? detailsId : undefined}
        aria-label={`#${task.id} ${task.subject}: ${state}${hasBrief ? `. ${open ? "Hide" : "Show"} brief` : ""}`}
        onClick={() => setOpen((value) => hasBrief && !value)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-left focus-visible:outline-2 focus-visible:outline-ring",
          hasBrief ? "hover:bg-accent/40" : "cursor-default",
        )}
      >
        <BoardStatusIcon task={task} blocked={blocked} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            task.status === "completed" ? "text-muted-foreground" : "text-foreground",
          )}
          title={task.subject}
        >
          <span className="font-mono text-muted-foreground/70">#{task.id}</span> {task.subject}
        </span>
        <span className="max-w-36 shrink-0 truncate font-mono text-[.65rem] text-muted-foreground">
          {state}
        </span>
      </button>
      {open && hasBrief ? (
        <div
          id={detailsId}
          className="mb-1 ml-7 mr-1.5 space-y-1 rounded-md border border-border/50 bg-background/40 p-2 text-xs"
        >
          <p className="font-mono text-[.65rem] text-muted-foreground">Brief for the agent</p>
          <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {task.description}
            {task.descriptionTruncated ? "…" : ""}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function TeamBoard({ board }: { board: SubagentBoard }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const total = board.tasks.length;
  const done = board.tasks.filter((task) => task.status === "completed").length;
  const active = board.tasks.filter((task) => task.status === "in_progress").length;
  return (
    <div className="px-1 pb-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="text-xs font-medium">Board</span>
        <span className="font-mono text-[.7rem] tabular-nums text-muted-foreground">
          {total === 0 ? "no tasks yet" : `${done}/${total} done`}
          {active > 0 ? ` · ${active} in progress` : ""}
        </span>
        {total > 0 ? (
          <span
            aria-hidden
            className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
          >
            <span
              className="block h-full rounded-full bg-success"
              style={{ width: `${Math.round((done / total) * 100)}%` }}
            />
          </span>
        ) : null}
      </button>
      {open && total > 0 ? (
        <ul id={listId} className="mt-0.5 space-y-0.5">
          {board.tasks.map((task) => (
            <BoardTaskRow key={task.id} task={task} board={board} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TaskforceCard({ group }: { group: AgentPanelWorkflowGroup }) {
  const team = group.workflow;
  const [open, setOpen] = useState(() => !isSettled(team.status));
  const members = teamMembers(group);
  const name = team.workflowName ?? agentTaskLabel(team);
  const failed = members.some((member) => member.status === "failed");
  const dotState: AgentDisplayState = failed ? "failed" : agentDisplayState(team);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/40"
      >
        <StatusDot state={dotState} />
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[.7rem] text-muted-foreground/80">
          <span>
            {members.length} {members.length === 1 ? "member" : "members"}
          </span>
          {team.startedAt ? (
            <>
              <span>·</span>
              <AgentElapsed agent={team} />
            </>
          ) : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    );
  }
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1">
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-expanded
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
      >
        <StatusDot state={dotState} />
        <span className="max-w-[45%] shrink-0 truncate text-sm font-medium" title={name}>{name}</span>
        <span className="ml-auto flex min-w-0 items-center gap-1 font-mono text-[.7rem] text-muted-foreground/80">
          <span className="min-w-0 truncate" title={teamCountsLabel(members, true)}>
            <CountParts members={members} inTeam />
          </span>
          {team.startedAt ? (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
              <span>·</span>
              <AgentElapsed agent={team} />
            </span>
          ) : null}
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        </span>
      </button>
      <div className="border-t border-border/40 pt-0.5">
        {members.length > 0 ? (
          members.map((member) => <AgentRow key={member.id} agent={member} inTeam />)
        ) : (
          <AgentRow agent={team} />
        )}
      </div>
      {team.board ? (
        <div className="border-t border-border/40 pt-0.5">
          <TeamBoard board={team.board} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Working agents and those on a job of their own stay on top; finished and idle ones fold away
 * below, newest first.
 * An idle agent that is resumed is live again and moves back up on its own.
 */
export function splitAgentsByActivity(agents: ReadonlyArray<RuntimeSubagent>): {
  live: RuntimeSubagent[];
  finished: RuntimeSubagent[];
} {
  const live = agents.filter((agent) => isUnderWay(agent));
  const finishedAt = (agent: RuntimeSubagent) => agent.completedAt ?? agent.updatedAt;
  const finished = agents
    .filter((agent) => !isUnderWay(agent))
    .sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)));
  return { live, finished };
}

function GroupToggle({
  open,
  onToggle,
  label,
  detail,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  detail: ReactNode;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {open ? (
        <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="text-xs font-medium">{label}</span>
      <span className="font-mono text-[.7rem] tabular-nums text-muted-foreground">{detail}</span>
    </button>
  );
}

function AgentGroups({ agents }: { agents: ReadonlyArray<RuntimeSubagent> }) {
  const { live, finished } = splitAgentsByActivity(agents);
  const [liveOpen, setLiveOpen] = useState(true);
  const [finishedOpen, setFinishedOpen] = useState(false);
  const liveId = useId();
  const finishedId = useId();
  return (
    <>
      {live.length > 0 ? (
        <div>
          <GroupToggle
            open={liveOpen}
            onToggle={() => setLiveOpen((value) => !value)}
            label="In progress"
            detail={String(live.length)}
            controls={liveId}
          />
          {liveOpen ? (
            <div id={liveId}>
              {live.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {finished.length > 0 ? (
        <div>
          <GroupToggle
            open={finishedOpen}
            onToggle={() => setFinishedOpen((value) => !value)}
            label="Finished"
            detail={<CountParts members={finished} />}
            controls={finishedId}
          />
          {finishedOpen ? (
            <div id={finishedId}>
              {finished.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The agent a row opened, wherever it sits: a plain agent, a taskforce or one of its members. */
export function findPanelAgent(
  model: AgentPanelModel,
  agentId: string,
): { agent: RuntimeSubagent; inTeam: boolean } | null {
  const direct = model.directAgents.find((agent) => agent.id === agentId);
  if (direct) return { agent: direct, inTeam: false };
  for (const group of model.workflows) {
    if (group.workflow.id === agentId) return { agent: group.workflow, inTeam: false };
    const member = teamMembers(group).find((agent) => agent.id === agentId);
    if (member) return { agent: member, inTeam: true };
  }
  return null;
}

function AgentSessionHeader({ agent, inTeam }: { agent: RuntimeSubagent; inTeam: boolean }) {
  const task = agentTaskLabel(agent);
  const alive = useRowLiveness(agent);
  const live = liveDisplayState(agent, inTeam, alive);
  const override = live === "stalled" || live === "lost" ? live : null;
  const state = agentDisplayState(agent, inTeam);
  const job = state === "background" ? awaitedWorkLabel(agent) : null;
  const assignment = inTeam ? assignmentLabel(agent) : null;
  return (
    <div className="min-w-0 py-0.5">
      <p className="line-clamp-3 text-sm font-medium [overflow-wrap:anywhere]">
        {inTeam && agent.memberName ? (
          <span className="mr-1.5 font-mono text-xs text-muted-foreground">{agent.memberName}</span>
        ) : null}
        {task}
      </p>
      <p className="flex min-w-0 items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
        <StatusDot state={live} />
        <span className={override ? LIVENESS_VISUALS[override].textClass : undefined}>
          {override ? AGENT_STATE_VISUALS[override].label : agentStatusLabel(agent, state)}
        </span>
        {job ? (
          <>
            <span aria-hidden>·</span>
            <span translate="no" className="min-w-0 truncate">{job}</span>
          </>
        ) : null}
        {agent.startedAt ? (
          <>
            <span>·</span>
            <AgentElapsed agent={agent} />
          </>
        ) : null}
        {alive?.ago ? (
          <span className={cn(override ? LIVENESS_VISUALS[override].textClass : undefined)} data-rubato-ago="">
            · <BoardAgo at={alive.at} board={alive.board} />
          </span>
        ) : null}
      </p>
      {assignment ? (
        <p className="truncate text-[.7rem] text-muted-foreground/80">
          <AssignmentLine agent={agent} />
        </p>
      ) : null}
      <p className="truncate font-mono text-[.7rem] text-muted-foreground/70">
        {agentMetaParts(agent).join(" · ")}
      </p>
    </div>
  );
}

/** The panel's totals; a running agent the board calls stalled or lost counts as that, not as working. */
function PanelFooter({ model }: { model: AgentPanelModel }) {
  const rows = [
    ...model.workflows.flatMap((group) => teamMembers(group).map((agent) => [agent, true] as const)),
    ...model.directAgents.map((agent) => [agent, false] as const),
  ];
  // Each row counted in the state its own row shows (members as members: resting is "waiting").
  const states = [
    ...useLiveStates(rows.filter(([, inTeam]) => inTeam).map(([agent]) => agent), true),
    ...useLiveStates(rows.filter(([, inTeam]) => !inTeam).map(([agent]) => agent), false),
  ];
  const count = (...wanted: AgentDisplayState[]) => states.filter((state) => wanted.includes(state)).length;
  const working = count("working");
  const stalled = count("stalled");
  const lost = count("lost");
  const background = count("background");
  const idle = count("waiting", "idle");
  const settled = count("completed", "failed", "stopped");
  return (
    <footer className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
      {working > 0 ? <span className="text-info-foreground">● {working} working</span> : null}
      {stalled > 0 ? <span className="text-warning-foreground">{stalled} stalled</span> : null}
      {lost > 0 ? <span className="text-destructive-foreground">{lost} lost</span> : null}
      {background > 0 ? <span>{background} on a job</span> : null}
      {idle > 0 ? <span>{idle} idle</span> : null}
      {settled > 0 ? <span>{settled} settled</span> : null}
    </footer>
  );
}

export function RubatoAgentsPanel({
  model,
  environmentId,
  threadId,
  cwd,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  /** The thread's session directory; its children's conversations are read under it. */
  cwd?: string | null;
}) {
  // Per thread, for the app session: a thread switch or a hidden panel comes back to the agent
  // that was open; closing the Agents tab returns to the list (rubatoPanelViews.ts).
  const threadKey = environmentId && threadId ? scopedThreadKey(scopeThreadRef(environmentId, threadId)) : null;
  const openedId = useOpenedInPanel("agents", threadKey);
  const setOpened = useCallback(
    (agentId: string | null) => {
      if (threadKey) setOpenedInPanel("agents", threadKey, agentId);
    },
    [threadKey],
  );
  const openAgent = useCallback((agentId: string) => setOpened(agentId), [setOpened]);
  // The status board's answer for this thread's folder too, for each row's liveness.
  const { environmentId: boardEnvironmentId, folders } = useBoardFolders();
  const boardFolders = useMemo(
    () => (cwd && !folders.includes(cwd) ? [...folders, cwd] : folders),
    [cwd, folders],
  );
  const board = useStatusBoard(boardEnvironmentId, boardFolders, model.hasAgents);
  const nodes = useBoardNodes(board);
  const boardValue = useMemo(() => ({ board, nodes }), [board, nodes]);
  const found = openedId ? findPanelAgent(model, openedId) : null;
  if (found) {
    const { agent, inTeam } = found;
    return (
      <BoardContext.Provider value={boardValue}>
      <RubatoAgentSession
        key={agent.id}
        target={
          environmentId && threadId && cwd
            ? { environmentId, threadId, cwd, taskId: agent.id }
            : null
        }
        live={isLive(agent.status)}
        revision={`${agent.status}|${agent.updatedAt}`}
        header={<AgentSessionHeader agent={agent} inTeam={inTeam} />}
        onBack={() => setOpened(null)}
      />
      </BoardContext.Provider>
    );
  }
  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Agents and taskforces this thread starts show up here with what they are working on,
          their model and their progress.
        </p>
      </div>
    );
  }
  const hasTeams = model.workflows.length > 0;
  return (
    <OpenAgentContext.Provider value={openAgent}>
    <BoardContext.Provider value={boardValue}>
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-2">
          {hasTeams ? (
            <section className="flex flex-col gap-1.5">
              <SectionLabel>Taskforce</SectionLabel>
              {model.workflows.map((group) => (
                <TaskforceCard key={group.workflow.id} group={group} />
              ))}
            </section>
          ) : null}
          {model.directAgents.length > 0 ? (
            <section className="flex flex-col gap-1">
              {hasTeams ? <SectionLabel>Agents</SectionLabel> : null}
              <AgentGroups agents={model.directAgents} />
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <PanelFooter model={model} />
    </div>
    </BoardContext.Provider>
    </OpenAgentContext.Provider>
  );
}
