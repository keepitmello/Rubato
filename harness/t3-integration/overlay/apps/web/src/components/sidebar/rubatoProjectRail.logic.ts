// The project list every project-ordering surface shares, and what each
// project signals. Pure functions only; RubatoProjectRail.tsx, RubatoRecentBox.tsx,
// chat/RubatoHomeProjects.tsx and the surfaces in project-order-edits.mjs render them.
//
// One list, every place: the rail's top group, the home screen's tab row, the
// command palette's new-thread picker and the headline's picker show the same
// projects in the same order, and removing a project from one drops it into
// the others' "other projects". Until the user first edits the list it
// follows activity: projects touched in the last week are listed, newest
// first, and the rest are quiet. The first remove, add or move freezes that
// order into the stored state, and from then on the user's order holds.
// Projects under a temporary folder (eval runs make them by the dozen) start
// quiet either way; the user can still add one.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  isSidebarThreadWorking,
  resolveSidebarThreadSection,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  sortInboxThreadsByReturn,
} from "../Sidebar.logic";

export const RUBATO_QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const RUBATO_RECENT_LIMIT = 5;
export const RUBATO_HOME_THREAD_LIMIT = 6;

export interface RubatoProjectListState {
  /** The listed projects in the user's order; null until the first edit. */
  readonly order: readonly string[] | null;
  /** Projects the user removed from the list, shown dimmed in the rail. */
  readonly hidden: readonly string[];
}

export const EMPTY_PROJECT_LIST_STATE: RubatoProjectListState = { order: null, hidden: [] };

interface ProjectRefLike {
  readonly environmentId: string;
  readonly projectId: string;
}

export interface RubatoGroupLike {
  readonly projectKey: string;
  readonly memberProjectRefs: readonly ProjectRefLike[];
  readonly workspaceRoot?: string;
}

const TEMPORARY_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

/** A project in a throwaway folder, which never earns a place on the list by itself. */
export function isTemporaryProject(group: Pick<RubatoGroupLike, "workspaceRoot">): boolean {
  const root = group.workspaceRoot;
  return root !== undefined && TEMPORARY_ROOTS.some((prefix) => root.startsWith(prefix));
}

export interface RubatoProjectList<G> {
  readonly listed: readonly G[];
  readonly quiet: readonly G[];
}

/** The whole list in one line, as a surface without sections shows it: listed, then quiet. */
export function projectListInOrder<G>(list: RubatoProjectList<G>): G[] {
  return [...list.listed, ...list.quiet];
}

type ThreadShell = EnvironmentThreadShell;

const memberKey = (ref: ProjectRefLike) => `${ref.environmentId}:${ref.projectId}`;

/** Maps each member project (`environmentId:projectId`) to its group's key. */
export function groupKeyByMember(groups: readonly RubatoGroupLike[]): Map<string, string> {
  const byMember = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) byMember.set(memberKey(ref), group.projectKey);
  }
  return byMember;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** When a thread last moved: created, last sent to, or its latest run asked or finished. */
export function threadActivityMs(thread: ThreadShell): number {
  return Math.max(
    timestampMs(thread.createdAt),
    timestampMs(thread.latestUserAuthoredMessageAt ?? null),
    timestampMs(thread.latestRun?.requestedAt ?? null),
    timestampMs(thread.latestRun?.completedAt ?? null),
  );
}

/** The latest activity per group, from every thread that is not archived. */
export function lastActivityByGroup(
  groups: readonly RubatoGroupLike[],
  threads: readonly ThreadShell[],
): Map<string, number> {
  const byMember = groupKeyByMember(groups);
  const latest = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = byMember.get(`${thread.environmentId}:${thread.projectId}`);
    if (key === undefined) continue;
    const at = threadActivityMs(thread);
    if (at > (latest.get(key) ?? 0)) latest.set(key, at);
  }
  return latest;
}

export function resolveProjectList<G extends RubatoGroupLike>(input: {
  readonly groups: readonly G[];
  readonly state: RubatoProjectListState;
  readonly lastActivity: ReadonlyMap<string, number>;
  readonly now: number;
}): RubatoProjectList<G> {
  const { groups, state, lastActivity, now } = input;
  const byKey = new Map(groups.map((group) => [group.projectKey, group] as const));
  const newestFirst = (a: G, b: G) =>
    (lastActivity.get(b.projectKey) ?? 0) - (lastActivity.get(a.projectKey) ?? 0);
  if (state.order === null) {
    const hidden = new Set(state.hidden);
    const sorted = groups.toSorted(newestFirst);
    const isListed = (group: G) =>
      !hidden.has(group.projectKey) &&
      !isTemporaryProject(group) &&
      now - (lastActivity.get(group.projectKey) ?? 0) <= RUBATO_QUIET_AFTER_MS;
    return {
      listed: sorted.filter(isListed),
      quiet: sorted.filter((group) => !isListed(group)),
    };
  }
  const placed = new Set([...state.order, ...state.hidden]);
  const pick = (keys: readonly string[]) =>
    keys.flatMap((key) => {
      const group = byKey.get(key);
      return group ? [group] : [];
    });
  // A project added after the last edit is listed at the end: it is new, so
  // it is probably where the user is about to work. A temporary one is not.
  const unplaced = groups.filter((group) => !placed.has(group.projectKey)).toSorted(newestFirst);
  return {
    listed: [...pick(state.order), ...unplaced.filter((group) => !isTemporaryProject(group))],
    quiet: [...pick(state.hidden), ...unplaced.filter(isTemporaryProject)],
  };
}

