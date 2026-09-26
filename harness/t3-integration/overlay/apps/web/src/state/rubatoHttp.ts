import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import type { readPreparedConnection } from "./session";

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
