// One POST to a Rubato route on a paired Mac's server: `<route>/<action>`, JSON both ways. The Mac's
// T3 server answers /rubato/companion and /rubato/call (harness/t3-integration overlay
// RubatoCompanion.ts, RubatoServiceRoute.ts) for a session allowed to operate it, authenticated the way
// T3's own endpoints are: the bearer of an older pairing, or a DPoP-bound token with a proof for each
// request (client-runtime state/rubatoEnvironmentHttp.ts). A relay connection has no Rubato routes.
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { rubatoEnvironmentAuthorization } from "@t3tools/client-runtime/state/rubatoEnvironmentHttp";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpMethod } from "effect/http";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
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

const notConnected = () =>
  new RubatoRequestError({ code: "unavailable", message: "This Mac is not connected.", status: 0 });

/**
 * The headers that authorize `method url` on this connection, with the DPoP token they carry (null for a
 * bearer). Null when this connection cannot reach a Rubato route.
 */
export async function rubatoAuthorization(
  prepared: Pick<PreparedConnection, "httpAuthorization">,
  method: HttpMethod.HttpMethod,
  url: string,
  rejectedAccessToken?: string,
): Promise<{ readonly headers: Readonly<Record<string, string>>; readonly dpopAccessToken: string | null } | null> {
  const authorization = prepared.httpAuthorization;
  // A bearer needs nothing from the runtime: no signing, no renewal.
  if (authorization === null) return { headers: {}, dpopAccessToken: null };
  if (authorization._tag === "Bearer")
    return { headers: { authorization: `Bearer ${authorization.token}` }, dpopAccessToken: null };
  // The connection runtime (keys, signer) loads only for a DPoP pairing; a bearer never needs it.
  const { connectionAtomRuntime } = await import("../../connection/runtime");
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime).pipe(
      Effect.flatMap((context) =>
        rubatoEnvironmentAuthorization(prepared, method, url, rejectedAccessToken).pipe(Effect.provide(context)),
      ),
    ),
  );
}

/**
 * fetch with this connection's credentials. A DPoP token the Mac turns down (401) is renewed and the
 * request sent once more, as T3's own requests do.
 */
export async function rubatoFetch(
  prepared: Pick<PreparedConnection, "httpAuthorization">,
  url: string,
  init: RequestInit & { readonly method: HttpMethod.HttpMethod },
): Promise<Response> {
  const send = async (rejected?: string) => {
    const access = await rubatoAuthorization(prepared, init.method, url, rejected);
    if (!access) throw notConnected();
    const headers = { ...(init.headers as Record<string, string> | undefined), ...access.headers };
    return { response: await fetch(url, { ...init, headers }), token: access.dpopAccessToken };
  };
  const first = await send();
  if (first.response.status !== 401 || first.token === null) return first.response;
  return (await send(first.token)).response;
}

/** A Mac this phone saved a pairing with: its id, and the session bearer an older pairing keeps. */
export interface SavedMac {
  readonly environmentId: string;
  readonly bearerToken: string | null;
}

/**
 * Headers for `method url` on a saved Mac: its live connection's credentials (bearer, or DPoP with a
 * proof), or while it is not connected, the bearer an older pairing saved.
 */
export async function savedMacHeaders(
  saved: SavedMac,
  method: HttpMethod.HttpMethod,
  url: string,
): Promise<Record<string, string>> {
  const prepared = readPrepared(saved.environmentId as EnvironmentId);
  const access = prepared ? await rubatoAuthorization(prepared, method, url) : null;
  if (access) return { ...access.headers };
  if (saved.bearerToken) return { authorization: `Bearer ${saved.bearerToken}` };
  throw notConnected();
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
  const prepared = await awaitPrepared(environmentId, options.waitForConnectionMs ?? 0, options.signal);
  if (!prepared) throw notConnected();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  options.signal?.addEventListener("abort", () => controller.abort());
  let response: Response;
  try {
    response = await rubatoFetch(prepared, `${prepared.httpBaseUrl.replace(/\/+$/, "")}${route}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (isRubatoRequestError(cause)) throw cause;
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
