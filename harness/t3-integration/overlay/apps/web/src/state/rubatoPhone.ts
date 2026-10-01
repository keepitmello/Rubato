import type { EnvironmentId } from "@t3tools/contracts";

import { postRubato } from "./rubatoHttp";

/** The route Rubato adds to the T3 server on this Mac for Settings > Phone. */
const PHONE_ROUTE = "/rubato/phone";

export type PhoneLogin =
  | { readonly phase: "idle" }
  | { readonly phase: "code"; readonly userCode: string; readonly verificationUri: string; readonly expiresAt: number }
  | { readonly phase: "linking" }
  | { readonly phase: "error"; readonly message: string };

export interface PhoneStatus {
  readonly account: string | null;
  readonly signedIn: boolean;
  readonly linked: boolean;
  readonly notifications: boolean;
  readonly login: PhoneLogin;
}

function call(environmentId: EnvironmentId | null, action: string, body: Record<string, unknown> = {}) {
  return postRubato<PhoneStatus>(environmentId, PHONE_ROUTE, action, body, "phone settings");
}

export const rubatoPhone = {
  status: (env: EnvironmentId | null) => call(env, "status"),
  connect: (env: EnvironmentId | null) => call(env, "connect"),
  cancel: (env: EnvironmentId | null) => call(env, "cancel"),
  notifications: (env: EnvironmentId | null, enabled: boolean) => call(env, "notifications", { enabled }),
  disconnect: (env: EnvironmentId | null) => call(env, "disconnect"),
};