/** The project window's search: names containing the query, either section. */
export function filterProjectList<G extends RubatoGroupLike & { readonly displayName: string }>(
  list: RubatoProjectList<G>,
  query: string,
): RubatoProjectList<G> {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return list;
  const matches = (group: G) => group.displayName.toLocaleLowerCase().includes(needle);
  return { listed: list.listed.filter(matches), quiet: list.quiet.filter(matches) };
}

/** The strongest signal the user should act on, over every project. */
export function strongestUrgentSignal(
  signals: ReadonlyMap<string, RubatoSignal>,
): RubatoSignal | null {
  let strongest: RubatoSignal | null = null;
  for (const signal of signals.values()) {
    if (isUrgentSignal(signal)) strongest = strongerSignal(strongest, signal);
  }
  return strongest;
}

const keysOf = (groups: readonly RubatoGroupLike[]) => groups.map((group) => group.projectKey);

/** Takes `key` out of the list; it joins the front of the quiet group. */
export function removeFromProjectList(
  list: RubatoProjectList<RubatoGroupLike>,
  key: string,
): RubatoProjectListState {
  return {
    order: keysOf(list.listed).filter((candidate) => candidate !== key),
    hidden: [key, ...keysOf(list.quiet).filter((candidate) => candidate !== key)],
  };
}

/** Puts `key` back at the end of the list. */
export function addToProjectList(
  list: RubatoProjectList<RubatoGroupLike>,
  key: string,
): RubatoProjectListState {
  return {
    order: [...keysOf(list.listed).filter((candidate) => candidate !== key), key],
    hidden: keysOf(list.quiet).filter((candidate) => candidate !== key),
  };
}

/**
 * Moves `key` to the position `overKey` holds, as a drag ending over it does.
 * The two can sit in different sections (the legacy sidebar shows both as one
 * list): `key` then joins `overKey`'s section.
 */
export function moveInProjectList(
  list: RubatoProjectList<RubatoGroupLike>,
  key: string,
  overKey: string,
): RubatoProjectListState {
  const order = keysOf(list.listed);
  const hidden = keysOf(list.quiet);
  const known = (candidate: string) => order.includes(candidate) || hidden.includes(candidate);
  if (key === overKey || !known(key) || !known(overKey)) return { order, hidden };
  const toSection = order.includes(overKey) ? order : hidden;
  const fromSection = order.includes(key) ? order : hidden;
  const to = toSection.indexOf(overKey);
  // Dragged down within its own section, it lands after `overKey`; across
  // sections it takes `overKey`'s place.
  const after = fromSection === toSection && fromSection.indexOf(key) < to;
  fromSection.splice(fromSection.indexOf(key), 1);
  toSection.splice(after ? toSection.indexOf(overKey) + 1 : toSection.indexOf(overKey), 0, key);
  return { order, hidden };
}

/** What a thread or a project shows as a dot, strongest first. */
export type RubatoSignal = "attention" | "failed" | "done" | "working";

/** The words and dot colors for a signal, matching the sidebar rows' status hues. */
export const RUBATO_SIGNAL_LABEL: Record<RubatoSignal, string> = {
  attention: "Needs you",
  failed: "Failed",
  done: "Done",
  working: "Working",
};
export const RUBATO_SIGNAL_DOT: Record<RubatoSignal, string> = {
  attention: "bg-warning",
  failed: "bg-error",
  done: "bg-success",
  working: "bg-info",
};
const SIGNAL_RANK: Record<RubatoSignal, number> = { attention: 4, failed: 3, done: 2, working: 1 };

/**
 * What earns a dot or a word on the rail, the tabs and the one-line rows: only
 * what asks the user to act. Work in progress and unread finishes stay with
 * the sidebar's own cards, so the compact surfaces stay quiet.
 */
export function isUrgentSignal(
  signal: RubatoSignal | null | undefined,
): signal is "attention" | "failed" {
  return signal === "attention" || signal === "failed";
}

/** The signal a compact surface shows, or null. */
export function urgentSignal(signal: RubatoSignal | null | undefined): RubatoSignal | null {
  return isUrgentSignal(signal) ? signal : null;
}

export function strongerSignal(
  a: RubatoSignal | null,
  b: RubatoSignal | null,
): RubatoSignal | null {
  if (a === null) return b;
  if (b === null) return a;
  return SIGNAL_RANK[a] >= SIGNAL_RANK[b] ? a : b;
}

