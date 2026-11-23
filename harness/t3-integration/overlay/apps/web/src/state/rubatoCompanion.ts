// The companion (Segno): Settings › Companion, the rail's Segno button and the sidebar,
// which leaves Segno's conversation out of the thread list. The files belong to the Rubato
// checkout's harness/companion; the T3 server answers for them at /rubato/companion
// (apps/server/src/RubatoCompanion.ts).
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { companionCreateBody, type CompanionModelSelection } from "@t3tools/shared/rubatoCompanionModelChoice";
import * as Option from "effect/Option";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { subscribeUiLanguage, uiLanguage, uiText } from "../rubatoI18n";

import { usePrimaryEnvironmentId } from "./environments";
import { postRubato } from "./rubatoHttp";
import { usePreparedConnection } from "./session";

const COMPANION_ROUTE = "/rubato/companion";
let selectedCompanionId = "segno";

export interface CompanionSettings {
  readonly enabled: boolean;
  readonly heartbeat: { readonly enabled: boolean; readonly everyMinutes: number };
  /** The night (00:07) and morning (09:07) greetings; the morning one carries the daily report. */
  readonly greetings: { readonly enabled: boolean };
  /** The calendars and schedule files the heartbeat reads for its nudges; Segno sets them when told. */
  readonly schedule: {
    readonly sources: readonly { readonly kind: "ics" | "markdown"; readonly location: string; readonly name?: string }[];
  };
  /** The companion conversation's effort while a voice call is open; `conversation` keeps its own level. */
  readonly call: { readonly effort: CallEffort };
  /** The dream's document upkeep: how often, and which places it tends (set by talking to the companion). */
  readonly dream?: { readonly docs: { readonly cadence: DocsCadence; readonly roots: readonly DocsRoot[] } };
}

/** harness/companion/companion.mjs CALL_EFFORTS. */
export type CallEffort = "conversation" | "low" | "medium" | "high";

/** harness/companion/companion.mjs DOCS_CADENCES. */
export type DocsCadence = "off" | "daily" | "weekly" | "monthly";

/** harness/companion/companion.mjs DOCS_ROOT_MODES: edited in place, changed on a review branch, or only read. */
export interface DocsRoot {
  readonly path: string;
  readonly mode: "edit" | "branch" | "report";
}

export interface CompanionStatus {
  readonly id?: string;
  /** Null while the companion has no name yet (its onboarding has not got there). */
  readonly title?: string | null;
  readonly settings: CompanionSettings;
  /** The companion's conversation, once the engine created it. */
  readonly sessionId: string | null;
  /** The companion's own folder; its conversation runs there. */
  readonly home: string;
  /** The heartbeat intervals the engine accepts, in minutes. */
  readonly heartbeatMinutes: readonly number[];
  /** Whether this companion takes voice calls. */
  readonly calls?: boolean;
  /** The call efforts the engine accepts. */
  readonly callEfforts?: readonly CallEffort[];
  /** What it calls the person and since when it is with them (ISO date). */
  readonly profile?: { readonly callsUser: string | null; readonly since: string | null };
  /** Moves when its picture changes; null when it has none. */
  readonly avatarVersion?: number | null;
  readonly iconVersion?: number | null;
  /** True only when a picture was set in the app (not the companion's own art). */
  readonly pictureSet?: boolean;
  /** Its first conversation, while it lasts: which topics are settled, open or left for later. */
  readonly onboarding?: CompanionOnboarding | null;
  /** Whether its profile has Telegram; the connection row shows only then. */
  readonly telegram?: boolean;
  /** Made from the app's list rather than by hand. */
  readonly madeInApp?: boolean;
}

export interface CompanionOnboarding {
  readonly items: ReadonlyArray<{ readonly key: string; readonly state: "set" | "open" | "deferred"; readonly value?: string }>;
}

/** A change the companion proposes to its own text or picture; nothing is saved before Apply. */
export interface CompanionProposal {
  readonly id: string;
  readonly kind: "piece" | "avatar" | "icon";
  /** Epoch ms. */
  readonly createdAt: number;
  readonly status: "open" | "applied" | "declined" | "superseded" | "stale";
  /** The companion's own words for what it changes, in the person's language. */
  readonly label: string;
  readonly piece?: CompanionPieceId;
  /** The changed excerpt before and after, not the whole piece. */
  readonly before?: string;
  readonly after?: string;
  readonly image?: { readonly url: string };
}

