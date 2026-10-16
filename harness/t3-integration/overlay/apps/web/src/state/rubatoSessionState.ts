import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { readPreparedConnection } from "./session";
import { rubatoHttpAccess } from "./rubatoHttp";

/**
 * What only Rubato's engine knows about a thread's conversation: its Speed score, its agents
 * and its taskforces. T3's V2 rows see a Rubato spawn as a plain tool call, so the Agents panel
 * and the composer's Speed label read this instead (GET /rubato/session-state, the server's
 * fold of the engine's task, board and speed records).
 */
export interface RubatoSessionAgent {
  readonly taskId: string;
  /** The Agent or task tool call that started it; its timeline row draws this agent. */
  readonly spawnToolCallId?: string | null;
  readonly label?: string | null;
  readonly title: string;
  readonly modelLabel?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly role?: string | null;
  readonly memberName?: string | null;
  readonly teamRunId?: string | null;
  readonly parentAgentId?: string | null;
  readonly status: "running" | "waiting" | "idle" | "completed" | "failed" | "stopped";
  readonly activity?: string | null;
  readonly lastToolName?: string | null;
  readonly result?: string | null;
  readonly error?: string | null;
  readonly speedIndex?: number | null;
  readonly turns?: number | null;
  readonly totalTokens?: number | null;
  readonly toolUses?: number | null;
  readonly activationCount?: number | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
}

export interface RubatoSessionTeam {
  readonly teamRunId: string;
  /** The team_create call that started it. */
  readonly spawnToolCallId?: string | null;
  readonly name: string;
  readonly members: ReadonlyArray<string>;
  readonly board: {
    readonly tasks: ReadonlyArray<{
      readonly id: string;
      readonly subject: string;
      readonly description: string;
      readonly descriptionTruncated?: boolean;
      readonly status: "pending" | "claimed" | "in_progress" | "completed";
      readonly owner?: string | null;
      readonly blockedBy?: ReadonlyArray<string>;
      readonly updatedAt?: string | null;
    }>;
  } | null;
}

export interface RubatoSessionState {
  readonly speedIndex: number | null;
  readonly agents: ReadonlyArray<RubatoSessionAgent>;
  readonly teams: ReadonlyArray<RubatoSessionTeam>;
}

export const EMPTY_SESSION_STATE: RubatoSessionState = { speedIndex: null, agents: [], teams: [] };

const ROUTE = "/rubato/session-state";
const POLL_MS = 2_000;

async function readSessionState(
  environmentId: EnvironmentId,
  threadId: string,
  signal: AbortSignal,
): Promise<RubatoSessionState | null> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) return null;
  const access = await rubatoHttpAccess(prepared);
  if (!access) return null;
  const response = await fetch(`${access.baseUrl}${ROUTE}?threadId=${encodeURIComponent(threadId)}`, {
    credentials: access.credentials,
    headers: access.headers,
    signal,
  });
  // A thread the server does not know (a draft, another provider) has no Rubato state.
  if (response.status === 404 || !response.ok) return EMPTY_SESSION_STATE;
  const payload = (await response.json().catch(() => null)) as Partial<RubatoSessionState> | null;
  return {
    speedIndex: typeof payload?.speedIndex === "number" ? payload.speedIndex : null,
    agents: Array.isArray(payload?.agents) ? payload.agents : [],
    teams: Array.isArray(payload?.teams) ? payload.teams : [],
  };
}

// The latest state per thread, so rows deep in the timeline read what ChatView polls.
const published = new Map<string, RubatoSessionState>();
const listeners = new Set<() => void>();
function publish(key: string, state: RubatoSessionState) {
  published.set(key, state);
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The state ChatView last polled for this thread, without polling again. */
export function usePublishedRubatoSessionState(threadKey: string | null): RubatoSessionState {
  return useSyncExternalStore(
    subscribe,
    () => (threadKey === null ? EMPTY_SESSION_STATE : (published.get(threadKey) ?? EMPTY_SESSION_STATE)),
  );
}

/** The thread's Rubato state, polled while mounted; empty for no thread. */
export function useRubatoSessionState(ref: ScopedThreadRef | null): RubatoSessionState {
  const [state, setState] = useState<RubatoSessionState>(EMPTY_SESSION_STATE);
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  useEffect(() => {
    setState(EMPTY_SESSION_STATE);
    if (environmentId === null || threadId === null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const next = await readSessionState(environmentId, threadId, abort.signal).catch(() => null);
      if (abort.signal.aborted) return;
      if (next) {
        setState(next);
        publish(scopedThreadKey(scopeThreadRef(environmentId, threadId)), next);
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      abort.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [environmentId, threadId]);
  return state;
}
