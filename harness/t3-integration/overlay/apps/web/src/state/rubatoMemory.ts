import type { EnvironmentId } from "@t3tools/contracts";

import { rubatoHttpAccess } from "./rubatoHttp";
import { readPreparedConnection } from "./session";

/** The route Rubato adds to the T3 server on this Mac for Settings > Memory. */
const MEMORY_ROUTE = "/rubato/memory";

export interface MemoryStoreStatus {
  readonly store: string;
  readonly enabled: boolean;
  readonly lastDreamAt?: string;
  readonly lastRunId?: string;
  readonly newSessions: number;
  readonly due: boolean;
  readonly roots?: readonly string[];
  readonly home?: boolean;
  readonly files?: number;
  readonly running: { readonly startedAt?: string; readonly source: "gui" | "other" } | null;
  readonly lastGuiRun: {
    readonly startedAt?: string;
    readonly status: string;
    readonly runId?: string;
    readonly reason?: string;
  } | null;
}

/** One store as its directory shows it; fast, no session scan. */
export interface MemoryStoreSummary {
  readonly store: string;
  /** The store's git working tree on this Mac. */
  readonly repo: string;
  /** Project folders the store belongs to; null when the store predates store.json. */
  readonly roots: readonly string[] | null;
  readonly home: boolean | null;
  readonly files: number;
  readonly lastChangeAt: string | null;
  /** The newest dream that ran to an end (not skipped, not a trial). */
  readonly lastRun: {
    readonly runId: string;
    readonly status: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly reason?: string;
    readonly attempts: ReadonlyArray<DreamAttempt>;
    readonly landed: boolean;
  } | null;
  readonly enabled: boolean;
  readonly running: { readonly startedAt?: string; readonly source: "gui" | "other" } | null;
}

export interface MemoryFileEntry {
  readonly path: string;
  readonly description: string | null;
}

export type DreamReasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** One rung of the dream's model ladder; the dream tries them in order. */
export interface DreamModel {
  readonly model: string;
  /** null: the model's own default. */
  readonly reasoning: DreamReasoning | null;
}

export interface MemoryStatus {
  readonly models: readonly DreamModel[];
  readonly stores: readonly MemoryStoreStatus[];
}

export interface DreamRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly model?: string;
  readonly reason?: string;
  readonly review?: "merged" | "rejected" | "reverted";
  readonly reviewedAt?: string;
  readonly sessions: number;
  readonly commits: number;
  /** Every model tried, in ladder order; a failed one carries its last output line. */
  readonly attempts: ReadonlyArray<DreamAttempt>;
  /** In the store now: merged and not reverted since. */
  readonly landed: boolean;
}

export interface DreamAttempt {
  readonly model: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** A line a dream noticed about the user, not yet in user.md and not dismissed. */
export interface DreamSuggestion {
  readonly text: string;
  readonly store: string;
  readonly runId: string;
  readonly at: string | null;
}

/** One commit on a store's main line, read for the overview: who wrote it and what it touched. */
export interface MemoryActivity {
  readonly store: string;
  readonly sha: string;
  readonly at: string;
  /** dream: a dream's merge; you: an edit from this page; session: an agent's write. */
  readonly kind: "dream" | "session" | "you";
  /** The commit's reason (a dream's report summary); null when a session saved without one. */
  readonly text: string | null;
  readonly runId?: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly change: DreamChangeKind }>;
}

export interface MemorySearchHit {
  readonly store: string;
  readonly path: string;
  readonly description: string | null;
  readonly preview: string;
}

export type DreamChangeKind = "added" | "modified" | "deleted" | "renamed";

/** One file a dream changed, with what its report says about it. */
export interface DreamChange {
  readonly path: string;
  readonly change: DreamChangeKind;
  /** The old path of a renamed file. */
  readonly from?: string;
  /** The file's front-matter description (for a deleted file, as it was). */
  readonly description: string | null;
  readonly added: number;
  readonly removed: number;
  /** Report lines naming this file: why it changed, a claim fixed against code, a resolved conflict. */
  readonly notes: ReadonlyArray<{ readonly kind: "why" | "code" | "conflict"; readonly text: string }>;
  /** This file's part of the diff. */
  readonly diff: string;
}

