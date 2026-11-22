// Who the person's companions are, from each paired Mac: name, the T3 thread that is its room,
// its picture, and whether it can take a call. The Mac's /rubato/companion route answers
// (t3-integration overlay RubatoCompanion.ts; the files live in the Rubato checkout's
// harness/companion). A room's thread is the companion's current conversation; asking for it with
// `current` also takes it out of the archive on the Mac. A new companion is made here too (`create`),
// and its picture set (`set-avatar`): the Mac keeps both for every device (intent companion-manage).
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { useEnvironments } from "../../state/environments";
import { RubatoCall } from "../../../modules/rubato-call";
import Storage from "expo-sqlite/kv-store";

import { callApi, type CallableCompanion } from "./callStore";
import {
  COMPANIONS_CACHE_KEY,
  decodeCompanions,
  encodeCompanions,
  knownThreadId,
  type CallEffort,
  type CompanionEntry,
} from "./companionModel";
import { decodeOnboarding } from "./onboardingModel";
import { companionDisplayName, dataUrlBase64, subscribeCompanionNames, useCompanionNames } from "./companionNames";
import { copy } from "./copy";
import { postRubato } from "./rubatoHttp";

const COMPANION_ROUTE = "/rubato/companion";
/** How often the list refreshes while a companion's conversation has no thread yet, and otherwise. */
const QUICK_POLL_MS = 5_000;
const SLOW_POLL_MS = 120_000;
/** Minimum gap between automatic foreground refreshes when nothing is waiting. */
const MIN_RESUME_REFRESH_MS = 15_000;
/** How long a list request waits for a Mac's connection still being made, before it counts as no answer. */
const CONNECTION_WAIT_MS = 20_000;

interface CompanionStatus {
  readonly id: string;
  /** Null while a new companion has no name yet. */
  readonly title: string | null;
  readonly sessionId: string | null;
  readonly profile?: { readonly callsUser?: string | null; readonly since?: string | null } | null;
  /** The picture's version (file time); a change means fetch `avatar` again. */
  readonly avatarVersion?: number | null;
  readonly onboarding?: unknown;
  readonly settings?: { readonly enabled?: boolean; readonly call?: { readonly effort?: CallEffort } };
  /** Whether it takes voice calls at all; its call settings only mean something then. */
  readonly calls?: boolean;
}

export { CALL_EFFORTS, type CallEffort, type CompanionEntry } from "./companionModel";

interface CompanionsView {
  readonly companions: readonly CompanionEntry[];
  /** Some paired Mac answered, now or on an earlier launch (the kept list); false while none has. */
  readonly loaded: boolean;
  readonly error: string | null;
}

/** The list this phone kept from its last answer: the tab and the rooms open on it at once. */
function readKept(): CompanionEntry[] {
  try {
    return decodeCompanions(Storage.getItemSync(COMPANIONS_CACHE_KEY));
  } catch {
    return [];
  }
}
const keptCompanions = readKept();
let keptText = encodeCompanions(keptCompanions);
function keep(companions: readonly CompanionEntry[]) {
  const next = encodeCompanions(companions);
  if (next === keptText) return;
  keptText = next;
  void Storage.setItemAsync(COMPANIONS_CACHE_KEY, next).catch(() => {
    keptText = "";
  });
}

let view: CompanionsView = { companions: keptCompanions, loaded: keptCompanions.length > 0, error: null };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function publish(next: Partial<CompanionsView>) {
  view = { ...view, ...next };
  if (next.companions) keep(next.companions);
  for (const listener of listeners) listener();
}

/**
 * Pictures by `<environment>:<companion>`, fetched once per launch and again when the Mac's version
 * of it moves (a change on the desktop or another phone); the kept list shows them until then.
 */
const arts = new Map<string, string | null>();
const artVersions = new Map<string, number | null>();
const keptArt = (environmentId: EnvironmentId, companionId: string) =>
  view.companions.find((item) => item.environmentId === environmentId && item.id === companionId)?.art ?? null;

