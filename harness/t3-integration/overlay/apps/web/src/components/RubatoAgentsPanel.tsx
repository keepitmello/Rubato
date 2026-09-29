/**
 * Rubato's Agents panel. Replaces T3's AgentsPanel in ChatView (apply.mjs).
 *
 * Every agent row keeps three fixed lines, each with one job:
 *   1. what the agent is working on (the spawn's own words, uncut), after its team name if any
 *   2. what it is doing now, or how it ended
 *   3. role · model as the picker names it · Speed · turn N (· quiet 3m when stalled)
 * Taskforces (team_create) sit above plain agents as cards: members first, then the shared
 * board. A board row says its state and owner; the lead's brief to the agent unfolds on click.
 */
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
  SubagentBoard,
  SubagentBoardTask,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSpeedLabel,
  formatSubagentModelLabel,
} from "@t3tools/client-runtime/state/subagentRuntime";
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
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { AgentResultDetails } from "./AgentResultDetails";

/** In-flight states all read as Working; only settled states differ. */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  idle: { dotClass: "bg-transparent ring-1 ring-inset ring-muted-foreground", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

/** A live agent with no update for this long shows how long it has been quiet. */
export const QUIET_AFTER_MS = 120_000;

function isLive(status: RuntimeSubagent["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isSettled(status: RuntimeSubagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
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
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
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

/** "quiet 3m" once a live agent has sent nothing for QUIET_AFTER_MS; null otherwise. */
export function quietLabel(agent: RuntimeSubagent, now: number): string | null {
  if (!isLive(agent.status)) return null;
  const last = Date.parse(agent.updatedAt);
  if (Number.isNaN(last) || now - last < QUIET_AFTER_MS) return null;
  return `quiet ${Math.floor((now - last) / 60_000)}m`;
}

function useQuietLabel(agent: RuntimeSubagent): string | null {
  const [now, setNow] = useState(() => Date.now());
  const live = isLive(agent.status);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [live, agent.updatedAt]);
  return quietLabel(agent, now);
}

function agentActivityText(agent: RuntimeSubagent): string | null {
  if (isLive(agent.status)) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
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

/** First line: the task alone. Old rows without `label` fall back to the title. */
export function agentTaskLabel(agent: RuntimeSubagent): string {
  return agent.label ?? agent.title;
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

/**
 * A team member that ended its turn is still resident and wakes on mail or a notification,
 * so inside a taskforce idle reads as Waiting, with what it last said.
 */
function AgentRow({ agent, inTeam = false }: { agent: RuntimeSubagent; inTeam?: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const visuals = STATUS_VISUALS[agent.status];
  const waiting = inTeam && agent.status === "idle";
  const statusLabel = waiting
    ? "Waiting"
    : agent.kind === "subagent_batch" && agent.status === "idle"
      ? "Idle"
      : visuals.label;
  const said = agentActivityText(agent);
  const activity = waiting ? (said ? `Waiting · ${said}` : "Waiting") : said;
  const quiet = useQuietLabel(agent);
  const task = agentTaskLabel(agent);
  const meta = agentMetaParts(agent);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={`${task}: ${open ? "Hide" : "Show"} report. ${statusLabel}`}
        onClick={() => setOpen((value) => !value)}
        className="grid h-[3.875rem] w-full cursor-pointer grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="col-start-1 row-start-1 flex items-center">
          <StatusDot status={agent.status} />
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
            {open ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
          </span>
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 row-start-2 block truncate text-xs",
            agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {activity ?? statusLabel}
        </span>
        <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
          {meta.join(" · ")}
          {quiet ? <span className="text-warning-foreground"> · {quiet}</span> : null}
        </span>
        <span className="sr-only">{statusLabel}</span>
      </button>
      {open ? (
        <div
          id={detailsId}
          role="region"
          aria-label={`${task} report`}
          tabIndex={0}
          className="mx-1.5 mb-2 max-h-96 min-w-0 overflow-y-auto overscroll-contain rounded-md border border-border/60 bg-card/30 p-3 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <AgentResultDetails agent={agent} />
        </div>
      ) : null}
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

function teamMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/** "2 working · 1 idle · 1 done", nonzero parts only. */
export function teamCountsLabel(
  members: ReadonlyArray<RuntimeSubagent>,
  idleWord: "idle" | "waiting" = "idle",
): string {
  const count = (predicate: (member: RuntimeSubagent) => boolean) =>
    members.filter(predicate).length;
  const parts = [
    [count((member) => isLive(member.status)), "working"],
    [count((member) => member.status === "idle"), idleWord],
    [count((member) => member.status === "completed"), "done"],
    [count((member) => member.status === "failed"), "failed"],
    [count((member) => member.status === "cancelled" || member.status === "interrupted"), "stopped"],
  ] as const;
  const shown = parts.filter(([value]) => value > 0).map(([value, word]) => `${value} ${word}`);
  return shown.length > 0 ? shown.join(" · ") : "starting";
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
  const dotStatus = failed ? "failed" : team.status;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/40"
      >
        <StatusDot status={dotStatus} />
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
        <StatusDot status={dotStatus} />
        <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[.7rem] text-muted-foreground/80">
          <span>{teamCountsLabel(members, "waiting")}</span>
          {team.startedAt ? (
            <>
              <span>·</span>
              <AgentElapsed agent={team} />
            </>
          ) : null}
          <ChevronDown aria-hidden className="size-3" />
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
 * Working agents stay on top; finished and idle ones fold away below, newest first.
 * An idle agent that is resumed is live again and moves back up on its own.
 */
export function splitAgentsByActivity(agents: ReadonlyArray<RuntimeSubagent>): {
  live: RuntimeSubagent[];
  finished: RuntimeSubagent[];
} {
  const live = agents.filter((agent) => isLive(agent.status));
  const finishedAt = (agent: RuntimeSubagent) => agent.completedAt ?? agent.updatedAt;
  const finished = agents
    .filter((agent) => !isLive(agent.status))
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
  detail: string;
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
            detail={teamCountsLabel(finished)}
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

export function RubatoAgentsPanel({
  model,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
}) {
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
      <footer className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        {model.runningCount + model.waitingCount > 0 ? (
          <span className="text-info-foreground">
            ● {model.runningCount + model.waitingCount} working
          </span>
        ) : null}
        {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
        {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
      </footer>
    </div>
  );
}