/** The two readable cards of Settings › Companion; null until the companion has written that card. */
export interface CompanionSummaries {
  readonly who: { readonly rows: ReadonlyArray<{ readonly key: string; readonly text: string }> } | null;
  readonly me: { readonly rows: ReadonlyArray<{ readonly key: string; readonly text: string }> } | null;
  readonly updatedAt: string | null;
}

export interface CompanionAvatar {
  readonly url: string;
  readonly version: number;
}

export interface CompanionChoice extends CompanionStatus {
  readonly id: string;
  /** Its name, or "New companion" while it has none (`nameless`). */
  readonly title: string;
  readonly nameless?: boolean;
  readonly threadId: string | null;
  /** Every conversation with this companion's mark, the current one too; null when the engine did not answer. */
  readonly conversations?: readonly string[] | null;
  /** The T3 threads of those conversations that the app shows. */
  readonly conversationThreadIds?: readonly string[];
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
  readonly settings: {
    readonly enabled: boolean;
    readonly approvalRequired: boolean;
    /** Segno's voice for voice replies (Fish Audio); null until the person picks one, usually by asking Segno. */
    readonly voice?: { readonly voiceId: string | null; readonly model: string };
  };
  /** The Fish Audio key voice replies use; null when there is none. */
  readonly fishKey?: string | null;
  /** Segno's bot: its token, name and username. */
  readonly bot: { readonly token: string | null; readonly username?: string; readonly name?: string };
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
  /** What the piece is called and what it is for (harness/companion/piece-copy.mjs, which Segno reads too). */
  readonly title: string;
  readonly description: string;
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
  readonly schedule?: Partial<CompanionSettings["schedule"]>;
  readonly call?: Partial<CompanionSettings["call"]>;
  readonly dream?: { readonly docs?: { readonly cadence?: DocsCadence; readonly roots?: readonly DocsRoot[] } };
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

/** Segno's expression on its stage (harness/companion art/stage-<state>.webp). */
export type SegnoStageState = "idle" | "working" | "waiting" | "night";

/** What the task panel beside Segno's chat shows: finished work stays until the person closes it. */
export interface SegnoPanel {
  readonly leads: readonly SegnoLead[];
  readonly finished: readonly SegnoFinished[];
  readonly held: readonly SegnoHeldMessage[];
}

/** What a companion did in one span between its room's bubbles (bridge companion/inner.mjs). */
export interface SegnoSpanSummary {
  readonly thinking: number;
  readonly text: number;
  readonly tools: number;
  readonly wakes: number;
  /** What woke the companion, by kind (control-tower.mjs notify `what`), in the order they first came. */
  readonly wakeKinds?: Readonly<Record<string, number>>;
  readonly messages: number;
  /** When the span's first and last piece happened, in ms; null for an empty span. */
  readonly from: number | null;
  readonly to: number | null;
  /** Conversations the companion started or forked in the span (bridge companion/inner.mjs); a card each. */
  readonly launches?: ReadonlyArray<SegnoLaunch>;
  /** Records it committed to its home in the span; one grey line each. */
  readonly commits?: ReadonlyArray<SegnoCommit>;
}

/** A session_create or session_fork call; `sessionId` is null until (or unless) it succeeded. */
export interface SegnoLaunch {
  readonly id: string;
  readonly tool: "create" | "fork";
  readonly sessionId: string | null;
  readonly title: string | null;
  readonly model: string | null;
  /** A fork without a first message waits for the person; anything else starts working. */
  readonly startsWork: boolean;
  readonly at: number;
  readonly done: number | null;
  readonly error: string | null;
}

/** A companion_commit that changed something: the companion's own words for it and the files. */
export interface SegnoCommit {
  readonly id: string;
  readonly message: string;
  readonly files: readonly string[];
  readonly sha: string;
  readonly at: number;
}

/** One piece of a span, oldest first: its thinking, words to itself, a tool call, what woke it. */
export type SegnoInnerItem =
  | { readonly kind: "thinking" | "text" | "error"; readonly text: string; readonly at: number }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly summary: string;
      readonly input: string;
      readonly output?: string;
      readonly isError?: boolean;
      readonly at: number;
      /** When its result came back; absent while it runs. */
      readonly done?: number;
    }
  | { readonly kind: "wake"; readonly what: string; readonly text: string; readonly at: number }
  | { readonly kind: "message"; readonly from: string; readonly text: string; readonly at: number }
  | { readonly kind: "compaction"; readonly at: number };