const companionCall = <T>(environmentId: EnvironmentId, action: string, body: Record<string, unknown> = {}) =>
  postRubato<T>(environmentId, COMPANION_ROUTE, action, body, { waitForConnectionMs: CONNECTION_WAIT_MS });

/** The companion's face: the one the Mac keeps for phones, or its stage art from a Mac without one. */
const fetchArt = (environmentId: EnvironmentId, companionId: string) =>
  companionCall<{ avatar: { url: string } | null }>(environmentId, "avatar", { companionId }).then(
    (answer) => answer.avatar?.url ?? null,
    () =>
      companionCall<{ art: { url: string } | null }>(environmentId, "art", { companionId, state: "idle" }).then(
        (answer) => answer.art?.url ?? null,
        () => undefined,
      ),
  );

// The list and whether calls can go through are asked together, then each companion's room and face
// together: two round trips to the Mac, where one after another took four.
async function loadEnvironment(environmentId: EnvironmentId): Promise<CompanionEntry[]> {
  const [{ companions }, callable] = await Promise.all([
    companionCall<{ companions: CompanionStatus[] }>(environmentId, "companions"),
    callApi.companions(environmentId, { waitForConnectionMs: CONNECTION_WAIT_MS }).catch(() => [] as CallableCompanion[]),
  ]);
  const enabled = companions.filter((item) => item.settings?.enabled !== false);
  return Promise.all(
    enabled.map(async (item) => {
      const key = `${environmentId}:${item.id}`;
      // A Mac without picture versions answers undefined: then the picture is fetched once per launch.
      const version = typeof item.avatarVersion === "number" ? item.avatarVersion : null;
      const [threadId, art] = await Promise.all([
        item.sessionId
          ? companionCall<{ threadId: string | null }>(environmentId, "thread", {
              companionId: item.id,
              sessionId: item.sessionId,
              current: true,
            }).then(
              (answer) => answer.threadId,
              () => knownThreadId(view.companions, environmentId, item.id, item.sessionId),
            )
          : null,
        arts.has(key) && artVersions.get(key) === version ? arts.get(key) : fetchArt(environmentId, item.id),
      ]);
      if (art !== undefined) {
        arts.set(key, art);
        artVersions.set(key, version);
      }
      const macTitle = item.title?.trim() ? item.title : null;
      return {
        environmentId,
        id: item.id,
        title: entryTitle(item.id, macTitle),
        macTitle,
        sessionId: item.sessionId,
        threadId,
        art: arts.has(key) ? (arts.get(key) ?? null) : keptArt(environmentId, item.id),
        avatarVersion: version,
        callsUser: item.profile?.callsUser?.trim() || null,
        since: item.profile?.since || null,
        onboarding: decodeOnboarding(item.onboarding ?? null),
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

/** The name a companion shows: the person's rename or default, or "새 컴패니언" while it has none. */
export function entryTitle(companionId: string, macTitle: string | null): string {
  return macTitle === null ? companionDisplayName(companionId, copy.newCompanion) : companionDisplayName(companionId, macTitle);
}

const sameEntry = (a: Pick<CompanionEntry, "environmentId" | "id">) => (b: CompanionEntry) =>
  a.environmentId === b.environmentId && a.id === b.id;

/**
 * Makes a new companion on that Mac: the Mac registers its home and wakes it without a name, and its
 * first conversation (the room, once the Mac opened it) is where it learns who it is.
 */
export async function createCompanion(environmentId: EnvironmentId): Promise<{ readonly id: string }> {
  const answer = await companionCall<{ companion?: { id?: unknown } }>(environmentId, "create");
  const id = answer.companion?.id;
  if (typeof id !== "string" || !id) throw new Error(copy.createFailed);
  // Shown at once as "새 컴패니언"; the list fills in its conversation as the Mac opens it.
  if (!view.companions.some(sameEntry({ environmentId, id })))
    publish({
      companions: [
        ...view.companions,
        {
          environmentId, id, title: copy.newCompanion, macTitle: null, sessionId: null, threadId: null, art: null,
          avatarVersion: null, callsUser: null, since: null, onboarding: decodeOnboarding({ items: [] }),
          callable: null, calls: false, callEffort: "medium",
        },
      ],
    });
  void refreshCompanions(pairedIds.length > 0 ? pairedIds : [environmentId]);
  return { id };
}

/**
 * Sets the companion's picture (a square data URL the phone cropped), or clears it with null. The
 * Mac keeps it for the desktop and every phone; this phone shows it at once.
 */
export async function setCompanionAvatar(companion: Pick<CompanionEntry, "environmentId" | "id">, image: string | null): Promise<void> {
  const answer = await companionCall<{ avatar: { url: string; version?: number } | null }>(companion.environmentId, "set-avatar", {
    companionId: companion.id,
    image,
  });
  const key = `${companion.environmentId}:${companion.id}`;
  const url = answer.avatar?.url ?? null;
  const version = typeof answer.avatar?.version === "number" ? answer.avatar.version : null;
  arts.set(key, url);
  artVersions.set(key, version);
  const companions = view.companions.map((item) => (sameEntry(companion)(item) ? { ...item, art: url, avatarVersion: version } : item));
  writeIdentities(companions);
  publish({ companions });
}

/** Fetches the picture again on the next refresh (an applied drawing changed it on the Mac). */
export function forgetCompanionArt(companion: Pick<CompanionEntry, "environmentId" | "id">) {
  const key = `${companion.environmentId}:${companion.id}`;
  arts.delete(key);
  artVersions.delete(key);
  void refreshCompanions(pairedIds.length > 0 ? pairedIds : [companion.environmentId]);
}

/** The paired Macs the list last asked, for a refresh started outside a screen. */
let pairedIds: readonly EnvironmentId[] = [];

/** What the native store last got per companion, so a face is written only when it changes. */
const written = new Map<string, string>();

/** Hands each companion's shown name and face to the call screen and notifications (CompanionIdentity). */
function writeIdentities(companions: readonly CompanionEntry[]) {
  if (!RubatoCall) return;
  for (const companion of companions) {
    const name = entryTitle(companion.id, companion.macTitle);
    const key = `${name}\u0000${companion.art?.length ?? 0}:${companion.art?.slice(-32) ?? ""}`;
    if (written.get(companion.id) === key) continue;
    written.set(companion.id, key);
    void RubatoCall.setCompanionIdentity(companion.id, name, dataUrlBase64(companion.art)).catch(() => written.delete(companion.id));
  }
}
subscribeCompanionNames(() => writeIdentities(view.companions));

let loading: Promise<void> | null = null;
let lastRefreshedAt = 0;

function sameCompanionsSnapshot(a: readonly CompanionEntry[], b: readonly CompanionEntry[]): boolean {
  if (a.length !== b.length) return false;
  return encodeCompanions(a) === encodeCompanions(b) && a.every((item, index) => {
    const other = b[index]!;
    return (
      item.callable?.ready === other.callable?.ready &&
      item.callable?.reason === other.callable?.reason &&
      item.calls === other.calls &&
      item.callEffort === other.callEffort &&
      JSON.stringify(item.onboarding) === JSON.stringify(other.onboarding)
    );
  });
}

/** Asks every paired Mac again; a Mac that does not answer keeps what it said last. */
export function refreshCompanions(environmentIds: readonly EnvironmentId[]): Promise<void> {
  pairedIds = environmentIds;
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
    const nextCompanions = [...fresh, ...kept];
    const nextLoaded = view.loaded || answered.size > 0;
    const nextError =
      answered.size === 0 && failure ? (failure.reason instanceof Error ? failure.reason.message : String(failure.reason)) : null;
    lastRefreshedAt = Date.now();
    writeIdentities(fresh);
    if (
      nextLoaded === view.loaded &&
      nextError === view.error &&
      sameCompanionsSnapshot(view.companions, nextCompanions)
    ) {
      return;
    }
    publish({ companions: nextCompanions, loaded: nextLoaded, error: nextError });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

// Single shared poller across all `useCompanions()` mounts: avoids duplicate intervals when multiple
// screens (e.g. HomeRouteScreen + Companions tab + Room) stay mounted simultaneously, and pauses in background.
const activeWatchers = new Map<symbol, { environmentIds: readonly EnvironmentId[]; key: string; waiting: boolean }>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollIntervalMs: number | null = null;
let pollKey = "";
let appStateSub: { remove(): void } | null = null;

function desiredPollConfig() {
  let latestIds: readonly EnvironmentId[] = [];
  let key = "";
  let waiting = false;
  for (const entry of activeWatchers.values()) {
    if (entry.environmentIds.length > 0) {
      latestIds = entry.environmentIds;
      key = entry.key;
    }
    if (entry.waiting) waiting = true;
  }
  return { environmentIds: latestIds, key, waiting };
}

function stopSharedPoller() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  pollIntervalMs = null;
}

function syncSharedPoller(triggerImmediate = false) {
  const { environmentIds, key, waiting } = desiredPollConfig();
  if (activeWatchers.size === 0 || environmentIds.length === 0) {
    stopSharedPoller();
    pollKey = "";
    appStateSub?.remove();
    appStateSub = null;
    return;
  }
  appStateSub ??= AppState.addEventListener("change", (state) => {
    if (state === "active") syncSharedPoller(true);
    else stopSharedPoller();
  });
  if (AppState.currentState !== "active") {
    stopSharedPoller();
    return;
  }
  const intervalMs = waiting || !view.loaded ? QUICK_POLL_MS : SLOW_POLL_MS;
  const keyChanged = key !== pollKey;
  pollKey = key;
  if (
    keyChanged ||
    (triggerImmediate && (waiting || !view.loaded || Date.now() - lastRefreshedAt >= MIN_RESUME_REFRESH_MS))
  ) {
    void refreshCompanions(environmentIds);
  }
  if (pollTimer === null || pollIntervalMs !== intervalMs) {
    stopSharedPoller();
    pollIntervalMs = intervalMs;
    pollTimer = setInterval(() => {
      const current = desiredPollConfig();
      if (current.environmentIds.length > 0 && AppState.currentState === "active") {
        void refreshCompanions(current.environmentIds);
      }
    }, intervalMs);
  }
}

/** The companions of every paired Mac, kept fresh while something shows them. */
export function useCompanions() {
  const { environments } = useEnvironments();
  const environmentIds = useMemo(() => environments.map((item) => item.environmentId), [environments]);
  const stored = useSyncExternalStore(subscribe, () => view);
  const names = useCompanionNames();
  const current = useMemo(
    () => ({ ...stored, companions: stored.companions.map((item) => ({ ...item, title: entryTitle(item.id, item.macTitle) })) }),
    // `names` changes when a rename does; the display name reads it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    [stored, names],
  );
  // A room still opening, and a first conversation whose chips move with each answer, ask more often.
  const waiting = current.companions.some(
    (item) => item.onboarding !== null || (item.sessionId !== null && item.threadId === null),
  );
  const key = environmentIds.join(",");
  useEffect(() => {
    if (environmentIds.length === 0) return;
    const token = Symbol("companions-watcher");
    activeWatchers.set(token, { environmentIds, key, waiting });
    syncSharedPoller(true);
    return () => {
      activeWatchers.delete(token);
      syncSharedPoller(false);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` stands for the id list.
  }, [key, waiting]);
  const refresh = () => refreshCompanions(environmentIds);
  return { ...current, paired: environmentIds.length > 0, refresh };
}

export function useCompanion(companionId: string, environmentId?: string | null) {
  const all = useCompanions();
  const companion =
    all.companions.find((item) => item.id === companionId && (!environmentId || item.environmentId === environmentId)) ?? null;
  return { ...all, companion };
}