export interface DreamRunDetail extends DreamRunSummary {
  readonly store: string;
  readonly report: string | null;
  /** The report's 요약. */
  readonly summary: string | null;
  readonly changes: readonly DreamChange[];
  readonly diffNote: string | null;
  /** Where an agent asked about the run reads it. */
  readonly sources: {
    readonly report: string | null;
    readonly range: { readonly base: string; readonly head: string } | null;
  };
}

export interface SelfFiles {
  readonly user: string;
  readonly soul: string;
  readonly repo: boolean;
}

export class MemoryRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  environmentId: EnvironmentId | null,
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) throw new MemoryRequestError("unavailable", "This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access)
    throw new MemoryRequestError("unavailable", "Memory settings are not available on this connection.");
  const response = await fetch(`${access.baseUrl}${MEMORY_ROUTE}/${action}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((cause: unknown) => {
    throw new MemoryRequestError(
      "network",
      cause instanceof Error ? `Could not reach this Mac: ${cause.message}` : "Could not reach this Mac.",
    );
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok || payload === null || (payload as { error?: unknown }).error) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401)
      throw new MemoryRequestError("unauthorized", "This connection is not allowed to change memory settings.");
    throw new MemoryRequestError(
      error?.code ?? `http-${response.status}`,
      error?.message ?? `Request failed (HTTP ${response.status}).`,
    );
  }
  return payload as T;
}

export const rubatoMemory = {
  stores: (env: EnvironmentId | null) =>
    call<{ memoryRoot: string; stores: MemoryStoreSummary[] }>(env, "stores"),
  files: (env: EnvironmentId | null, store: string) =>
    call<{ store: string; files: MemoryFileEntry[]; truncated: boolean }>(env, "files", { store }),
  file: (env: EnvironmentId | null, store: string, path: string) =>
    call<{ store: string; path: string; content: string; truncated: boolean }>(env, "file", {
      store,
      path,
    }),
  /** Writes the whole file and commits it; the commit is null when nothing changed. */
  saveFile: (env: EnvironmentId | null, store: string, path: string, content: string, message?: string) =>
    call<{ store: string; path: string; content: string; commit: string | null }>(env, "save-file", {
      store,
      path,
      content,
      ...(message ? { message } : {}),
    }),
  deleteFile: (env: EnvironmentId | null, store: string, path: string) =>
    call<{ store: string; path: string; commit: string | null }>(env, "delete-file", {
      store,
      path,
    }),
  deleteStore: (env: EnvironmentId | null, store: string) =>
    call<{ store: string; archive: string }>(env, "delete-store", { store, confirm: store }),
  status: (env: EnvironmentId | null) => call<MemoryStatus>(env, "status"),
  activity: (env: EnvironmentId | null, limit: number) =>
    call<{ items: MemoryActivity[] }>(env, "activity", { limit }),
  search: (env: EnvironmentId | null, query: string) =>
    call<{ engine: "msearch" | "plain"; results: MemorySearchHit[] }>(env, "search", { query }),
  runs: (env: EnvironmentId | null, store: string) =>
    call<{ store: string; runs: DreamRunSummary[] }>(env, "runs", {
      store,
    }),
  run: (env: EnvironmentId | null, store: string, runId: string) =>
    call<DreamRunDetail>(env, "run", { store, runId }),
  dream: (env: EnvironmentId | null, store: string) =>
    call<{ store: string; startedAt: string }>(env, "dream", { store }),
  config: (
    env: EnvironmentId | null,
    change:
      | { models: ReadonlyArray<{ model: string; reasoning?: DreamReasoning }> }
      | { store: string; enabled: boolean },
  ) => call<{ saved: unknown[] }>(env, "config", change),
  self: (env: EnvironmentId | null) => call<SelfFiles>(env, "self"),
  saveSelf: (
    env: EnvironmentId | null,
    file: "user.md" | "soul.md",
    content: string,
    summary?: string,
  ) =>
    call<{ file: string; commit: string | null }>(env, "self-save", {
      file,
      content,
      ...(summary ? { summary } : {}),
    }),
  suggestions: (env: EnvironmentId | null) => call<{ suggestions: DreamSuggestion[] }>(env, "suggestions"),
  addSuggestions: (env: EnvironmentId | null, lines: readonly string[]) =>
    call<{ added: number; commit: string | null }>(env, "add-suggestions", { lines }),
  dismissSuggestions: (env: EnvironmentId | null, lines: readonly string[]) =>
    call<{ dismissed: number }>(env, "dismiss-suggestions", { lines }),
};