const call = <T>(env: EnvironmentId | null, action: string, body: Record<string, unknown> = {}, signal?: AbortSignal) =>
  postRubato<T>(env, COMPANION_ROUTE, action,
    action === "companions" || action === "create" ? body : { companionId: selectedCompanionId, ...body }, "companion settings", signal);

/** What the list and the pages call a companion that has no name yet. */
export const NAMELESS_TITLE = "New companion";

export const rubatoCompanion = {
  companions: (env: EnvironmentId | null) => call<{ companions: Array<Omit<CompanionChoice, "threadId" | "conversationThreadIds">> }>(env, "companions"),
  status: (env: EnvironmentId | null) => call<CompanionStatus>(env, "status"),
  saveSettings: (env: EnvironmentId | null, patch: CompanionSettingsPatch) =>
    call<CompanionStatus>(env, "save-settings", { patch }),
  pieces: (env: EnvironmentId | null) => call<{ pieces: CompanionPiece[] }>(env, "pieces"),
  /** An empty text, or the default itself, returns the piece to the default. */
  savePiece: (env: EnvironmentId | null, id: CompanionPieceId, text: string) =>
    call<{ pieces: CompanionPiece[] }>(env, "save-piece", { id, text }),
  /** Asks Segno to review the defaults that moved; the engine's control tower wakes it. */
  reviewPersona: (env: EnvironmentId | null) =>
    call<{ pieces: CompanionPiece[]; reviewRequested: string | null }>(env, "review-persona"),
  /** null while the product runs no Telegram (harness/companion/messenger/store.mjs TELEGRAM_ENABLED). */
  telegram: (env: EnvironmentId | null) => call<{ telegram: TelegramStatus | null }>(env, "telegram"),
  saveTelegramSettings: (env: EnvironmentId | null, patch: { readonly enabled?: boolean; readonly approvalRequired?: boolean }) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-settings", { patch }),
  /** Asks the engine's messenger for a fresh six-character code; the person sends it to the bot. */
  pairTelegram: (env: EnvironmentId | null) => call<{ telegram: TelegramStatus }>(env, "telegram-pair"),
  unpairTelegram: (env: EnvironmentId | null) => call<{ telegram: TelegramStatus }>(env, "telegram-unpair"),
  /** Hands a token from @BotFather to the messenger, which checks it with Telegram before keeping it. */
  setTelegramToken: (env: EnvironmentId | null, token: string) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-set-token", { token }),
  /** Keeps the Fish Audio key for Segno's voice replies; null removes it. Segno can set it too. */
  setVoiceKey: (env: EnvironmentId | null, key: string | null) =>
    call<{ telegram: TelegramStatus }>(env, "voice-key", { key }),
  /** Has Segno's bot made from the person's own Telegram account (@BotFather over MTProto). */
  createTelegramBot: (env: EnvironmentId | null, name: string, username?: string) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-create-bot", { name, ...(username ? { username } : {}) }),
  /**
   * Approves or refuses one message addressed to someone else; nothing is sent before this. An
   * approval may carry the text as the person edited it, which is what goes out.
   */
  decideTelegram: (env: EnvironmentId | null, id: string, decision: "approve" | "reject", text?: string, companionId = selectedCompanionId) =>
    call<{ telegram: TelegramStatus }>(env, "telegram-decide", { companionId, id, decision, ...(text === undefined ? {} : { text }) }),
  /** The task panel beside Segno's chat: leads it follows, endings not closed yet, held messages. */
  panel: (env: EnvironmentId | null, companionId = selectedCompanionId) => call<SegnoPanel>(env, "panel", { companionId }),
  /** Closes finished work in the panel for good; the conversations stay. Answers the panel after. */
  dismiss: (env: EnvironmentId | null, endings: ReadonlyArray<Pick<SegnoFinished, "sessionId" | "at">>, companionId = selectedCompanionId) =>
    call<SegnoPanel>(env, "dismiss", { companionId, endings: endings.map(({ sessionId, at }) => ({ sessionId, at })) }),
  /**
   * Makes and registers a new companion's home; the engine opens its first conversation within seconds.
   * No `modelSelection` is Rubato's default, the same request as before (rubatoCompanionModelChoice.ts).
   */
  create: (env: EnvironmentId | null, modelSelection: CompanionModelSelection | null = null) =>
    call<{ companion: { id: string; sessionId: string | null } }>(env, "create", { ...companionCreateBody(modelSelection) }),
  /** The companion's picture as a data URL; null when it has none. */
  avatar: (env: EnvironmentId | null, companionId: string) =>
    call<{ avatar: CompanionAvatar | null }>(env, "avatar", { companionId }),
  /** A square jpeg, png or webp data URL (at most 2 MB), or null to clear the picture set here. */
  setAvatar: (env: EnvironmentId | null, companionId: string, image: string | null) =>
    call<{ avatar: CompanionAvatar | null }>(env, "set-avatar", { companionId, image }),
  icon: (env: EnvironmentId | null, companionId: string) =>
    call<{ icon: CompanionAvatar | null }>(env, "icon", { companionId }),
  setIcon: (env: EnvironmentId | null, companionId: string, image: string | null) =>
    call<{ icon: CompanionAvatar | null }>(env, "set-icon", { companionId, image }),
  /** The changes it proposed, newest last. */
  proposals: (env: EnvironmentId | null, companionId: string, signal?: AbortSignal) =>
    call<{ proposals: CompanionProposal[] }>(env, "proposals", { companionId }, signal),
  /** Saves one proposal; the only write. 409 `stale` when its text moved, `closed` when not open. */
  applyProposal: (env: EnvironmentId | null, companionId: string, proposalId: string) =>
    call<{ proposal: CompanionProposal }>(env, "apply-proposal", { companionId, proposalId }),
  declineProposal: (env: EnvironmentId | null, companionId: string, proposalId: string) =>
    call<{ proposal: CompanionProposal }>(env, "decline-proposal", { companionId, proposalId }),
  /** "Who it is" and "what it knows about me", in the companion's own words. */
  summaries: (env: EnvironmentId | null, companionId: string) => call<CompanionSummaries>(env, "summaries", { companionId }),
  /** Segno's art for one expression of its space, as a data URL; `version` changes when the file is swapped. */
  art: (env: EnvironmentId | null, state: SegnoStageState = "idle", companionId = selectedCompanionId) =>
    call<{ art: { url: string; version: number } }>(env, "art", { state, companionId }),
  /**
   * The T3 thread that shows the companion's conversation; null until the app has picked it up.
   * `current` marks the conversation it runs in now: that thread is its room, and the server takes
   * it out of the archive (RubatoCompanion.ts companionRoom).
   */
  thread: (env: EnvironmentId | null, sessionId: string, current = false) =>
    call<{ threadId: string | null }>(env, "thread", current ? { sessionId, current } : { sessionId }),
  /** What Segno said in a run of its thread that just ended; null when it said nothing to the person. */
  said: (env: EnvironmentId | null, threadId: string, runId: string) =>
    call<{ text: string | null }>(env, "said", { threadId, runId }),
  /**
   * A summary of what the companion did in each span between the room's bubbles: span i ends at
   * bubble i (`boundaries`, ms, oldest first) and the last span runs on after the last bubble.
   */
  inner: (env: EnvironmentId | null, companionId: string, boundaries: readonly number[], after?: number, revision?: string, signal?: AbortSignal) =>
    call<{ spans?: ReadonlyArray<SegnoSpanSummary | null>; revision?: string; unchanged?: true }>(env, "inner", {
      companionId,
      boundaries,
      versioned: true,
      revision,
      ...(after === undefined ? {} : { after }),
    }, signal),
  /** The kind of work the companion's tool does right now ('search', 'file', 'terminal', 'other') or null (bridge companion/inner.mjs liveWork). */
  live: (env: EnvironmentId | null, companionId: string, signal?: AbortSignal) => call<{ work: string | null }>(env, "live", { companionId }, signal),
  /** The pieces of one span: after `after`, up to and including `until` (null: up to now). */
  innerItems: (env: EnvironmentId | null, companionId: string, after: number | null, until: number | null) =>
    call<{ items: readonly SegnoInnerItem[] }>(env, "inner-items", {
      companionId,
      ...(after === null ? {} : { after }),
      ...(until === null ? {} : { until }),
    }),
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
  readonly selectedId: string;
  readonly companions: readonly CompanionChoice[];
}

