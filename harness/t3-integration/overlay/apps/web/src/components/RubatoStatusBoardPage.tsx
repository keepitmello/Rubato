// The status board (현황판): who is working on what, right now, across the app's projects.
// Each team (or the subagents one conversation started) is a card: its lead on the left,
// a line to each member on the right with what the member last said, how long ago it last
// moved and its recent steps; then the team's board, and one combined log at the bottom.
// Numbers are counted (tool calls, messages, minutes), never estimated. Whether a member is
// working, stalled, waiting or lost is rubatoLiveness.ts, the rule the Agents panel uses too.
import { useAtomValue } from "@effect/atom-react";
import {
  BotIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  ClockIcon,
  CodeXmlIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { primaryServerProvidersAtom } from "../state/server";
import { type BoardItem, type BoardNode, useBoardNow, useStatusBoard } from "../state/rubatoStatusBoard";
import { ScrollArea } from "./ui/scroll-area";
import { LIVENESS_VISUALS, STALL_AFTER_MS, formatAgo, type Liveness } from "./rubatoLiveness";
import {
  type BoardFilter,
  type GroupView,
  type NodeView,
  boardCounts,
  clockTime,
  combinedLog,
  formatSpan,
  groupViews,
  shortModelName,
} from "./rubatoStatusBoardModel";
import { useBoardFolders } from "./rubatoBoardFolders";

const ROLE_ICONS: Record<string, LucideIcon> = {
  lead: SparklesIcon,
  owner: CodeXmlIcon,
  verifier: ShieldCheckIcon,
  subagent: BotIcon,
};

function useModelNames(): ReadonlyMap<string, string> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(
    () => new Map(providers.flatMap((provider) => provider.models.map((model) => [model.slug, model.name] as const))),
    [providers],
  );
}

export function RubatoStatusBoardPanel() {
  const { environmentId, folders } = useBoardFolders();
  const board = useStatusBoard(environmentId, folders, true);
  const now = useBoardNow(board);
  const models = useModelNames();
  const [filter, setFilter] = useState<BoardFilter>("all");
  const counts = boardCounts(board, now);
  const views = groupViews(board, now, filter);
  const log = combinedLog(groupViews(board, now));
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-5 pb-10" data-rubato-status-board="">
        <header className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <span>Teams</span>
            <span className="tabular-nums text-foreground">{counts.teams}</span>
            <span aria-hidden>·</span>
            <span>Working</span>
            <span className="tabular-nums text-foreground">{counts.working}</span>
            <span aria-hidden>·</span>
            <span>Stalled</span>
            <span className={cn("tabular-nums", counts.stalled > 0 ? "text-warning-foreground" : "text-foreground")}>
              {counts.stalled}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter">
            <FilterChip value="all" current={filter} onChange={setFilter} label="All" count={counts.working + counts.stalled + counts.resting + counts.lost} />
            <FilterChip value="working" current={filter} onChange={setFilter} label="Working" count={counts.working} state="working" />
            <FilterChip value="resting" current={filter} onChange={setFilter} label="Waiting" count={counts.resting} state="resting" />
            <FilterChip value="stalled" current={filter} onChange={setFilter} label="Stalled" count={counts.stalled} state="stalled" />
            <FilterChip value="lost" current={filter} onChange={setFilter} label="Lost" count={counts.lost} state="lost" />
            <span className="ml-auto text-xs text-muted-foreground/80">
              {`Stalled after ${STALL_AFTER_MS / 60_000} min without activity`}
            </span>
          </div>
        </header>
        {board === null ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Reading agents…</p>
        ) : views.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {filter === "all" ? "No teams or subagents in your projects right now." : "Nothing in this state."}
          </p>
        ) : (
          views.map((view) => <GroupCard key={view.group.id} view={view} now={now} models={models} />)
        )}
        {log.length > 0 ? <LogPanel lines={log} /> : null}
      </div>
    </ScrollArea>
  );
}

function FilterChip(props: {
  value: BoardFilter;
  current: BoardFilter;
  onChange: (value: BoardFilter) => void;
  label: string;
  count: number;
  state?: Liveness;
}) {
  const active = props.value === props.current;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => props.onChange(props.value)}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
        active ? "border-foreground/30 bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent/50",
      )}
    >
      {props.state ? <Dot state={props.state} /> : null}
      <span>{props.label}</span>
      <span className="tabular-nums">{props.count}</span>
    </button>
  );
}

