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
  /** The night (00:07) and morning (09:07) greetings; the morning one carries the daily report. */
  readonly greetings: { readonly enabled: boolean };
  /** The deadline schedule the heartbeat reads for its nudges; "" for none. */
  readonly career: { readonly schedule: string };
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

/** Where a held message is addressed: a chat other than the person's own. */
export interface TelegramChat {
  readonly chatId: string;
  readonly name?: string;
}

export interface TelegramHeldMessage {
  readonly id: string;
  readonly text: string;
  /** Null when the message is for the person's own chat; a message to anyone else is held. */
  readonly target: TelegramChat | null;
  readonly createdAt: string;
  readonly source?: string;
  readonly state?: string;
}

export interface TelegramStatus {
  readonly settings: { readonly enabled: boolean; readonly approvalRequired: boolean };
  /** The bot as Settings shows it: its id and last four characters, never the token. */
  readonly bot: { readonly masked: string | null; readonly username?: string; readonly name?: string };
  readonly pairing: {
    readonly status: "unpaired" | "pending" | "paired";
    readonly code?: string;
    readonly chat?: TelegramChat & { readonly username?: string };
  };
  /** What the engine's messenger did with the last request, and why not if it failed. */
  readonly handoff: { readonly result?: string; readonly error?: string };
  /** Whether this Mac has the person's own MTProto client, which is what can make a bot for them. */
  readonly botCreation?: { readonly available: boolean; readonly reason?: string; readonly account?: string };
  readonly home: string;
  readonly waiting: readonly TelegramHeldMessage[];
  readonly recent: readonly TelegramHeldMessage[];
}

export type CompanionPieceId =
  | "preamble"
  | "soul"
  | "identity"
  | "user"
  | "companion"
  | "tools"
  | "memory"
  | "coda";

export interface CompanionPiece {
  readonly id: CompanionPieceId;
  /** False for the tools piece: it describes the real tools and follows the product. */
  readonly editable: boolean;
  readonly defaultText: string;
  /** The person's own version; absent while the piece follows the default. */
  readonly personalText?: string;
  /** The product default that version was seeded from; absent when the base is unknown. */
  readonly baseText?: string;
  /** True for a copy that predates seeding: Rubato has no record of the default it came from. */
  readonly baseUnknown?: boolean;
  /** Rubato's default moved since this copy was made. */
  readonly defaultChanged?: boolean;
}

export interface CompanionSettingsPatch {
  readonly enabled?: boolean;
  readonly heartbeat?: Partial<CompanionSettings["heartbeat"]>;
  readonly greetings?: Partial<CompanionSettings["greetings"]>;
  readonly career?: Partial<CompanionSettings["career"]>;
}

/** A conversation Segno handed work to and follows until that work ends (engine panel.json). */
export interface SegnoLead {
  readonly sessionId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  /** `asked`: it stopped to ask the person; `queued`: handed over, not running yet. */
  readonly state: "running" | "asked" | "queued";
  /** When Segno handed the work over, epoch ms. */
  readonly since: number | null;
}

export interface SegnoFinished {
  readonly sessionId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly outcome: "completed" | "stopped" | "failed" | "lost";
  readonly at: number;
}

/** A message Segno wrote to someone other than the person, held until the person decides. */
export interface SegnoHeldMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly to: { readonly chatId: string; readonly name: string | null } | null;
}

/** An open item in Segno's inbox that no lead took yet (harness/companion inbox.mjs). */
export interface SegnoInboxItem {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly reporter: string | null;
  readonly status: "open" | "in-progress" | "waiting";
  readonly createdAt: string;
}

/** Segno's expression on its stage (harness/companion art/stage-<state>.webp). */
export type SegnoStageState = "idle" | "working" | "waiting" | "night";

/** What the task panel beside Segno's chat shows. */
export interface SegnoPanel {
  readonly leads: readonly SegnoLead[];
  readonly finished: readonly SegnoFinished[];
  readonly held: readonly SegnoHeldMessage[];
  /** Absent from a server without the inbox. */
  readonly inbox?: readonly SegnoInboxItem[];
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
  /** Asks Segno to review the defaults that moved; the engine's keeper wakes it. */
  reviewPersona: (env: EnvironmentId | null) =>
    call<{ pieces: CompanionPiece[]; reviewRequested: string | null }>(env, "review-persona"),
  telegram: (env: EnvironmentId | null) => call<{ telegram: TelegramStatus }>(env, "telegram"),
  saveTelegramSettings: (env: EnvironmentId | null, patch: { readonly enabled?: boolean }) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-settings", { patch }),
  /** Asks the engine's messenger for a fresh six-character code; the person sends it to the bot. */
  pairTelegram: (env: EnvironmentId | null) => call<{ telegram: TelegramStatus }>(env, "telegram-pair"),
  unpairTelegram: (env: EnvironmentId | null) => call<{ telegram: TelegramStatus }>(env, "telegram-unpair"),
  /** Hands a token from @BotFather to the messenger, which checks it with Telegram before keeping it. */
  setTelegramToken: (env: EnvironmentId | null, token: string) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-set-token", { token }),
  /** Has Segno's bot made from the person's own Telegram account (@BotFather over MTProto). */
  createTelegramBot: (env: EnvironmentId | null, name: string, username?: string) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-create-bot", { name, ...(username ? { username } : {}) }),
  /**
   * Approves or refuses one message addressed to someone else; nothing is sent before this. An
   * approval may carry the text as the person edited it, which is what goes out.
   */
  decideTelegram: (env: EnvironmentId | null, id: string, decision: "approve" | "reject", text?: string) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-decide", { id, decision, ...(text === undefined ? {} : { text }) }),
  /** The task panel beside Segno's chat: leads it follows, recent endings, held messages. */
  panel: (env: EnvironmentId | null) => call<SegnoPanel>(env, "panel"),
  /** Segno's art for one expression of its space, as a data URL; `version` changes when the file is swapped. */
  art: (env: EnvironmentId | null, state: SegnoStageState = "idle") =>
    call<{ art: { url: string; version: number } }>(env, "art", { state }),
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

/** Whether `threadId` is Segno's conversation, as far as the app knows it now. */
export function isCompanionThread(threadId: string): boolean {
  return view.threadId !== null && view.threadId === threadId;
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

/** `projects` without Segno's own folder: no list offers it as a place to start work. */
export function useWithoutCompanionProjects<A extends ReadonlyArray<{ readonly workspaceRoot: string }>>(projects: A): A {
  const home = useRubatoCompanion().status?.home;
  return useMemo(
    () =>
      (home == null ? projects : projects.filter((project) => !isCompanionProject(project, home))) as unknown as A,
    [home, projects],
  );
}

/** Whether a project is Segno's own folder, which no project list shows. */
export function isCompanionProject(
  project: { readonly workspaceRoot: string },
  home: string | null | undefined,
): boolean {
  return home != null && findProjectByPath([project], home) !== undefined;
}
