import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { postRubato } from "./rubatoHttp";

/** The route Rubato adds to the T3 server on this Mac for Settings > General > About. */
const APP_ROUTE = "/rubato/app";

export interface RubatoVersion {
  readonly revision: string | null;
  readonly short: string | null;
  readonly subject: string | null;
  readonly committedAt: string | null;
  readonly branch: string | null;
  /** Tracked files changed in the checkout; null when git could not say. */
  readonly localChanges: number | null;
  /** The stock Pi engine the checkout pins. */
  readonly pi: string | null;
  /** The T3 upstream commit the overlay applies to. */
  readonly t3: string | null;
}

export interface RubatoUpdateCheck {
  readonly available: boolean;
  readonly commits: number;
  readonly changes: ReadonlyArray<{ readonly short: string; readonly subject: string; readonly committedAt: string }>;
}

function call<T>(environmentId: EnvironmentId | null, action: string): Promise<T> {
  return postRubato<T>(environmentId, APP_ROUTE, action, {}, "Rubato settings");
}

export const rubatoApp = {
  version: (env: EnvironmentId | null) => call<RubatoVersion>(env, "version"),
  check: (env: EnvironmentId | null) => call<RubatoUpdateCheck>(env, "check"),
  restart: (env: EnvironmentId | null) => call<{ startedAt: string; log: string }>(env, "restart"),
};

export interface RubatoUpdateCheckState {
  /** The environment the result belongs to. */
  readonly environmentId: EnvironmentId | null;
  readonly check: RubatoUpdateCheck | null;
  readonly error: string | null;
  readonly checking: boolean;
}

// One check result for the whole app. A check fetches the Rubato checkout, so the
// settings nav dot and the About rows read the same result instead of each
// fetching; opening Settings again within STALE_MS reuses it.
const STALE_MS = 10 * 60_000;
const EMPTY: RubatoUpdateCheckState = { environmentId: null, check: null, error: null, checking: false };
let checkState = EMPTY;
let checkedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setCheckState(next: Partial<RubatoUpdateCheckState>) {
  checkState = { ...checkState, ...next };
  for (const listener of listeners) listener();
}

/** Checks unless a check for this environment is fresh or already running; `force` skips the freshness. */
export function checkRubatoUpdate(environmentId: EnvironmentId, force: boolean): Promise<void> {
  const same = checkState.environmentId === environmentId;
  if (inflight && same) return inflight;
  if (same && !force && Date.now() - checkedAt < STALE_MS) return Promise.resolve();
  if (!same) checkedAt = 0;
  setCheckState(same ? { checking: true } : { ...EMPTY, environmentId, checking: true });
  const run = rubatoApp.check(environmentId).then(
    (check) => {
      if (checkState.environmentId !== environmentId) return;
      checkedAt = Date.now();
      setCheckState({ check, error: null });
    },
    (error: unknown) => {
      if (checkState.environmentId !== environmentId) return;
      setCheckState({ error: error instanceof Error ? error.message : String(error) });
    },
  ).finally(() => {
    if (inflight === run) inflight = null;
    if (checkState.environmentId === environmentId) setCheckState({ checking: false });
  });
  inflight = run;
  return run;
}

const readCheckState = () => checkState;

export function __resetRubatoUpdateCheckForTests() {
  checkState = EMPTY;
  checkedAt = 0;
  inflight = null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The shared `rubato update --check` result. It checks on mount unless a check for
 * the same environment is under ten minutes old; `refresh` always checks again.
 */
export function useRubatoUpdateCheck(environmentId: EnvironmentId | null) {
  const state = useSyncExternalStore(subscribe, readCheckState, readCheckState);
  useEffect(() => {
    if (environmentId !== null) void checkRubatoUpdate(environmentId, false);
  }, [environmentId]);
  const refresh = useCallback(() => {
    if (environmentId !== null) void checkRubatoUpdate(environmentId, true);
  }, [environmentId]);
  return { ...(state.environmentId === environmentId ? state : { ...EMPTY, environmentId }), refresh };
}