function Dot({ state, className }: { state: Liveness; className?: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", LIVENESS_VISUALS[state].dotClass, className)} />;
}

function StateBadge({ view, now }: { view: NodeView; now: number }) {
  const visuals = LIVENESS_VISUALS[view.liveness];
  const ago = formatAgo(view.node.lastActivityAt, now);
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      <span className={cn("flex items-center gap-1.5 text-xs font-medium", visuals.textClass)} data-liveness={view.liveness}>
        <Dot state={view.liveness} />
        <span>{visuals.label}</span>
      </span>
      {ago ? <span className="text-[.7rem] tabular-nums text-muted-foreground" data-rubato-ago="">{ago}</span> : null}
    </span>
  );
}

function GroupCard({ view, now, models }: { view: GroupView; now: number; models: ReadonlyMap<string, string> }) {
  const { group } = view;
  const title = group.kind === "team" ? group.name : (group.name ?? "Subagents");
  const folder = group.cwd.split("/").filter(Boolean).at(-1) ?? group.cwd;
  const elapsed = formatSpan(group.startedAt, now);
  return (
    <section className="rounded-xl border border-border/80 bg-card/40" data-rubato-board-group={group.kind}>
      <header className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        {group.kind === "team" ? (
          <UsersIcon aria-hidden className="size-4 text-muted-foreground" />
        ) : (
          <BotIcon aria-hidden className="size-4 text-muted-foreground" />
        )}
        <h2 className="truncate text-base font-semibold" translate="no">
          {title}
        </h2>
        {group.kind === "team" ? <span className="text-xs text-muted-foreground">Team</span> : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span translate="no">{folder}</span>
          {elapsed ? (
            <>
              <span aria-hidden>·</span>
              <ClockIcon aria-hidden className="size-3" />
              <span className="tabular-nums">{elapsed}</span>
            </>
          ) : null}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-y-3 p-4 lg:grid-cols-[minmax(13rem,17rem)_2.5rem_minmax(0,1fr)]">
        <LeadBox view={view.lead} now={now} models={models} />
        <div aria-hidden className="hidden self-center lg:block">
          <div className="h-px w-full bg-border" />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {view.members.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No member is running.</p>
          ) : (
            view.members.map((member, index) => (
              <Branch key={member.node.id} first={index === 0} last={index === view.members.length - 1} state={member.liveness}>
                <MemberCard view={member} now={now} models={models} />
              </Branch>
            ))
          )}
          {view.ended.length > 0 ? <EndedLine views={view.ended} /> : null}
        </div>
      </div>
      {group.board && group.board.length > 0 ? <BoardStrip items={group.board} /> : null}
    </section>
  );
}

/** The line from the lead into one member: a spine down the members' left edge and a stub to the card. */
function Branch(props: { first: boolean; last: boolean; state: Liveness; children: React.ReactNode }) {
  const lit = props.state === "working";
  return (
    <div className="relative lg:pl-6">
      <span
        aria-hidden
        className={cn(
          "absolute left-0 hidden w-px bg-border lg:block",
          props.first ? "top-1/2" : "-top-1.5",
          props.last ? "bottom-1/2" : "-bottom-1.5",
        )}
      />
      <span aria-hidden className={cn("absolute top-1/2 left-0 hidden h-px w-6 lg:block", lit ? "bg-info/60" : "bg-border")} />
      <span
        aria-hidden
        className={cn("absolute top-1/2 left-6 hidden size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full lg:block", lit ? "bg-info" : "bg-border")}
      />
      {props.children}
    </div>
  );
}

function roleIcon(role: string | null | undefined): LucideIcon {
  return ROLE_ICONS[role ?? ""] ?? BotIcon;
}

