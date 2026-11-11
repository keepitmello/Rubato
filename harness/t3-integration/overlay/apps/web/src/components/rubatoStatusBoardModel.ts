/**
 * What the status board page and the sidebar entry draw, from the server's board
 * (state/rubatoStatusBoard.ts) and the liveness rule (rubatoLiveness.ts). Pure, so the counts
 * the badge shows and the rows the page lists come from one place.
 */
import type { BoardGroup, BoardLogLine, BoardNode, BoardOpen, StatusBoard } from "../state/rubatoStatusBoard";
import { STALL_AFTER_MS, countLiveness, isOnBoard, livenessOf, type Liveness, type LivenessCounts } from "./rubatoLiveness";

export type BoardFilter = "all" | "working" | "resting" | "stalled" | "lost";

/** A team whose members and work items have all been quiet this long is past work, folded away. */
export const PAST_AFTER_MS = 24 * 60 * 60_000;

export interface NodeView {
  readonly node: BoardNode;
  readonly liveness: Liveness;
}

/**
 * Where a team's work stands, from its board and its members, not from any one process:
 * - working: a member is at work.
 * - completed: every board item is done and no member is in a turn. Its members may still be
 *   resident and available; that is not the same as waiting on work.
 * - stalled: work items remain, nobody is in a turn, and the team has been quiet past the stall
 *   threshold; or a member's open turn has itself gone quiet. A brief wait is "waiting".
 * - waiting: work remains and the quiet is shorter than the threshold.
 * - idle: no work items and no one in a turn.
 */
export type WorkState = "working" | "completed" | "stalled" | "waiting" | "idle";

export interface TeamWork {
  readonly state: WorkState;
  /** Board items not completed, and all of them. */
  readonly open: number;
  readonly total: number;
  /** Why it is stalled: work left with nobody in a turn, or a member's turn gone quiet. */
  readonly reason: "work-left" | "member-quiet" | null;
  /** When a member or a work item last moved; the quiet a stall counts from. */
  readonly lastMovedAt: number | null;
}

export interface GroupView {
  readonly group: BoardGroup;
  readonly lead: NodeView;
  /** Members still on the board (working, stalled, resting) and lost ones, in roster order. */
  readonly members: ReadonlyArray<NodeView>;
  /** Members whose run ended (done, failed, stopped): one quiet line under the rest. */
  readonly ended: ReadonlyArray<NodeView>;
  readonly counts: LivenessCounts;
  readonly work: TeamWork;
  /** Its own members and work items have been quiet past PAST_AFTER_MS. */
  readonly past: boolean;
  /**
   * Which lead conversation it belongs to: its environment and the lead's session id. Groups with
   * the same key show that lead once (leadBlocks). A lead without a session id is its own.
   */
  readonly leadKey: string;
}

/** One lead conversation and the groups (teams, subagents) it started, newest first. */
export interface LeadBlock {
  readonly key: string;
  /** The lead, from its newest group: every group of one block has the same conversation. */
  readonly lead: NodeView;
  readonly groups: ReadonlyArray<GroupView>;
  /** Shown in an earlier section already: this block lists its groups without a second lead card. */
  readonly leadShownAbove: boolean;
}

export interface BoardSections {
  /** Newest-created first. */
  readonly current: ReadonlyArray<GroupView>;
  /** Folded below, newest-created first too. */
  readonly past: ReadonlyArray<GroupView>;
}

export const nodeView = (node: BoardNode, now: number): NodeView => ({ node, liveness: livenessOf(node, now) });

const latest = (values: ReadonlyArray<number | null | undefined>): number | null => {
  let best: number | null = null;
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && (best === null || value > best)) best = value;
  return best;
};

/**
 * When the team's own work last moved: a member's activity, a work item's change, or the team's
 * start. The lead's activity does not count: its conversation goes on with other work.
 */
export function teamMovedAt(group: BoardGroup): number | null {
  return latest([
    group.startedAt,
    ...group.members.map((member) => member.lastActivityAt),
    ...(group.board ?? []).map((item) => item.updatedAt),
    group.boardSummary?.updatedAt,
  ]);
}

