/**
 * What the status board page and the sidebar entry draw, from the server's board
 * (state/rubatoStatusBoard.ts) and the liveness rule (rubatoLiveness.ts). Pure, so the counts
 * the badge shows and the rows the page lists come from one place.
 */
import type { BoardGroup, BoardLogLine, BoardNode, StatusBoard } from "../state/rubatoStatusBoard";
import { countLiveness, isOnBoard, livenessOf, type Liveness, type LivenessCounts } from "./rubatoLiveness";

export type BoardFilter = "all" | "working" | "resting" | "stalled" | "lost";

export interface NodeView {
  readonly node: BoardNode;
  readonly liveness: Liveness;
}

export interface GroupView {
  readonly group: BoardGroup;
  readonly lead: NodeView;
  /** Members still on the board (working, stalled, resting) and lost ones, in roster order. */
  readonly members: ReadonlyArray<NodeView>;
  /** Members whose run ended (done, failed, stopped): one quiet line under the rest. */
  readonly ended: ReadonlyArray<NodeView>;
  readonly counts: LivenessCounts;
}

export const nodeView = (node: BoardNode, now: number): NodeView => ({ node, liveness: livenessOf(node, now) });

export function groupViews(board: StatusBoard | null, now: number, filter: BoardFilter = "all"): GroupView[] {
  return (board?.groups ?? []).flatMap((group) => {
    const all = group.members.map((node) => nodeView(node, now));
    const counts = countLiveness(all.map((view) => view.liveness));
    const shown = all.filter((view) => isOnBoard(view.liveness) || view.liveness === "lost");
    const ended = all.filter((view) => !isOnBoard(view.liveness) && view.liveness !== "lost");
    // A group of subagents that all ended a while ago is history, not status.
    if (group.kind === "agents" && shown.length === 0 && filter !== "all") return [];
    const members = filter === "all" ? shown : shown.filter((view) => matches(view.liveness, filter));
    if (filter !== "all" && members.length === 0) return [];
    return [{ group, lead: nodeView(group.lead, now), members, ended: filter === "all" ? ended : [], counts }];
  });
}

const matches = (liveness: Liveness, filter: BoardFilter) => filter === "all" || liveness === filter;

/** Every member's state across the board: the badge, the header line and the filter chips. */
export function boardCounts(board: StatusBoard | null, now: number): LivenessCounts & { readonly teams: number } {
  const states = (board?.groups ?? []).flatMap((group) => group.members.map((node) => livenessOf(node, now)));
  return { ...countLiveness(states), teams: (board?.groups ?? []).filter((group) => group.kind === "team").length };
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

/** All groups' lines in time order, the newest last; a group name joins the speaker when there are several. */
export function combinedLog(views: ReadonlyArray<GroupView>, limit = 60): CombinedLogLine[] {
  const several = views.length > 1;
  return views
    .flatMap((view) => view.group.log.map((line) => ({ ...line, group: several ? view.group.name : null })))
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

/** "12m", "1h 05m": how long something has run, for counted meta lines. */
export function formatSpan(fromMs: number | null, toMs: number): string | null {
  if (fromMs === null) return null;
  const minutes = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
