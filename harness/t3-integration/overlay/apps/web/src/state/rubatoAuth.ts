import type { EnvironmentId } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

/** The route Rubato adds to the T3 server on this Mac for Settings > Providers. */
const AUTH_ROUTE = "/rubato/auth";

export type ConnectionState = "connected" | "stale" | "blocked" | "absent";
export type LoginMethod = "oauth" | "api_key" | "setup-token";

export interface ProviderAccount {
  readonly name: string;
  /** Where the credential lives: `login` (auth.json), `setup-token` (~/.claude) or `env`. */
  readonly source: string;
  readonly type: "oauth" | "api_key" | "setup-token" | null;
  readonly state: ConnectionState;
  readonly pinned: boolean;
  readonly removable: boolean;
}

export interface ProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly methods: readonly LoginMethod[];
  readonly state: ConnectionState;
  readonly accounts: readonly ProviderAccount[];
}

export interface AuthStatus {
  readonly providers: readonly ProviderStatus[];
  readonly setupToken: { readonly path: string; readonly account: string };
}

export interface LoginPrompt {
  readonly id: number;
  /** `select`, `secret`, `text` or `manual_code` (a paste box racing the browser callback). */
  readonly kind: string;
  readonly message: string;
  readonly placeholder: string | null;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }> | null;
}

export interface LoginJob {
  readonly id: string;
  readonly provider: string;
  readonly method: LoginMethod;
  readonly status: "running" | "done" | "error" | "cancelled";
  readonly authUrl: { readonly url: string; readonly instructions: string | null } | null;
  readonly deviceCode: { readonly userCode: string; readonly verificationUri: string } | null;
  readonly info: readonly string[];
  readonly prompt: LoginPrompt | null;
  readonly message: string | null;
}

export interface CheckResult {
  readonly kind: "ok" | "unsupported" | "stale" | "renew_failed";
  readonly message: string;
}

function call<T>(environmentId: EnvironmentId | null, action: string, body: Record<string, unknown> = {}): Promise<T> {
  return postRubato<T>(environmentId, AUTH_ROUTE, action, body, "provider accounts");
}

export const rubatoAuth = {
  status: (env: EnvironmentId | null) => call<AuthStatus>(env, "status"),
  check: (env: EnvironmentId | null, provider: string, account: string) =>
    call<CheckResult>(env, "check", { provider, account }),
  pin: (env: EnvironmentId | null, provider: string, account: string | null) =>
    call<{ ok: true }>(env, "pin", { provider, account }),
  remove: (env: EnvironmentId | null, provider: string, account: string) =>
    call<{ ok: true }>(env, "remove", { provider, account }),
  login: (env: EnvironmentId | null, provider: string, method: LoginMethod) =>
    call<LoginJob>(env, "login", { provider, method }),
  loginState: (env: EnvironmentId | null, job: string) => call<LoginJob>(env, "login-state", { job }),
  answer: (env: EnvironmentId | null, job: string, prompt: number, value: string) =>
    call<LoginJob>(env, "answer", { job, prompt, value }),
  cancel: (env: EnvironmentId | null, job: string) => call<LoginJob>(env, "cancel", { job }),
};
