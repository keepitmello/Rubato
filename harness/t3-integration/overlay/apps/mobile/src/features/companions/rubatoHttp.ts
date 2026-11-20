// One POST to a Rubato route on a paired Mac's server: `<route>/<action>`, JSON both ways. The Mac's
// T3 server answers /rubato/companion and /rubato/call (harness/t3-integration overlay
// RubatoCompanion.ts, RubatoServiceRoute.ts) for a session allowed to operate it; the phone proves
// that with the bearer token it paired with. A relay (DPoP) connection has no Rubato routes.
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession } from "../../state/session";

/** A Rubato route that did not answer as asked: `status` is the HTTP status, 0 when none came. */
export class RubatoRequestError extends Schema.TaggedError<RubatoRequestError>()(
  "RubatoRequestError",
  { code: Schema.String, message: Schema.String, status: Schema.Number },
) {}

export const isRubatoRequestError = Schema.is(RubatoRequestError);

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

/**
 * The paired Mac's connection, waiting up to `waitMs` while it is still being made: right after
 * launch or a return to the app every Mac reconnects, and a request asked then failed outright.
 */
export function awaitPrepared(
  environmentId: EnvironmentId,
  waitMs: number,
  signal?: AbortSignal,
): Promise<PreparedConnection | null> {
  const ready = readPrepared(environmentId);
  if (ready || waitMs <= 0) return Promise.resolve(ready);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (prepared: PreparedConnection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener("abort", abort);
      resolve(prepared);
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, waitMs);
    signal?.addEventListener("abort", abort);
    unsubscribe = appAtomRegistry.subscribe(
      environmentSession.preparedConnectionValueAtom(environmentId),
      (value) => {
        const prepared = Option.getOrNull(value);
        if (prepared) finish(prepared);
      },
    );
    // It may have come between the first read and the subscription.
    const now = readPrepared(environmentId);
    if (now) finish(now);
  });
}

export async function postRubato<T>(
  environmentId: EnvironmentId,
  route: string,
  action: string,
  body: Record<string, unknown> = {},
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    /** How long to wait for a connection still being made; by default a request fails at once. */
    readonly waitForConnectionMs?: number;
  } = {},
): Promise<T> {
  const access = rubatoAccess(await awaitPrepared(environmentId, options.waitForConnectionMs ?? 0, options.signal));
  if (!access) throw new RubatoRequestError({ code: "unavailable", message: "This Mac is not connected.", status: 0 });
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
    throw new RubatoRequestError({
      code: "network",
      message:
        cause instanceof Error && cause.name === "AbortError" ? "The Mac did not answer." : "Could not reach the Mac.",
      status: 0,
    });
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
    throw new RubatoRequestError({ code, message, status: response.status });
  }
  return value as T;
}