function LeadBox({ view, now, models }: { view: NodeView; now: number; models: ReadonlyMap<string, string> }) {
  const { node } = view;
  const Icon = roleIcon(node.role);
  const model = shortModelName(node.model, models);
  const isLead = node.role === "lead";
  return (
    <div
      className={cn(
        "flex flex-col gap-2 self-center rounded-lg border bg-background/70 p-3",
        view.liveness === "working" ? "border-info/50" : "border-border",
      )}
      data-rubato-board-lead=""
    >
      <div className="flex items-start gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {isLead ? <span>Lead</span> : <span translate="no">{node.name}</span>}
          </span>
          {model ? (
            <span className="truncate text-xs text-muted-foreground" translate="no">
              {model}
            </span>
          ) : null}
        </span>
        {isLead ? <StateBadge view={view} now={now} /> : null}
      </div>
      {isLead && node.narration ? (
        <p className="line-clamp-2 text-xs text-muted-foreground" translate="no" title={node.narration}>
          {node.narration}
        </p>
      ) : null}
    </div>
  );
}

const MemberCard = memo(function MemberCard({
  view,
  now,
  models,
}: {
  view: NodeView;
  now: number;
  models: ReadonlyMap<string, string>;
}) {
  const { node, liveness } = view;
  const Icon = roleIcon(node.role);
  const model = shortModelName(node.model, models);
  const ran = formatSpan(node.startedAt, node.endedAt ?? now);
  const dim = liveness === "lost";
  return (
    <article
      data-rubato-board-member={node.id}
      data-liveness={liveness}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border bg-background/70 p-3",
        liveness === "stalled" && "border-warning/50",
        liveness === "lost" && "border-destructive/40",
        liveness !== "stalled" && liveness !== "lost" && "border-border",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent">
          <Icon aria-hidden className="size-4" />
        </span>
        <div className={cn("flex min-w-0 flex-1 flex-col gap-1", dim && "opacity-70")}>
          <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="truncate font-semibold" translate="no" title={node.name ?? node.id}>
              {node.name ?? node.id}
            </span>
            {model ? (
              <span className="shrink-0 text-xs text-muted-foreground" translate="no">
                · {model}
              </span>
            ) : null}
            {node.role && node.role !== "subagent" ? (
              <span className="shrink-0 text-xs text-muted-foreground" translate="no">
                · {node.role}
              </span>
            ) : null}
          </div>
          <p className="line-clamp-2 text-sm font-medium text-foreground" translate="no" title={node.narration ?? undefined}>
            {node.narration ?? <span className="font-normal text-muted-foreground">{node.task ?? "—"}</span>}
          </p>
        </div>
        <StateBadge view={view} now={now} />
      </div>
      <MetaLine node={node} liveness={liveness} ran={ran} />
      {node.steps.length > 0 ? <Steps node={node} /> : null}
    </article>
  );
});

/** Counted facts only: tool calls, messages, how long it has run, and what it waits on. */
function MetaLine({ node, liveness, ran }: { node: BoardNode; liveness: Liveness; ran: string | null }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-9.5 text-[.72rem] text-muted-foreground">
      {node.toolCalls !== null ? (
        <span className="flex items-center gap-1">
          <WrenchIcon aria-hidden className="size-3" />
          <span>Tools</span>
          <span className="tabular-nums">{node.toolCalls}</span>
        </span>
      ) : null}
      {node.messages !== null ? (
        <span className="flex items-center gap-1">
          <MessageSquareTextIcon aria-hidden className="size-3" />
          <span>Messages</span>
          <span className="tabular-nums">{node.messages}</span>
        </span>
      ) : null}
      {ran ? (
        <span className="flex items-center gap-1">
          <ClockIcon aria-hidden className="size-3" />
          <span className="tabular-nums">{ran}</span>
        </span>
      ) : null}
      {node.pendingTool && (liveness === "working" || liveness === "stalled") ? (
        <span className="flex items-center gap-1">
          <SquareTerminalIcon aria-hidden className="size-3" />
          <span>Running</span>
          <span translate="no">{node.pendingTool}</span>
        </span>
      ) : null}
      {liveness === "lost" ? <span className="text-destructive-foreground">Its process is gone</span> : null}
    </p>
  );
}