/**
 * The same reading the sidebar rows use (resolveSidebarThreadStatus and the
 * unseen-completion check): approval and input ask for the user, a failed
 * run is next, then a finished run the user has not opened, then work in
 * progress.
 */
export function resolveThreadSignal(
  thread: ThreadShell,
  localLastVisitedAt: string | undefined,
): RubatoSignal | null {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return "attention";
  if (status === "failed" || status === "limited") return "failed";
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) return "done";
  if (status === "working") return "working";
  return null;
}

export function threadKeyOf(thread: Pick<ThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** The strongest signal per group, over the threads the sidebar would show. */
export function signalByGroup(
  groups: readonly RubatoGroupLike[],
  threads: readonly ThreadShell[],
  localLastVisitedAtByKey: Readonly<Record<string, string>>,
): Map<string, RubatoSignal> {
  const byMember = groupKeyByMember(groups);
  const signals = new Map<string, RubatoSignal>();
  for (const thread of filterSidebarV2VisibleThreads(threads, null)) {
    const key = byMember.get(`${thread.environmentId}:${thread.projectId}`);
    if (key === undefined) continue;
    const signal = resolveThreadSignal(thread, localLastVisitedAtByKey[threadKeyOf(thread)]);
    const strongest = strongerSignal(signals.get(key) ?? null, signal);
    if (strongest !== null) signals.set(key, strongest);
  }
  return signals;
}

/**
 * The Recent box: the first rows of the all-projects inbox, as the sidebar
 * would order them with no project selected. Pinned, snoozed and settled
 * threads keep their own shelves there, and with the Working shelf on,
 * running threads fold into it, so none of them lead the inbox.
 */
export function selectRecentThreads(input: {
  readonly threads: readonly ThreadShell[];
  readonly supportsSettlement: (thread: ThreadShell) => boolean;
  readonly supportsSnooze: (thread: ThreadShell) => boolean;
  readonly workingShelfEnabled: boolean;
  readonly returnedAt: ((thread: ThreadShell) => number | undefined) | undefined;
  readonly now: string;
  readonly limit?: number;
}): ThreadShell[] {
  const inbox: ThreadShell[] = [];
  for (const thread of filterSidebarV2VisibleThreads(input.threads, null)) {
    const section = resolveSidebarThreadSection({
      snoozed: input.supportsSnooze(thread) && effectiveSnoozed(thread, { now: input.now }),
      settled: input.supportsSettlement(thread) && thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    if (section !== "active") continue;
    if (input.workingShelfEnabled && isSidebarThreadWorking(thread)) continue;
    inbox.push(thread);
  }
  const ordered = input.workingShelfEnabled
    ? sortInboxThreadsByReturn(inbox, input.returnedAt)
    : inbox.toSorted((a, b) => threadActivityMs(b) - threadActivityMs(a));
  return ordered.slice(0, input.limit ?? RUBATO_RECENT_LIMIT);
}

/**
 * The home screen's list: the newest threads of the selected project, settled
 * ones included, because "what was I doing there" is history too. With no
 * project selected it spans every project.
 */
export function selectHomeThreads(input: {
  readonly threads: readonly ThreadShell[];
  readonly group: RubatoGroupLike | null;
  readonly limit?: number;
}): ThreadShell[] {
  const members =
    input.group === null ? null : new Set(input.group.memberProjectRefs.map(memberKey));
  return filterSidebarV2VisibleThreads(input.threads, members)
    .toSorted((a, b) => threadActivityMs(b) - threadActivityMs(a))
    .slice(0, input.limit ?? RUBATO_HOME_THREAD_LIMIT);
}

/** Whether any of the given tabs carries a signal the user should act on. */
export function anyNeedsUser(signals: readonly (RubatoSignal | null | undefined)[]): boolean {
  return signals.some(isUrgentSignal);
}

/**
 * Where a new thread goes while the sidebar is narrowed to one project: the
 * current thread's own project when it belongs to that group, else the
 * group's member on the current thread's machine, else the group's own
 * project. Null with no project selected, so the caller keeps T3's flow.
 */
export function scopedNewThreadProjectRef<R extends ProjectRefLike>(input: {
  readonly group: {
    readonly environmentId: string;
    readonly id: string;
    readonly memberProjectRefs: readonly R[];
  } | null;
  readonly contextProjectRef: ProjectRefLike | null;
}): R | null {
  const group = input.group;
  if (group === null) return null;
  const context = input.contextProjectRef;
  const members = group.memberProjectRefs;
  return (
    (context &&
      (members.find((ref) => memberKey(ref) === memberKey(context)) ??
        members.find((ref) => ref.environmentId === context.environmentId))) ||
    members.find((ref) => ref.environmentId === group.environmentId && ref.projectId === group.id) ||
    members[0] ||
    null
  );
}
