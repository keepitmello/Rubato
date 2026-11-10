import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { Lifecycle } from "../components/rubatoLiveness";
import { postRubato, rubatoHttpAccess } from "./rubatoHttp";
import { readPreparedConnection } from "./session";

/**
 * The status board's data (현황판): every team and standalone subagent in the app's projects,
 * as Rubato's server reads them off disk (src/status-board/scan.mjs behind /rubato/status-board).
 * One poller serves every reader: the sidebar entry's badge, the page, and the Agents panel's
 * liveness. Each reader registers the project folders it shows; the poll asks for their union.
 */
export interface BoardStep {
  readonly at: number | null;
  readonly kind: "say" | "tool";
  readonly text: string;
}

/**
 * Where a card's conversation is: the Pi session whose app thread shows it, and in that thread
 * the agent to open (none for a lead, whose thread is its conversation). `history` is false when
 * the agent left nothing to read (evicted, cleaned up); `reason` "nested" marks a subagent a
 * member started, which lives in that member's session and no app thread.
 */
export interface BoardOpen {
  readonly hostSessionId: string | null;
  readonly agentId: string | null;
  readonly history: boolean;
  readonly reason?: "nested";
}

export interface BoardNode {
  /** A subagent's task id (st_…), or a lead's session id. */
  readonly id: string;
  readonly sessionId: string | null;
  /** A team member's name, a subagent's task, or "lead". */
  readonly name?: string | null;
  /** lead, owner, verifier, member, subagent. */
  readonly role?: string | null;
  readonly task: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: string | null;
  readonly lifecycle: Lifecycle;
  readonly turnOpen: boolean;
  /** The tool it is waiting on, while a call has no result yet. */
  readonly pendingTool: string | null;
  readonly lastActivityAt: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The first line of what it last said. */
  readonly narration: string | null;
  readonly steps: ReadonlyArray<BoardStep>;
  /** Counted from its runner's event log; null when there is none (a lead). */
  readonly toolCalls: number | null;
  readonly messages: number | null;
  readonly parentSessionId: string | null;
  /** Where its conversation opens; null when the board cannot tell. */
  readonly open?: BoardOpen | null;
}

export interface BoardItem {
  readonly id: string;
  readonly subject: string;
  readonly status: "pending" | "claimed" | "in_progress" | "completed";
  readonly owner: string | null;
  readonly blockedBy: ReadonlyArray<string>;
  readonly updatedAt: number | null;
}

export interface BoardLogLine {
  readonly at: number;
  readonly who: string;
  readonly role: string | null;
  readonly text: string;
}

export interface BoardGroup {
  /** A taskforce, or the subagents one conversation started. */
  readonly kind: "team" | "agents";
  readonly id: string;
  readonly name: string | null;
  readonly status: string | null;
  readonly cwd: string;
  readonly startedAt: number | null;
  readonly lead: BoardNode;
  readonly members: ReadonlyArray<BoardNode>;
  /** The items shown: open ones first, then the newest completed, at most the server's limit. */
  readonly board: ReadonlyArray<BoardItem> | null;
  /** Counted over every item, shown or not. */
  readonly boardSummary?: { readonly total: number; readonly open: number; readonly updatedAt: number | null } | null;
  readonly log: ReadonlyArray<BoardLogLine>;
}

export interface StatusBoard {
  readonly version: string;
  readonly groups: ReadonlyArray<BoardGroup>;
  /** This page's clock minus the server's when it answered: the page counts in server time. */
  readonly clockOffset: number;
}

interface Answer {
  readonly now: number;
  readonly version: string;
  readonly unchanged?: boolean;
  readonly groups?: ReadonlyArray<BoardGroup>;
}

const ROUTE = "/rubato/status-board";
/** While the page or an Agents panel is open. */
const WATCH_POLL_MS = 2_000;
/** Only the sidebar's badge. */
const BADGE_POLL_MS = 5_000;
const HIDDEN_POLL_MS = 15_000;

interface Source {
  readonly environmentId: EnvironmentId | null;
  readonly cwds: ReadonlyArray<string>;
  readonly watching: boolean;
}

const sources = new Map<symbol, Source>();
const listeners = new Set<() => void>();
let board: StatusBoard | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let askedKey = "";

function notify() {
  for (const listener of listeners) listener();
}

function wanted(): { environmentId: EnvironmentId | null; cwds: string[]; watching: boolean } {
  let environmentId: EnvironmentId | null = null;
  const cwds = new Set<string>();
  let watching = false;
  for (const source of sources.values()) {
    environmentId ??= source.environmentId;
    for (const cwd of source.cwds) cwds.add(cwd);
    watching ||= source.watching;
  }
  return { environmentId, cwds: [...cwds].toSorted(), watching };
}

function schedule(delay: number) {
  if (timer !== null) clearTimeout(timer);
  timer = sources.size === 0 ? null : setTimeout(() => void poll(), delay);
}