export function teamWork(group: BoardGroup, members: ReadonlyArray<NodeView>, now: number): TeamWork {
  // The count over the whole board when the server sent one: the shown items can be a part.
  const items = group.board ?? [];
  const open = group.boardSummary?.open ?? items.filter((item) => item.status !== "completed").length;
  const total = group.boardSummary?.total ?? items.length;
  const lastMovedAt = teamMovedAt(group);
  const base = { open, total, lastMovedAt };
  if (members.some((member) => member.liveness === "working")) return { ...base, state: "working", reason: null };
  if (members.some((member) => member.liveness === "stalled")) return { ...base, state: "stalled", reason: "member-quiet" };
  if (total > 0 && open === 0) return { ...base, state: "completed", reason: null };
  if (open > 0) {
    const quiet = lastMovedAt === null ? Infinity : now - lastMovedAt;
    return quiet >= STALL_AFTER_MS ? { ...base, state: "stalled", reason: "work-left" } : { ...base, state: "waiting", reason: null };
  }
  return { ...base, state: "idle", reason: null };
}

/** Newest-created first; an unknown start goes last; ties by id, so the order never shuffles. */
export function byNewest(a: BoardGroup, b: BoardGroup): number {
  const at = (group: BoardGroup) => group.startedAt ?? -Infinity;
  return at(b) - at(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const matches = (view: NodeView, filter: BoardFilter) => filter === "all" || view.liveness === filter;

/**
 * A lead's identity: the same Pi session in the same environment. Never its name: every lead is
 * called "Lead". A session id from another environment is another conversation.
 */
export function leadKeyOf(group: BoardGroup, environmentId: string | null | undefined): string {
  const sessionId = group.lead.sessionId;
  const environment = group.environmentId ?? environmentId ?? "";
  // A lead it cannot name stays with its own group alone, which is itself one only in its folder
  // and environment: two environments can hold the same team run id.
  return sessionId
    ? `lead\u0000${environment}\u0000${sessionId}`
    : `group\u0000${environment}\u0000${group.cwd}\u0000${group.id}`;
}

function viewOf(group: BoardGroup, now: number, filter: BoardFilter, environmentId: string | null | undefined): GroupView | null {
  const all = group.members.map((node) => nodeView(node, now));
  const counts = countLiveness(all.map((view) => view.liveness));
  const shown = all.filter((view) => isOnBoard(view.liveness) || view.liveness === "lost");
  const ended = all.filter((view) => !isOnBoard(view.liveness) && view.liveness !== "lost");
  const work = teamWork(group, all, now);
  const movedAt = teamMovedAt(group);
  const past = movedAt === null || now - movedAt > PAST_AFTER_MS;
  // Under "stalled", a team whose remaining work stalled shows whole: its members are idle, not
  // stalled themselves. A member's own quiet turn shows that member.
  const workStalled = filter === "stalled" && work.state === "stalled" && work.reason === "work-left";
  const members = filter === "all" || workStalled ? shown : shown.filter((view) => matches(view, filter));
  if (filter !== "all" && members.length === 0) return null;
  return { group, lead: nodeView(group.lead, now), members, ended: filter === "all" ? ended : [], counts, work, past,
    leadKey: leadKeyOf(group, environmentId) };
}

/**
 * Groups under their lead, once per lead conversation. Blocks come in the order of their newest
 * group and groups keep their newest-first order inside, so the newest team still leads the page.
 * `shownAbove` names leads an earlier section already shows: their block here has no lead card.
 */
export function leadBlocks(views: ReadonlyArray<GroupView>, shownAbove: ReadonlySet<string> = new Set()): LeadBlock[] {
  const blocks = new Map<string, { lead: NodeView; groups: GroupView[] }>();
  for (const view of views) {
    const held = blocks.get(view.leadKey);
    if (held) held.groups.push(view);
    else blocks.set(view.leadKey, { lead: view.lead, groups: [view] });
  }
  return [...blocks].map(([key, block]) => ({ key, ...block, leadShownAbove: shownAbove.has(key) }));
}

export function boardSections(board: StatusBoard | null, now: number, filter: BoardFilter = "all"): BoardSections {
  const views = [...(board?.groups ?? [])].sort(byNewest).flatMap((group) => {
    const view = viewOf(group, now, filter, board?.environmentId);
    return view ? [view] : [];
  });
  return { current: views.filter((view) => !view.past), past: views.filter((view) => view.past) };
}

/** The current groups and the past ones, in the order the page lists them. */
export function groupViews(board: StatusBoard | null, now: number, filter: BoardFilter = "all"): GroupView[] {
  const { current, past } = boardSections(board, now, filter);
  return [...current, ...past];
}

/**
 * Members' states across current work only: the badge, the header line and the filter chips.
 * A past team's members are counted where it is listed, not in what needs attention now.
 */
export function boardCounts(
  board: StatusBoard | null,
  now: number,
): LivenessCounts & { readonly teams: number; readonly stalledTeams: number; readonly past: number } {
  const { current, past } = boardSections(board, now);
  const states = current.flatMap((view) => view.group.members.map((node) => livenessOf(node, now)));
  return {
    ...countLiveness(states),
    teams: current.filter((view) => view.group.kind === "team").length,
    // Teams whose remaining work stalled with nobody in a turn; a member's own quiet turn is in `stalled`.
    stalledTeams: current.filter((view) => view.work.state === "stalled" && view.work.reason === "work-left").length,
    past: past.length,
  };
}

/**
 * A model as people say it: "anthropic/claude-opus-5-5" → "Opus 5.5", "openai-codex/gpt-6.1-sol"
 * → "GPT 6.1 Sol". `known` is the provider catalogue's names by slug, which wins when it has one.
 */
export function shortModelName(model: string | null, known?: ReadonlyMap<string, string>): string | null {
  if (!model) return null;
  const named = known?.get(model) ?? known?.get(model.split("/").at(-1) ?? "");
  if (named) return named;
  const id = (model.split("/").at(-1) ?? model).replace(/^claude-/, "").replace(/-\d{8}$/, "");
  return id
    .replace(/(\d+)-(\d+)(?=$|-)/g, "$1.$2")
    .split("-")
    .map((word) => (/^gpt$/i.test(word) ? "GPT" : word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export interface CombinedLogLine extends BoardLogLine {
  readonly group: string | null;
}

/**
 * All groups' lines in time order, the newest last; a group name joins the speaker when there are
 * several. A lead several groups share says each line once, under no team's name.
 */
export function combinedLog(views: ReadonlyArray<GroupView>, limit = 60): CombinedLogLine[] {
  const several = views.length > 1;
  const sharedLeads = new Set(
    leadBlocks(views).filter((block) => block.groups.length > 1).map((block) => block.key),
  );
  const seen = new Set<string>();
  return views
    .flatMap((view) =>
      view.group.log.flatMap((line) => {
        const shared = line.role === "lead" && sharedLeads.has(view.leadKey);
        if (shared) {
          const key = `${view.leadKey}\u0000${line.at}\u0000${line.text}`;
          if (seen.has(key)) return [];
          seen.add(key);
        }
        return [{ ...line, group: several && !shared ? view.group.name : null }];
      }),
    )
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}

/** "15:24:17" in the person's clock. */
export function clockTime(at: number | null, seconds = false): string {
  if (at === null) return "";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;
}

/** "12m", "1h 05m", "30d 4h": how long something has run, for counted meta lines. */
export function formatSpan(fromMs: number | null, toMs: number): string | null {
  if (fromMs === null) return null;
  const minutes = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "14:05" today, "11/09 14:05" before: when a team's work last moved. */
export function sinceLabel(at: number | null, now: number): string {
  if (at === null) return "—";
  const date = new Date(at);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const pad = (value: number) => String(value).padStart(2, "0");
  return sameDay ? clockTime(at) : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${clockTime(at)}`;
}

/** Why the team reads as it does, in words about the work, not about any process. */
export function workReason(work: TeamWork, now: number): string | null {
  if (work.state === "completed") return `All ${work.total} work items are done · members are free for new work`;
  if (work.state === "stalled" && work.reason === "work-left")
    return `${work.open} work items left · no member has worked since ${sinceLabel(work.lastMovedAt, now)}`;
  if (work.state === "stalled") return `A member's turn has been quiet for over ${STALL_AFTER_MS / 60_000} min`;
  return null;
}

/**
 * Where a card's conversation can't be opened, and why: the board does not make one up.
 * Undefined while the app is still asked which thread shows it.
 */
export function unavailableReason(
  target: BoardOpen | null | undefined,
  thread: string | null | undefined,
): string | null | undefined {
  if (!target || (!target.hostSessionId && target.reason !== "nested")) return "Not linked to a conversation";
  if (target.reason === "nested") return "Opens inside its parent agent's conversation";
  if (target.agentId && !target.history) return "No saved conversation";
  if (thread === undefined) return undefined;
  if (thread === null) return "Its conversation isn't in the app";
  return null;
}
