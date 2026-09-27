import type { EnvironmentId, RubatoCacheSnapshot } from "@t3tools/contracts";

import { rubatoHttpAccess } from "./rubatoHttp";
import { readPreparedConnection } from "./session";

/** The route Rubato adds to the T3 server for the context ring's warmer switch. */
const CACHE_WARMING_ROUTE = "/rubato/cache-warming";

/** Sets one session's warmer (on/off, hours); answers with that session's cache after it. */
export async function setSessionCacheWarming(
  environmentId: EnvironmentId,
  sessionId: string,
  change: { readonly enabled?: boolean; readonly hours?: number; readonly stop?: true },
): Promise<RubatoCacheSnapshot> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Cache warming is not available on this connection.");
  const response = await fetch(`${access.baseUrl}${CACHE_WARMING_ROUTE}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, ...change }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { cache?: RubatoCacheSnapshot; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.cache) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  void refreshWarmingThreads(environmentId).catch(() => undefined);
  return payload.cache;
}

/** A thread still warming, as the sidebar draws it. Times are epoch ms. */
export interface WarmingThread {
  readonly sessionId: string;
  readonly hours: number;
  readonly from: number;
  readonly until: number;
}

type WarmingMap = Readonly<Record<string, WarmingThread>>;
const EMPTY: WarmingMap = {};
const POLL_MS = 60_000;

/**
 * One poll per environment for every sidebar row. It re-reads each minute (which also
 * moves the arcs along) and when the window regains focus; with no row watching it stops.
 */
const stores = new Map<
  EnvironmentId,
  { threads: WarmingMap; listeners: Set<() => void>; stop: (() => void) | null }
>();

function storeOf(environmentId: EnvironmentId) {
  let store = stores.get(environmentId);
  if (!store) {
    store = { threads: EMPTY, listeners: new Set(), stop: null };
    stores.set(environmentId, store);
  }
  return store;
}

export async function refreshWarmingThreads(environmentId: EnvironmentId): Promise<void> {
  const store = storeOf(environmentId);
  const prepared = readPreparedConnection(environmentId);
  const access = prepared ? await rubatoHttpAccess(prepared).catch(() => null) : null;
  let threads: WarmingMap = EMPTY;
  if (access) {
    const response = await fetch(`${access.baseUrl}${CACHE_WARMING_ROUTE}`, {
      credentials: access.credentials,
      headers: access.headers,
    }).catch(() => null);
    const payload = response?.ok
      ? ((await response.json().catch(() => null)) as { threads?: WarmingMap } | null)
      : null;
    threads = payload?.threads ?? EMPTY;
  }
  store.threads = threads;
  for (const listener of store.listeners) listener();
}

export function subscribeWarmingThreads(environmentId: EnvironmentId, listener: () => void): () => void {
  const store = storeOf(environmentId);
  store.listeners.add(listener);
  if (store.stop === null) {
    const refresh = () => void refreshWarmingThreads(environmentId).catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    if (typeof window !== "undefined") window.addEventListener("focus", refresh);
    store.stop = () => {
      clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("focus", refresh);
    };
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.stop?.();
      store.stop = null;
    }
  };
}

export function readWarmingThread(environmentId: EnvironmentId, threadId: string): WarmingThread | null {
  return stores.get(environmentId)?.threads[threadId] ?? null;
}