async function poll() {
  timer = null;
  if (inFlight) return;
  const { environmentId, cwds, watching } = wanted();
  if (sources.size === 0) return;
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const next = hidden ? HIDDEN_POLL_MS : watching ? WATCH_POLL_MS : BADGE_POLL_MS;
  if (environmentId === null || cwds.length === 0) {
    schedule(next);
    return;
  }
  const key = cwds.join("\n");
  inFlight = true;
  try {
    const answer = await postRubato<Answer>(
      environmentId,
      ROUTE,
      "read",
      { cwds, ...(board && askedKey === key ? { version: board.version } : {}) },
      "status board",
    );
    const clockOffset = Date.now() - answer.now;
    if (answer.unchanged && board && askedKey === key) {
      if (Math.abs(board.clockOffset - clockOffset) > 1_000) board = { ...board, clockOffset };
    } else if (Array.isArray(answer.groups)) {
      board = { version: answer.version, groups: answer.groups, clockOffset };
      askedKey = key;
    }
    notify();
  } catch {
    // The badge and page keep the last answer; the next poll tries again.
  } finally {
    inFlight = false;
    schedule(next);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const read = () => board;

/**
 * Registers the folders this reader shows and returns the latest board (null until the first
 * answer). `watching` asks for the faster poll.
 */
export function useStatusBoard(
  environmentId: EnvironmentId | null,
  cwds: ReadonlyArray<string>,
  watching: boolean,
): StatusBoard | null {
  const key = cwds.join("\n");
  useEffect(() => {
    const id = Symbol("status-board-source");
    sources.set(id, { environmentId, cwds: key ? key.split("\n") : [], watching });
    // A new folder or a faster reader is asked about now, not at the next tick.
    schedule(0);
    return () => {
      sources.delete(id);
      if (sources.size === 0) schedule(0);
    };
  }, [environmentId, key, watching]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The board's nodes by id, for a reader that looks agents up (the Agents panel). */
export function useBoardNodes(boardValue: StatusBoard | null): ReadonlyMap<string, BoardNode> {
  return useMemo(() => {
    const nodes = new Map<string, BoardNode>();
    for (const group of boardValue?.groups ?? []) for (const node of group.members) nodes.set(node.id, node);
    return nodes;
  }, [boardValue]);
}

// One clock for everything that counts "12s ago", so a page of rows ticks once.
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickNow = Date.now();
function subscribeTick(listener: () => void) {
  tickListeners.add(listener);
  if (tickTimer === null) {
    tickNow = Date.now();
    tickTimer = setInterval(() => {
      tickNow = Date.now();
      for (const each of tickListeners) each();
    }, 1_000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
const readTick = () => tickNow;

/** Now, in the server's time, refreshed every second while something shows it. */
export function useBoardNow(boardValue: StatusBoard | null): number {
  const now = useSyncExternalStore(subscribeTick, readTick, readTick);
  return now - (boardValue?.clockOffset ?? 0);
}

// Which app thread shows each Pi session (/rubato/board-threads), asked once per new session.
const THREADS_ROUTE = "/rubato/board-threads";
const threadsBySession = new Map<string, { readonly thread: string | null; readonly at: number }>();
/** A session no thread showed is asked again after this: the inventory may import it since. */
const NO_THREAD_RETRY_MS = 30_000;
const threadListeners = new Set<() => void>();
let threadsVersion = 0;
const asking = new Set<string>();

async function askThreads(environmentId: EnvironmentId, sessionIds: ReadonlyArray<string>) {
  const now = Date.now();
  const missing = sessionIds.filter((id) => {
    const held = threadsBySession.get(id);
    return !asking.has(id) && (held === undefined || (held.thread === null && now - held.at > NO_THREAD_RETRY_MS));
  });
  if (missing.length === 0) return;
  for (const id of missing) asking.add(id);
  try {
    const prepared = readPreparedConnection(environmentId);
    const access = prepared ? await rubatoHttpAccess(prepared) : null;
    if (!access) return;
    const response = await fetch(`${access.baseUrl}${THREADS_ROUTE}`, {
      method: "POST",
      credentials: access.credentials,
      headers: { ...access.headers, "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: missing }),
    });
    if (!response.ok) return;
    const answer = (await response.json().catch(() => null)) as { threads?: Record<string, string | null> } | null;
    for (const id of missing) threadsBySession.set(id, { thread: answer?.threads?.[id] ?? null, at: Date.now() });
    threadsVersion += 1;
    for (const listener of threadListeners) listener();
  } catch {
    // Asked again when the board next shows it.
  } finally {
    for (const id of missing) asking.delete(id);
  }
}

/**
 * The app thread of each host session the board shows: a thread id, null when no thread shows
 * it, undefined while it is being asked.
 */
export function useBoardThreads(
  environmentId: EnvironmentId | null,
  boardValue: StatusBoard | null,
): (sessionId: string | null | undefined) => string | null | undefined {
  const ids = useMemo(() => {
    const hosts = new Set<string>();
    for (const group of boardValue?.groups ?? [])
      for (const node of [group.lead, ...group.members])
        if (node.open?.hostSessionId) hosts.add(node.open.hostSessionId);
    return [...hosts].toSorted().join("\n");
  }, [boardValue]);
  // Asked with each board answer, so a session no thread showed is found once one does.
  useEffect(() => {
    if (environmentId === null || ids === "") return;
    void askThreads(environmentId, ids.split("\n"));
  }, [environmentId, ids, boardValue]);
  useSyncExternalStore(
    (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    () => threadsVersion,
    () => threadsVersion,
  );
  return (sessionId) => (sessionId ? threadsBySession.get(sessionId)?.thread : null);
}
