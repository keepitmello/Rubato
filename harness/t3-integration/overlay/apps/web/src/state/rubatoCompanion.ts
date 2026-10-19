// The companion (Segno): Settings › Companion, the rail's Segno button and the sidebar,
// which leaves Segno's conversation out of the thread list. The files belong to the Rubato
// checkout's harness/companion; the T3 server answers for them at /rubato/companion
// (apps/server/src/RubatoCompanion.ts).
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { usePrimaryEnvironmentId } from "./environments";
import { postRubato } from "./rubatoHttp";
import { usePreparedConnection } from "./session";

const COMPANION_ROUTE = "/rubato/companion";

export interface CompanionSettings {
  readonly enabled: boolean;
  readonly heartbeat: { readonly enabled: boolean; readonly everyMinutes: number };
  /** The daily report's time, HH:MM on this Mac's clock. */
  readonly dailyReport: { readonly enabled: boolean; readonly time: string };
}

export interface CompanionStatus {
  readonly settings: CompanionSettings;
  /** The companion's conversation, once the engine created it. */
  readonly sessionId: string | null;
  /** The companion's own folder; its conversation runs there. */
  readonly home: string;
  /** The heartbeat intervals the engine accepts, in minutes. */
  readonly heartbeatMinutes: readonly number[];
}

export type CompanionPieceId = "preamble" | "soul" | "identity" | "user" | "companion" | "tools";

export interface CompanionPiece {
  readonly id: CompanionPieceId;
  /** False for the tools piece: it describes the real tools and follows the product. */
  readonly editable: boolean;
  readonly defaultText: string;
  /** The person's own version; absent while the piece follows the default. */
  readonly personalText?: string;
}

export interface CompanionSettingsPatch {
  readonly enabled?: boolean;
  readonly heartbeat?: Partial<CompanionSettings["heartbeat"]>;
  readonly dailyReport?: Partial<CompanionSettings["dailyReport"]>;
}

const call = <T>(env: EnvironmentId | null, action: string, body: Record<string, unknown> = {}) =>
  postRubato<T>(env, COMPANION_ROUTE, action, body, "companion settings");

export const rubatoCompanion = {
  status: (env: EnvironmentId | null) => call<CompanionStatus>(env, "status"),
  saveSettings: (env: EnvironmentId | null, patch: CompanionSettingsPatch) =>
    call<CompanionStatus>(env, "save-settings", { patch }),
  pieces: (env: EnvironmentId | null) => call<{ pieces: CompanionPiece[] }>(env, "pieces"),
  /** An empty text, or the default itself, returns the piece to the default. */
  savePiece: (env: EnvironmentId | null, id: CompanionPieceId, text: string) =>
    call<{ pieces: CompanionPiece[] }>(env, "save-piece", { id, text }),
  /** The T3 thread that shows the companion's conversation; null until the app has picked it up. */
  thread: (env: EnvironmentId | null, sessionId: string) =>
    call<{ threadId: string | null }>(env, "thread", { sessionId }),
};

/** The primary environment's id once its HTTP connection is ready; null until then. */
export function useReadyEnvironmentId(): EnvironmentId | null {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? environmentId : null;
}

export interface CompanionView {
  readonly status: CompanionStatus | null;
  /** Segno's T3 thread, once the app shows its conversation. */
  readonly threadId: string | null;
}

// One view shared by the rail, the sidebar and the settings page.
let view: CompanionView = { status: null, threadId: null };
const listeners = new Set<() => void>();
const publish = (next: CompanionView) => {
  if (next.status === view.status && next.threadId === view.threadId) return;
  view = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Takes a status the settings page just saved, so the rail follows at once. */
export function acceptCompanionStatus(status: CompanionStatus): void {
  publish({ status, threadId: status.sessionId === view.status?.sessionId ? view.threadId : null });
  void refresh(lastEnvironment);
}

let lastEnvironment: EnvironmentId | null = null;
let refreshing: Promise<void> | null = null;
function refresh(env: EnvironmentId | null): Promise<void> {
  if (env === null) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      const status = await rubatoCompanion.status(env);
      const sameSession = status.sessionId !== null && status.sessionId === view.status?.sessionId;
      let threadId = sameSession ? view.threadId : null;
      if (status.sessionId !== null && threadId === null)
        threadId = (
          await rubatoCompanion.thread(env, status.sessionId).catch(() => ({ threadId: null }))
        ).threadId;
      publish({ status, threadId });
    } catch {
      // No companion route on this server: nothing shows.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// The keeper creates the conversation within seconds of turning the companion on, and the app
// shows it within five more; until then poll quickly, after that rarely.
const QUICK_POLL_MS = 3_000;
const SLOW_POLL_MS = 60_000;

/** The companion as the app knows it, kept fresh while anything shows it. */
export function useRubatoCompanion(): CompanionView {
  const environmentId = useReadyEnvironmentId();
  const current = useSyncExternalStore(subscribe, () => view);
  const waiting = current.status?.settings.enabled === true && current.threadId === null;
  useEffect(() => {
    if (environmentId === null) return;
    lastEnvironment = environmentId;
    void refresh(environmentId);
    const timer = window.setInterval(
      () => void refresh(environmentId),
      waiting ? QUICK_POLL_MS : SLOW_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [environmentId, waiting]);
  return current;
}

/** The thread list without Segno's conversation: it opens from the rail (companion-edits.mjs). */
export function useWithoutCompanionThread<T extends { readonly id: string }>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const { threadId } = useRubatoCompanion();
  return useMemo(
    () =>
      threadId === null || !threads.some((thread) => thread.id === threadId)
        ? threads
        : threads.filter((thread) => thread.id !== threadId),
    [threadId, threads],
  );
}

/** Whether a project is Segno's own folder, which no project list shows. */
export function isCompanionProject(
  project: { readonly workspaceRoot: string },
  home: string | null | undefined,
): boolean {
  return home != null && findProjectByPath([project], home) !== undefined;
}
