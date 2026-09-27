import type { EnvironmentId } from "@t3tools/contracts";

import { rubatoHttpAccess } from "./rubatoHttp";
import { readPreparedConnection } from "./session";

/** The route Rubato adds to the T3 server for the context ring's warmer switch. */
const CACHE_WARMING_ROUTE = "/rubato/cache-warming";

export type CacheWarmingMode = "off" | "idle" | "streaming";

/** Sets the one global warming mode on the Mac that runs the thread's sessions. */
export async function setCacheWarmingMode(
  environmentId: EnvironmentId,
  mode: CacheWarmingMode,
): Promise<CacheWarmingMode> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This Mac is not connected.");
  const access = await rubatoHttpAccess(prepared);
  if (!access) throw new Error("Cache warming is not available on this connection.");
  const response = await fetch(`${access.baseUrl}${CACHE_WARMING_ROUTE}`, {
    method: "POST",
    credentials: access.credentials,
    headers: { ...access.headers, "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { mode?: CacheWarmingMode; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.mode) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload.mode;
}