function Steps({ node }: { node: BoardNode }) {
  const steps = node.steps.slice(-4).toReversed();
  return (
    <ol className="ml-9.5 flex flex-col border-l border-border/70 pl-3">
      {steps.map((step, index) => (
        <li key={`${step.at}-${index}`} className="relative flex min-w-0 items-baseline gap-2.5 py-0.5 text-xs">
          <span
            aria-hidden
            className={cn(
              "absolute top-1/2 -left-[15.5px] size-1.5 -translate-y-1/2 rounded-full",
              index === 0 ? "bg-foreground/60" : "bg-border",
            )}
          />
          <span className="shrink-0 font-mono text-[.68rem] tabular-nums text-muted-foreground">{clockTime(step.at)}</span>
          <span
            className={cn("min-w-0 truncate", step.kind === "tool" ? "font-mono text-[.7rem] text-muted-foreground" : "text-foreground/90")}
            translate="no"
            title={step.text}
          >
            {step.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function EndedLine({ views }: { views: ReadonlyArray<NodeView> }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:pl-6">
      {views.map((view) => (
        <span key={view.node.id} className="flex items-center gap-1.5">
          <Dot state={view.liveness} />
          <span translate="no">{view.node.name ?? view.node.id}</span>
          <span>{LIVENESS_VISUALS[view.liveness].label}</span>
        </span>
      ))}
    </p>
  );
}

const BOARD_STATUS: Record<BoardItem["status"], { label: string; icon: LucideIcon; className: string }> = {
  in_progress: { label: "In progress", icon: CircleDotIcon, className: "border-info/40 text-info-foreground" },
  claimed: { label: "Claimed", icon: CircleDashedIcon, className: "border-border text-foreground/90" },
  pending: { label: "Pending", icon: ClockIcon, className: "border-border text-muted-foreground" },
  completed: { label: "Completed", icon: CircleCheckIcon, className: "border-border/60 text-muted-foreground" },
};

function BoardStrip({ items }: { items: ReadonlyArray<BoardItem> }) {
  const [showDone, setShowDone] = useState(false);
  const open = items.filter((item) => item.status !== "completed");
  const done = items.filter((item) => item.status === "completed");
  const shown = showDone ? [...open, ...done] : open;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3" data-rubato-board-items="">
      <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodoIcon aria-hidden className="size-3.5" />
        <span>Board</span>
      </span>
      {shown.map((item) => {
        const status = BOARD_STATUS[item.status];
        const Icon = status.icon;
        return (
          <span
            key={item.id}
            title={item.subject}
            className={cn("flex h-7 max-w-[26rem] items-center gap-1.5 rounded-md border px-2.5 text-xs", status.className)}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="shrink-0 tabular-nums">#{item.id}</span>
            <span className="min-w-0 truncate" translate="no">
              {item.subject}
            </span>
            {item.owner ? (
              <span className="shrink-0 text-muted-foreground" translate="no">
                · {item.owner}
              </span>
            ) : null}
            <span className="shrink-0">· {status.label}</span>
          </span>
        );
      })}
      {done.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowDone((value) => !value)}
          className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/50"
        >
          {showDone ? "Hide completed" : `${done.length} completed`}
        </button>
      ) : null}
    </div>
  );
}

const WHO_CLASS: Record<string, string> = {
  lead: "text-violet-400",
  owner: "text-info-foreground",
  verifier: "text-warning-foreground",
};

function LogPanel({ lines }: { lines: ReturnType<typeof combinedLog> }) {
  return (
    <section className="rounded-xl border border-border/80 bg-card/40" data-rubato-board-log="">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <SquareTerminalIcon aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Log</h2>
      </header>
      <ol className="flex max-h-72 flex-col-reverse overflow-y-auto px-4 py-2 font-mono text-xs leading-6">
        {lines.toReversed().map((line, index) => (
          <li key={`${line.at}-${index}`} className="flex min-w-0 gap-3">
            <span className="shrink-0 tabular-nums text-muted-foreground">[{clockTime(line.at, true)}]</span>
            <span className={cn("max-w-56 shrink-0 truncate font-semibold", WHO_CLASS[line.role ?? ""] ?? "text-success-foreground")} translate="no">
              {line.group ? `${line.group}/` : ""}
              {line.role === "lead" ? "Lead" : line.who}:
            </span>
            <span className="min-w-0 truncate text-foreground/90" translate="no" title={line.text}>
              {line.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
