import type { EnvironmentId, RubatoCacheSnapshot } from "@t3tools/contracts";

import { rubatoHttpAccess } from "./rubatoHttp";
import { readPreparedConnection } from "./session";

/** The route Rubato adds to the T3 server for the context ring's warmer switch. */
const CACHE_WARMING_ROUTE = "/rubato/cache-warming";

/** Switches one session's warmer; answers with that session's cache after the switch. */
export async function setSessionCacheWarming(
  environmentId: EnvironmentId,
  sessionId: string,
  enabled: boolean,
): Promise<RubatoCacheSnapshot> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Cache warming is not available on this connection.");
  const response = await fetch(`${access.baseUrl}${CACHE_WARMING_ROUTE}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, enabled }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { cache?: RubatoCacheSnapshot; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.cache) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload.cache;
}
