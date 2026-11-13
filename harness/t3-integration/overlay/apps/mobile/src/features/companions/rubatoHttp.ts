// One POST to a Rubato route on a paired Mac's server: `<route>/<action>`, JSON both ways. The Mac's
// T3 server answers /rubato/companion and /rubato/call (harness/t3-integration overlay
// RubatoCompanion.ts, RubatoServiceRoute.ts) for a session allowed to operate it; the phone proves
// that with the bearer token it paired with. A relay (DPoP) connection has no Rubato routes.
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession } from "../../state/session";

export class RubatoRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Base URL and headers for a Rubato route, or null when this connection cannot reach one. */
export function rubatoAccess(
  prepared: PreparedConnection | null,
): { readonly baseUrl: string; readonly headers: Record<string, string> } | null {
  if (!prepared) return null;
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag === "Dpop") return null;
  return {
    baseUrl: prepared.httpBaseUrl.replace(/\/+$/, ""),
    headers: authorization ? { authorization: `Bearer ${authorization.token}` } : {},
  };
}

export function readPrepared(environmentId: EnvironmentId): PreparedConnection | null {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

/** Every Mac this phone is paired with, in the order the app lists them. */
export function pairedEnvironmentIds(): EnvironmentId[] {
  return [...appAtomRegistry.get(environmentPresentations.presentationsAtom).keys()];
}

export async function postRubato<T>(
  environmentId: EnvironmentId,
  route: string,
  action: string,
  body: Record<string, unknown> = {},
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<T> {
  const access = rubatoAccess(readPrepared(environmentId));
  if (!access) throw new RubatoRequestError("unavailable", "This Mac is not connected.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  options.signal?.addEventListener("abort", () => controller.abort());
  let response: Response;
  try {
    response = await fetch(`${access.baseUrl}${route}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...access.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    throw new RubatoRequestError(
      "network",
      cause instanceof Error && cause.name === "AbortError" ? "The Mac did not answer." : "Could not reach the Mac.",
    );
  } finally {
    clearTimeout(timer);
  }
  const value = (await response.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string } | string })
    | null;
  if (!response.ok) {
    const error = value?.error;
    const code = typeof error === "object" && error?.code ? error.code : `http-${response.status}`;
    const message =
      typeof error === "object" && error?.message
        ? error.message
        : typeof error === "string"
          ? error
          : `The Mac answered HTTP ${response.status}.`;
    throw new RubatoRequestError(code, message, response.status);
  }
  return value as T;
}
