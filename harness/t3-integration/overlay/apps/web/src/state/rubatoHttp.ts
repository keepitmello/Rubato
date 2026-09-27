import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { readPreparedConnection } from "./session";

type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

/** How a request to a Rubato route on the T3 server proves who it is. */
export interface RubatoHttpAccess {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentials: RequestCredentials;
}

/**
 * T3's own rule (environments/primary/httpLayer.ts): only a browser page served
 * by the server itself sends the session cookie. Everything else, the desktop
 * renderer included, is cross-origin to the server, which answers CORS with a
 * wildcard origin — a credentialed request there fails before it leaves. Those
 * send a bearer token and no cookie.
 *
 * Returns null for a relay (DPoP) connection: our routes are not on its signed surface.
 */
export async function rubatoHttpAccess(
  prepared: PreparedConnection,
): Promise<RubatoHttpAccess | null> {
  const baseUrl = prepared.httpBaseUrl.replace(/\/+$/, "");
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag === "Dpop") return null;
  if (authorization !== null) {
    return { baseUrl, headers: { authorization: `Bearer ${authorization.token}` }, credentials: "omit" };
  }
  if (isSameOriginPage(baseUrl)) return { baseUrl, headers: {}, credentials: "include" };
  const token = await readDesktopPrimaryBearerToken().catch(() => null);
  return {
    baseUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: "omit",
  };
}

function isSameOriginPage(baseUrl: string): boolean {
  if (typeof window === "undefined" || window.desktopBridge !== undefined) return false;
  if (!window.location.origin.startsWith("http")) return false;
  try {
    return new URL(baseUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

export class RubatoRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One POST to a Rubato route on this Mac's T3 server: `<route>/<action>`, JSON
 * both ways. Errors come back as RubatoRequestError with the server's code.
 * `what` names the page's subject in the messages ("provider accounts").
 */
export async function postRubato<T>(
  environmentId: Parameters<typeof readPreparedConnection>[0] | null,
  route: string,
  action: string,
  body: Record<string, unknown>,
  what: string,
): Promise<T> {
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) throw new RubatoRequestError("unavailable", "This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access)
    throw new RubatoRequestError("unavailable", `${what[0]!.toUpperCase()}${what.slice(1)} are not available on this connection.`);
  const response = await fetch(`${access.baseUrl}${route}/${action}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((cause: unknown) => {
    throw new RubatoRequestError(
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
      throw new RubatoRequestError("unauthorized", `This connection is not allowed to change ${what}.`);
    throw new RubatoRequestError(
      error?.code ?? `http-${response.status}`,
      error?.message ?? `Request failed (HTTP ${response.status}).`,
    );
  }
  return payload as T;
}
