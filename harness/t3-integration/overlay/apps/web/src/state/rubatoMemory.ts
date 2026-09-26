import type { EnvironmentId } from "@t3tools/contracts";

import { readPreparedConnection } from "./session";

/** The route Rubato adds to the T3 server on this Mac for Settings > 기억. */
const MEMORY_ROUTE = "/rubato/memory";

export type DreamPublish = "review" | "auto";

export interface MemoryStoreStatus {
  readonly store: string;
  readonly enabled: boolean;
  readonly lastDreamAt?: string;
  readonly lastRunId?: string;
  readonly pendingRunId?: string;
  readonly newSessions: number;
  readonly due: boolean;
  readonly running: { readonly startedAt?: string; readonly source: "gui" | "other" } | null;
  readonly lastGuiRun: {
    readonly startedAt?: string;
    readonly status: string;
    readonly runId?: string;
    readonly reason?: string;
  } | null;
}

export interface MemoryStatus {
  readonly category: string;
  readonly publish: DreamPublish;
  readonly categories: ReadonlyArray<{ readonly name: string; readonly models: readonly string[] }>;
  readonly stores: readonly MemoryStoreStatus[];
}

export interface DreamRunSummary {
  readonly runId: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly model?: string;
  readonly reason?: string;
  readonly review?: "merged" | "rejected";
  readonly reviewedAt?: string;
  readonly sessions: number;
  readonly commits: number;
  readonly pending: boolean;
}

export interface DreamRunDetail extends DreamRunSummary {
  readonly store: string;
  readonly sessionList: ReadonlyArray<{
    readonly id: string;
    readonly name?: string;
    readonly cwd?: string;
    readonly messages?: number;
  }>;
  readonly report: string | null;
  readonly candidates: ReadonlyArray<{ readonly text: string; readonly inUser: boolean }>;
  readonly diff: string;
  readonly diffNote: string | null;
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

function connectionFor(environmentId: EnvironmentId | null) {
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) throw new MemoryRequestError("unavailable", "이 Mac 에 연결돼 있지 않아.");
  const authorization = prepared.httpAuthorization;
  // A relay connection signs each request with a DPoP proof; this route is not on that surface.
  if (authorization?._tag === "Dpop")
    throw new MemoryRequestError("unavailable", "이 연결에서는 기억 설정을 열 수 없어.");
  return {
    baseUrl: prepared.httpBaseUrl.replace(/\/+$/, ""),
    headers:
      authorization === null
        ? {}
        : ({ authorization: `Bearer ${authorization.token}` } as Record<string, string>),
  };
}

async function call<T>(
  environmentId: EnvironmentId | null,
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const connection = connectionFor(environmentId);
  const response = await fetch(`${connection.baseUrl}${MEMORY_ROUTE}/${action}`, {
    method: "POST",
    credentials: "include",
    headers: { ...connection.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((cause: unknown) => {
    throw new MemoryRequestError(
      "network",
      cause instanceof Error ? `이 Mac 에 닿지 못했어: ${cause.message}` : "이 Mac 에 닿지 못했어.",
    );
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error?: { code?: string; message?: string } }
    | null;
  if (!response.ok || payload === null || (payload as { error?: unknown }).error) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401)
      throw new MemoryRequestError("unauthorized", "이 연결은 기억 설정을 바꿀 권한이 없어.");
    throw new MemoryRequestError(
      error?.code ?? `http-${response.status}`,
      error?.message ?? `요청이 실패했어 (HTTP ${response.status}).`,
    );
  }
  return payload as T;
}

export const rubatoMemory = {
  status: (env: EnvironmentId | null) => call<MemoryStatus>(env, "status"),
  runs: (env: EnvironmentId | null, store: string) =>
    call<{ store: string; pendingRunId: string | null; runs: DreamRunSummary[] }>(env, "runs", {
      store,
    }),
  run: (env: EnvironmentId | null, store: string, runId: string) =>
    call<DreamRunDetail>(env, "run", { store, runId }),
  dream: (env: EnvironmentId | null, store: string) =>
    call<{ store: string; startedAt: string }>(env, "dream", { store }),
  review: (env: EnvironmentId | null, store: string, decision: "approve" | "reject") =>
    call<{ store: string; runId: string; review: string }>(env, "review", { store, decision }),
  config: (
    env: EnvironmentId | null,
    change:
      | { category: string }
      | { publish: DreamPublish }
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
  addCandidates: (env: EnvironmentId | null, store: string, runId: string, lines: string[]) =>
    call<{ added: number; commit: string | null }>(env, "add-candidates", { store, runId, lines }),
};
