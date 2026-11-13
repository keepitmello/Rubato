import { describe, expect, it } from "vite-plus/test";

import { syncRubatoPush, type PushState, type PushSyncDeps } from "./sync";

const RELAY = "https://relay.test";
const MAC = { environmentId: "env-mac", httpBaseUrl: "https://wy-mac.tail.ts.net/", bearerToken: "session-token" };

function world({ macAnswers = 200, relayPut = 200 }: { macAnswers?: number; relayPut?: number } = {}) {
  let stored: PushState | null = null;
  const requests: Array<{ method: string; url: string; auth: string | null; body: any }> = [];
  let grants = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(init.body as string) : null;
    requests.push({ method: init.method ?? "GET", url, auth: headers.authorization ?? null, body });
    const respond = (status: number, value: unknown = {}) => new Response(JSON.stringify(value), { status });
    if (url === `${RELAY}/v1/devices` && init.method === "POST") return respond(201, { deviceId: "dev-1", deviceSecret: "rpd_secret" });
    if (url === `${RELAY}/v1/devices/dev-1` && init.method === "PUT") return respond(relayPut);
    if (url === `${RELAY}/v1/devices/dev-1/grants` && init.method === "POST") {
      grants += 1;
      return respond(201, { grantId: `grant-${grants}`, grant: `rpg_${grants}` });
    }
    if (url.startsWith(`${RELAY}/v1/devices/dev-1/grants/`) && init.method === "DELETE") return respond(200, { ok: true });
    if (url === "https://wy-mac.tail.ts.net/rubato/push/register") return respond(macAnswers, { ok: true });
    return respond(404);
  }) as unknown as typeof globalThis.fetch;
  const deps: PushSyncDeps = {
    relay: RELAY,
    bundleId: "com.keepitmello.rubato",
    environment: "production",
    deviceLabel: "wy's iPhone",
    fetch,
    load: async () => stored,
    save: async (state) => {
      stored = state;
    },
  };
  return { deps, requests, stored: () => stored };
}

describe("syncRubatoPush", () => {
  it("registers the tokens with the relay only, and hands each Mac a grant, not a token", async () => {
    const { deps, requests, stored } = world();
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: "bb", connections: [MAC] });
    expect(requests.map((item) => `${item.method} ${item.url}`)).toEqual([
      `POST ${RELAY}/v1/devices`,
      `POST ${RELAY}/v1/devices/dev-1/grants`,
      "POST https://wy-mac.tail.ts.net/rubato/push/register",
    ]);
    expect(requests[0]!.body).toEqual({ bundleId: "com.keepitmello.rubato", environment: "production", apnsToken: "aa", voipToken: "bb" });
    expect(requests[1]!.auth).toBe("Bearer rpd_secret");
    const toMac = requests[2]!;
    expect(toMac.auth).toBe("Bearer session-token");
    expect(toMac.body).toEqual({ relay: RELAY, grant: "rpg_1", grantId: "grant-1", deviceId: "dev-1", label: "wy's iPhone" });
    expect(JSON.stringify(toMac.body)).not.toContain("aa");
    expect(stored()?.grants).toEqual({ "env-mac": { grantId: "grant-1", httpBaseUrl: "https://wy-mac.tail.ts.net" } });
  });

  it("does nothing more when nothing changed, and sends only new tokens", async () => {
    const { deps, requests } = world();
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: "bb", connections: [MAC] });
    requests.length = 0;
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: "bb", connections: [MAC] });
    expect(requests).toEqual([]);
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: "cc", connections: [MAC] });
    expect(requests.map((item) => [item.method, item.url, item.body])).toEqual([
      ["PUT", `${RELAY}/v1/devices/dev-1`, { apnsToken: "aa", voipToken: "cc" }],
    ]);
  });

  it("revokes the grant of a Mac that is no longer paired", async () => {
    const { deps, requests, stored } = world();
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: null, connections: [MAC] });
    requests.length = 0;
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: null, connections: [] });
    expect(requests.map((item) => `${item.method} ${item.url}`)).toEqual([`DELETE ${RELAY}/v1/devices/dev-1/grants/grant-1`]);
    expect(stored()?.grants).toEqual({});
  });

  it("leaves no grant behind when the Mac cannot take it, and tries again next time", async () => {
    const unreachable = world({ macAnswers: 404 });
    await syncRubatoPush(unreachable.deps, { apnsToken: "aa", voipToken: null, connections: [MAC] });
    expect(unreachable.requests.at(-1)).toMatchObject({ method: "DELETE", url: `${RELAY}/v1/devices/dev-1/grants/grant-1` });
    expect(unreachable.stored()?.grants).toEqual({});
  });

  it("registers again when the relay no longer knows the phone", async () => {
    const { deps, requests } = world({ relayPut: 401 });
    await syncRubatoPush(deps, { apnsToken: "aa", voipToken: null, connections: [] });
    requests.length = 0;
    await syncRubatoPush(deps, { apnsToken: "dd", voipToken: null, connections: [] });
    expect(requests.map((item) => `${item.method} ${item.url}`)).toEqual([`PUT ${RELAY}/v1/devices/dev-1`, `POST ${RELAY}/v1/devices`]);
  });

  it("waits for a token before registering anything", async () => {
    const { deps, requests } = world();
    await syncRubatoPush(deps, { apnsToken: null, voipToken: null, connections: [MAC] });
    expect(requests).toEqual([]);
  });
});
