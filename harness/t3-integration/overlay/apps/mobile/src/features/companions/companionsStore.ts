// Who the person's companions are, from each paired Mac: name, the T3 thread that is its room,
// its picture, and whether it can take a call. The Mac's /rubato/companion route answers
// (t3-integration overlay RubatoCompanion.ts; the files live in the Rubato checkout's
// harness/companion). A room's thread is the companion's current conversation; asking for it with
// `current` also takes it out of the archive on the Mac.
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";
import { RubatoCall } from "../../../modules/rubato-call";
import { callApi, type CallableCompanion } from "./callStore";
import { companionDisplayName, dataUrlBase64, subscribeCompanionNames, useCompanionNames } from "./companionNames";
import { postRubato } from "./rubatoHttp";

const COMPANION_ROUTE = "/rubato/companion";
/** How often the list refreshes while a companion's conversation has no thread yet, and otherwise. */
const QUICK_POLL_MS = 5_000;
const SLOW_POLL_MS = 30_000;

/** The companion conversation's effort while a call is open (harness/companion/companion.mjs CALL_EFFORTS). */
export type CallEffort = "conversation" | "low" | "medium" | "high";
export const CALL_EFFORTS: readonly CallEffort[] = ["conversation", "low", "medium", "high"];

interface CompanionStatus {
  readonly id: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly settings?: { readonly enabled?: boolean; readonly call?: { readonly effort?: CallEffort } };
  /** Whether it takes voice calls at all; its call settings only mean something then. */
  readonly calls?: boolean;
}

export interface CompanionEntry {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  /** The name this phone shows (companionNames.ts: a rename, or 루/세뇨). */
  readonly title: string;
  /** The name the Mac knows it by. */
  readonly macTitle: string;
  readonly sessionId: string | null;
  /** The T3 thread that is its room; null until the Mac's app picked its conversation up. */
  readonly threadId: string | null;
  /** Its picture as a data URL, or null. */
  readonly art: string | null;
  readonly callable: CallableCompanion | null;
  /** Whether it takes voice calls, and how much it thinks on one. */
  readonly calls: boolean;
  readonly callEffort: CallEffort;
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
        // The face the Mac keeps for phones; a Mac without it answers its stage art instead.
        const art = await companionCall<{ avatar: { url: string } | null }>(environmentId, "avatar", { companionId: item.id }).then(
          (answer) => answer.avatar?.url ?? null,
          () =>
            companionCall<{ art: { url: string } | null }>(environmentId, "art", { companionId: item.id, state: "idle" }).then(
              (answer) => answer.art?.url ?? null,
              () => undefined,
            ),
        );
        if (art !== undefined) arts.set(key, art);
      }
      return {
        environmentId,
        id: item.id,
        title: item.title || item.id,
        macTitle: item.title || item.id,
        sessionId: item.sessionId,
        threadId,
        art: arts.get(key) ?? null,
        callable: callable.find((entry) => entry.id === item.id) ?? null,
        calls: item.calls === true,
        callEffort: item.settings?.call?.effort ?? "medium",
      };
    }),
  );
}

/** Saves how much a companion thinks on calls; the Mac's companion settings keep it. */
export async function saveCallEffort(companion: CompanionEntry, effort: CallEffort): Promise<void> {
  const same = (item: CompanionEntry) => item.environmentId === companion.environmentId && item.id === companion.id;
  const put = (value: CallEffort) =>
    publish({ companions: view.companions.map((item) => (same(item) ? { ...item, callEffort: value } : item)) });
  put(effort);
  try {
    const status = await companionCall<CompanionStatus>(companion.environmentId, "save-settings", {
      companionId: companion.id,
      patch: { call: { effort } },
    });
    put(status.settings?.call?.effort ?? effort);
  } catch (error) {
    put(companion.callEffort);
    throw error;
  }
}

/** What the native store last got per companion, so a face is written only when it changes. */
const written = new Map<string, string>();

/** Hands each companion's shown name and face to the call screen and notifications (CompanionIdentity). */
function writeIdentities(companions: readonly CompanionEntry[]) {
  if (!RubatoCall) return;
  for (const companion of companions) {
    const name = companionDisplayName(companion.id, companion.macTitle);
    const key = `${name}\u0000${companion.art?.length ?? 0}:${companion.art?.slice(-32) ?? ""}`;
    if (written.get(companion.id) === key) continue;
    written.set(companion.id, key);
    void RubatoCall.setCompanionIdentity(companion.id, name, dataUrlBase64(companion.art)).catch(() => written.delete(companion.id));
  }
}
subscribeCompanionNames(() => writeIdentities(view.companions));

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
    writeIdentities(fresh);
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
  const stored = useSyncExternalStore(subscribe, () => view);
  const names = useCompanionNames();
  const current = useMemo(
    () => ({ ...stored, companions: stored.companions.map((item) => ({ ...item, title: companionDisplayName(item.id, item.macTitle) })) }),
    // `names` changes when a rename does; the display name reads it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    [stored, names],
  );
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
