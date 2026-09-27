import type { EnvironmentId } from "@t3tools/contracts";

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