// One view shared by the rail, the sidebar and the settings page.
let view: CompanionView = { status: null, threadId: null, selectedId: selectedCompanionId, companions: [] };
const listeners = new Set<() => void>();
const publish = (next: CompanionView) => {
  if (next.status === view.status && next.threadId === view.threadId && next.companions === view.companions && next.selectedId === view.selectedId) return;
  view = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Takes a status the settings page just saved, so the rail follows at once. */
export function acceptCompanionStatus(status: CompanionStatus): void {
  const id = status.id ?? selectedCompanionId;
  const companions = view.companions.map(item => item.id === id ? { ...item, ...status,
    id: item.id, ...(status.title === undefined ? { title: item.title, nameless: item.nameless ?? false } : titled(status)),
    threadId: item.sessionId === status.sessionId ? item.threadId : null } : item);
  publish({ ...view, companions, ...(id === selectedCompanionId ?
    { status: companions.find(item => item.id === id) ?? status,
      threadId: status.sessionId === view.status?.sessionId ? view.threadId : null } : {}) });
  void refresh(lastEnvironment);
}

/** A choice changes only what the person is viewing, never another companion's settings. */
export function selectCompanion(id: string): void {
  const item = view.companions.find(item => item.id === id);
  if (!item) return;
  selectedCompanionId = id;
  publish({ ...view, selectedId: id, status: item, threadId: item.threadId });
  void refresh(lastEnvironment);
}

export function companionForThread(threadId: string): CompanionChoice | undefined {
  return view.companions.find(item => item.threadId === threadId);
}

/** A nameless companion (title null) shows as "New companion" wherever a name goes. */
function titled(status: { readonly title?: string | null }): { title: string; nameless: boolean } {
  const title = typeof status.title === "string" && status.title.trim() !== "" && status.title !== NAMELESS_TITLE ? status.title : null;
  return { title: title ?? NAMELESS_TITLE, nameless: title === null };
}

let lastEnvironment: EnvironmentId | null = null;
let refreshing: Promise<void> | null = null;
// A conversation's thread, once the app shows it; a session the app has not picked up is asked again.
const threadOfSession = new Map<string, string>();
async function threadsOf(env: EnvironmentId, sessionIds: readonly string[]): Promise<string[]> {
  const found = await Promise.all(sessionIds.map(async sessionId => {
    const known = threadOfSession.get(sessionId);
    if (known) return known;
    const { threadId } = await rubatoCompanion.thread(env, sessionId).catch(() => ({ threadId: null }));
    if (threadId) threadOfSession.set(sessionId, threadId);
    return threadId;
  }));
  return found.filter((threadId): threadId is string => typeof threadId === "string");
}
function refresh(env: EnvironmentId | null): Promise<void> {
  if (env === null) return Promise.resolve();
  refreshing ??= (async () => {
    try {
      const { companions: statuses } = await rubatoCompanion.companions(env);
      const companions = await Promise.all(statuses.map(async status => {
        const previous = view.companions.find(item => item.id === status.id);
        const known = status.sessionId !== null && status.sessionId === previous?.sessionId ? previous.threadId : null;
        // Asked on every refresh, not kept: a room thread archived while the app runs comes back
        // out of the archive within one refresh.
        const threadId = status.sessionId === null ? null
          : (await rubatoCompanion.thread(env, status.sessionId, true).catch(() => ({ threadId: known }))).threadId;
        // An earlier conversation (the companion moved to a new one) is not a sidebar thread either.
        const conversationThreadIds = Array.isArray(status.conversations)
          ? await threadsOf(env, status.conversations)
          : previous?.conversationThreadIds ?? [];
        return { ...status, ...titled(status), threadId, conversationThreadIds };
      }));
      const selected = companions.find(item => item.id === selectedCompanionId) ?? companions[0];
      if (selected) selectedCompanionId = selected.id;
      publish({ status: selected ?? null, threadId: selected?.threadId ?? null, selectedId: selectedCompanionId, companions });
    } catch {
      // No companion route on this server: nothing shows.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// The control tower creates the conversation within seconds of turning the companion on, and the app
// shows it within five more; until then poll quickly, after that rarely.
const QUICK_POLL_MS = 3_000;
const SLOW_POLL_MS = 60_000;

/** The companion as the app knows it, kept fresh while anything shows it. */
export function useRubatoCompanion(): CompanionView {
  const environmentId = useReadyEnvironmentId();
  const current = useSyncExternalStore(subscribe, () => view);
  // A conversation on its way, or a first meeting whose chips should follow the talk, polls quickly.
  const waiting = current.companions.some(item => item.settings.enabled && (item.threadId === null || item.onboarding != null));
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

/** Asks the server again now, after any refresh already under way, so the answer is fresh. */
async function refreshNow(env: EnvironmentId): Promise<void> {
  if (refreshing) await refreshing;
  await refresh(env);
}

/**
 * Makes a new companion and shows it in the list, selected. Its first conversation follows within
 * seconds (waitForCompanionRoom).
 */
export async function createCompanion(env: EnvironmentId, modelSelection: CompanionModelSelection | null = null): Promise<string> {
  lastEnvironment = env;
  const { companion } = await rubatoCompanion.create(env, modelSelection);
  await refreshNow(env);
  selectCompanion(companion.id);
  return companion.id;
}

/** The companion's room thread once the app shows it; null when it has not come within `timeoutMs`. */
export async function waitForCompanionRoom(env: EnvironmentId, companionId: string, timeoutMs = 90_000, stepMs = 2_000): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await refreshNow(env);
    const threadId = view.companions.find(item => item.id === companionId)?.threadId ?? null;
    if (threadId !== null) return threadId;
    if (Date.now() >= until) return null;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

// Each companion's picture, fetched when its version moves; shared by the list, the rail and the room.
const avatars = new Map<string, { readonly version: number | null | undefined; readonly url: string | null }>();
const avatarsLoading = new Set<string>();
const avatarListeners = new Set<() => void>();
const publishAvatars = () => {
  for (const listener of avatarListeners) listener();
};
const subscribeAvatars = (listener: () => void) => {
  avatarListeners.add(listener);
  return () => avatarListeners.delete(listener);
};

/**
 * Takes the picture the settings page just set (or cleared), so every face follows at once.
 * `pictureSet` says whether it is now a picture set in the app; omitted, the next refresh tells.
 */
export function acceptCompanionAvatar(companionId: string, avatar: CompanionAvatar | null, pictureSet?: boolean): void {
  acceptCompanionImage("avatar", companionId, avatar, pictureSet);
}

export function acceptCompanionIcon(companionId: string, icon: CompanionAvatar | null): void {
  acceptCompanionImage("icon", companionId, icon);
}

function acceptCompanionImage(slot: "avatar" | "icon", companionId: string, image: CompanionAvatar | null, pictureSet?: boolean): void {
  avatars.set(`${slot}:${companionId}`, { version: image?.version ?? null, url: image?.url ?? null });
  publishAvatars();
  publish({ ...view, companions: view.companions.map(item =>
    item.id === companionId
      ? { ...item, [`${slot}Version`]: image?.version ?? null, ...(pictureSet === undefined ? {} : { pictureSet }) }
      : item) });
}

/**
 * The companion's picture as a data URL, or null while it has none or it has not loaded. A server
 * that does not say `avatarVersion` is asked once per app session.
 */
export function useCompanionAvatar(companionId: string | null | undefined): string | null {
  return useCompanionImage("avatar", companionId);
}

export function useCompanionIcon(companionId: string): string | null {
  return useCompanionImage("icon", companionId);
}

function useCompanionImage(slot: "avatar" | "icon", companionId: string | null | undefined): string | null {
  const environmentId = useReadyEnvironmentId();
  const current = useSyncExternalStore(subscribe, () => view);
  // Read through the store, not the map: a value read from module state during render would be
  // memoized by the React Compiler and never see the picture arrive.
  const key = `${slot}:${companionId}`;
  const cached = useSyncExternalStore(subscribeAvatars, () => avatars.get(key));
  const companion = current.companions.find(item => item.id === companionId);
  const wanted = companion?.[`${slot}Version`];
  const stale = !!companion && wanted !== null && (slot === "avatar" || wanted !== undefined)
    && (cached === undefined || (wanted !== undefined && cached.version !== wanted));
  useEffect(() => {
    if (!companionId || environmentId === null || !stale || avatarsLoading.has(key)) return;
    avatarsLoading.add(key);
    const previous = avatars.get(key);
    const request = slot === "avatar"
      ? rubatoCompanion.avatar(environmentId, companionId).then(({ avatar }) => avatar)
      : rubatoCompanion.icon(environmentId, companionId).then(({ icon }) => icon);
    request.then(
      (image) => { if (avatars.get(key) === previous) avatars.set(key, { version: image?.version ?? wanted ?? null, url: image?.url ?? null }); },
      // Asked again only when the version moves.
      () => { if (avatars.get(key) === previous) avatars.set(key, { version: wanted, url: previous?.url ?? null }); },
    ).finally(() => {
      avatarsLoading.delete(key);
      publishAvatars();
    });
  }, [companionId, environmentId, key, slot, stale, wanted]);
  if (!companionId || wanted === null) return null;
  return cached?.url ?? null;
}

/** Whether `threadId` is Segno's conversation, as far as the app knows it now. */
export function isCompanionThread(threadId: string): boolean {
  return companionForThread(threadId) !== undefined || (view.threadId !== null && view.threadId === threadId);
}

const steeringSettings = new WeakMap<object, object>();

/**
 * A model picked in a companion's room applies at once (RubatoCompanionModel.ts): the companion's
 * session switches now, so its own runs use it too, and the thread keeps the pick for the phone
 * and the next turn (user item bceb5547). Elsewhere a pick waits for the next send.
 */
export async function applyCompanionModel(
  environmentId: EnvironmentId,
  threadId: string,
  modelSelection: unknown,
): Promise<void> {
  await postRubato<Record<string, never>>(
    environmentId,
    "/rubato/companion-room",
    "model",
    { threadId, modelSelection },
    "companion models",
  );
}

/**
 * The composer's settings in a companion's room: what the person sends while the companion works
 * steers into that work instead of waiting in the queue (user item 6b6a88c5). The room never shows
 * what the companion is doing, so a queue would hold their words behind work they cannot see.
 * Elsewhere their own choice stands. One object per settings object keeps the composer's memos.
 */
export function companionComposerSettings<T extends { readonly followUpBehavior: "queue" | "steer" }>(
  settings: T,
  threadId: string | null | undefined,
): T {
  if (!threadId || settings.followUpBehavior === "steer" || !isCompanionThread(threadId)) return settings;
  let steering = steeringSettings.get(settings) as T | undefined;
  if (steering === undefined) {
    steering = { ...settings, followUpBehavior: "steer" };
    steeringSettings.set(settings, steering);
  }
  return steering;
}

/** At most this many characters of what Segno said show in a notification. */
export const SEGNO_NOTICE_CHARS = 120;

/**
 * A notification from Segno's thread reads like a messenger's (user 55dd0da4): Segno's name over
 * the start of what it said, as plain text. Null when it said nothing.
 */
export function segnoNotice(
  said: string | null | undefined,
  title = "Segno",
): { readonly title: string; readonly body: string } | null {
  if (typeof said !== "string") return null;
  const text = said
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = [...text];
  const body = chars.length > SEGNO_NOTICE_CHARS ? `${chars.slice(0, SEGNO_NOTICE_CHARS - 1).join("").trimEnd()}…` : text;
  return { title, body };
}

/** `projects` without Segno's own folder: no list offers it as a place to start work. */
export function useWithoutCompanionProjects<A extends ReadonlyArray<{ readonly workspaceRoot: string }>>(projects: A): A {
  const { companions } = useRubatoCompanion();
  return useMemo(
    () =>
      projects.filter(project => !companions.some(item => isCompanionProject(project, item.home))) as unknown as A,
    [companions, projects],
  );
}

/** Whether a project is Segno's own folder, which no project list shows. */
export function isCompanionProject(
  project: { readonly workspaceRoot: string },
  home: string | null | undefined,
): boolean {
  return home != null && findProjectByPath([project], home) !== undefined;
}

/**
 * Interface text in the current language, for text built in code (a companion's name inside a
 * Korean phrase). The language is an input, so a switch recomputes it.
 */
export function useUiText(text: string): string {
  const language = useSyncExternalStore(subscribeUiLanguage, uiLanguage, uiLanguage);
  return useMemo(() => (language === "ko" ? uiText(text) : text), [text, language]);
}
