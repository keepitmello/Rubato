// Who the person's companions are, from each paired Mac: name, the T3 thread that is its room,
// its picture, and whether it can take a call. The Mac's /rubato/companion route answers
// (t3-integration overlay RubatoCompanion.ts; the files live in the Rubato checkout's
// harness/companion). A room's thread is the companion's current conversation; asking for it with
// `current` also takes it out of the archive on the Mac.
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";
import { callApi, type CallableCompanion } from "./callStore";
import { postRubato } from "./rubatoHttp";

const COMPANION_ROUTE = "/rubato/companion";
/** How often the list refreshes while a companion's conversation has no thread yet, and otherwise. */
const QUICK_POLL_MS = 5_000;
const SLOW_POLL_MS = 30_000;

interface CompanionStatus {
  readonly id: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly settings?: { readonly enabled?: boolean };
}

export interface CompanionEntry {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly sessionId: string | null;
  /** The T3 thread that is its room; null until the Mac's app picked its conversation up. */
  readonly threadId: string | null;
  /** Its picture as a data URL, or null. */
  readonly art: string | null;
  readonly callable: CallableCompanion | null;
}

interface CompanionsView {
  readonly companions: readonly CompanionEntry[];
  /** Some paired Mac answered; false while none has yet. */
  readonly loaded: boolean;
  readonly error: string | null;
}

let view: CompanionsView = { companions: [], loaded: false, error: null };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function publish(next: Partial<CompanionsView>) {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}

/** Pictures by `<environment>:<companion>`, fetched once per launch. */
const arts = new Map<string, string | null>();

const companionCall = <T>(environmentId: EnvironmentId, action: string, body: Record<string, unknown> = {}) =>
  postRubato<T>(environmentId, COMPANION_ROUTE, action, body);

async function loadEnvironment(environmentId: EnvironmentId): Promise<CompanionEntry[]> {
  const { companions } = await companionCall<{ companions: CompanionStatus[] }>(environmentId, "companions");
  const callable = await callApi.companions(environmentId).catch(() => [] as CallableCompanion[]);
  const enabled = companions.filter((item) => item.settings?.enabled !== false);
  return Promise.all(
    enabled.map(async (item) => {
      const threadId = item.sessionId
        ? await companionCall<{ threadId: string | null }>(environmentId, "thread", {
            companionId: item.id,
            sessionId: item.sessionId,
            current: true,
          }).then((answer) => answer.threadId, () => null)
        : null;
      const key = `${environmentId}:${item.id}`;
      if (!arts.has(key)) {
        const art = await companionCall<{ art: { url: string } | null }>(environmentId, "art", {
          companionId: item.id,
          state: "idle",
        }).then((answer) => answer.art?.url ?? null, () => undefined);
        if (art !== undefined) arts.set(key, art);
      }
      return {
        environmentId,
        id: item.id,
        title: item.title || item.id,
        sessionId: item.sessionId,
        threadId,
        art: arts.get(key) ?? null,
        callable: callable.find((entry) => entry.id === item.id) ?? null,
      };
    }),
  );
}

let loading: Promise<void> | null = null;

/** Asks every paired Mac again; a Mac that does not answer keeps what it said last. */
export function refreshCompanions(environmentIds: readonly EnvironmentId[]): Promise<void> {
  loading ??= (async () => {
    const results = await Promise.allSettled(environmentIds.map(loadEnvironment));
    const answered = new Set<EnvironmentId>();
    const fresh: CompanionEntry[] = [];
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      answered.add(environmentIds[index]!);
      fresh.push(...result.value);
    });
    const kept = view.companions.filter((item) => !answered.has(item.environmentId) && environmentIds.includes(item.environmentId));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    publish({
      companions: [...fresh, ...kept],
      loaded: view.loaded || answered.size > 0,
      error: answered.size === 0 && failure ? (failure.reason instanceof Error ? failure.reason.message : String(failure.reason)) : null,
    });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** The companions of every paired Mac, kept fresh while something shows them. */
export function useCompanions() {
  const { environments } = useEnvironments();
  const environmentIds = useMemo(() => environments.map((item) => item.environmentId), [environments]);
  const current = useSyncExternalStore(subscribe, () => view);
  const waiting = current.companions.some((item) => item.sessionId !== null && item.threadId === null);
  const key = environmentIds.join(",");
  useEffect(() => {
    if (environmentIds.length === 0) return;
    void refreshCompanions(environmentIds);
    const timer = setInterval(() => void refreshCompanions(environmentIds), waiting || !view.loaded ? QUICK_POLL_MS : SLOW_POLL_MS);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` stands for the id list.
  }, [key, waiting]);
  const refresh = useCallback(() => refreshCompanions(environmentIds), [key]);
  return { ...current, paired: environmentIds.length > 0, refresh };
}

export function useCompanion(companionId: string, environmentId?: string | null) {
  const all = useCompanions();
  const companion =
    all.companions.find((item) => item.id === companionId && (!environmentId || item.environmentId === environmentId)) ?? null;
  return { ...all, companion };
}
