import { beforeEach, describe, expect, it } from "vite-plus/test";

import { __resetLiveActivitiesForTest, syncLiveActivities, type CardHandle, type LiveActivityDeps, type MacCard } from "./liveActivity";
import { DEFAULT_PREFERENCES, type PushState } from "./sync";

const RELAY = "https://relay.test";
const MAC = { environmentId: "env-mac", httpBaseUrl: "https://wy-mac.tail.ts.net/", bearerToken: "session-token" };
const NOW = Date.UTC(2026, 10, 21, 12);

const card = (activeCount: number): MacCard => ({
  title: "Rubato",
  subtitle: activeCount ? "Agent work in progress" : "Agent work completed",
  activeCount,
  updatedAt: "2026-11-21T12:00:00.000Z",
  environmentId: "env-mac",
  activities: [],
});

function world({ token = "ab".repeat(40) as string | null } = {}) {
  let stored: PushState | null = {
    relay: RELAY,
    bundleId: "com.keepitmello.rubato",
    environment: "sandbox",
    deviceId: "dev-1",
    deviceSecret: "rpd_secret",
    apnsToken: "aa",
    voipToken: null,
    grants: { "env-mac": { grantId: "grant-1", httpBaseUrl: "https://wy-mac.tail.ts.net" } },
    preferences: DEFAULT_PREFERENCES,
  };
  let macState: MacCard | null = card(1);
  let macUp = true;
  const relayCalls: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const live: Array<{ id: string; props: MacCard; ended: string | null; stale: Date | null; listener?: (event: { pushToken?: string | null }) => void }> = [];
  const handle = (entry: (typeof live)[number]): CardHandle => ({
    getId: () => entry.id,
    update: async (props, staleDate) => {
      entry.props = props;
      entry.stale = staleDate ?? null;
    },
    end: async (dismissal = "default", props) => {
      entry.ended = dismissal;
      if (props) entry.props = props;
    },
    getPushToken: async () => token,
    addPushTokenListener: (listener) => {
      entry.listener = listener;
      return { remove: () => {} };
    },
  });
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (url === "https://wy-mac.tail.ts.net/rubato/push/activity") {
      if (!macUp) throw new TypeError("network");
      return Response.json({ state: macState });
    }
    if (url.startsWith(`${RELAY}/v1/devices/dev-1/grants/`)) {
      relayCalls.push({ url, auth: headers.authorization ?? null, body: JSON.parse(init.body as string) });
      return Response.json({ ok: true });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  let next = 0;
  const deps: LiveActivityDeps = {
    relay: RELAY,
    bundleId: "com.keepitmello.rubato",
    environment: "sandbox",
    deviceLabel: "iPhone",
    fetch,
    load: async () => stored,
    save: async (state) => {
      stored = state;
    },
    cards: () => live.filter((entry) => entry.ended === null).map(handle),
    start: (props, staleDate) => {
      const entry = { id: `card-${++next}`, props, ended: null, stale: staleDate };
      live.push(entry);
      return handle(entry);
    },
    now: () => NOW,
  };
  return {
    deps,
    live,
    relayCalls,
    stored: () => stored,
    setMac: (state: MacCard | null) => {
      macState = state;
    },
    macDown: (down: boolean) => {
      macUp = !down;
    },
    setStored: (state: PushState) => {
      stored = state;
    },
  };
}

beforeEach(() => __resetLiveActivitiesForTest());

describe("the Live Activity card", () => {
  it("opens for a Mac with work running and hands its token to the relay", async () => {
    const { deps, live, relayCalls, stored } = world();
    await syncLiveActivities(deps, [MAC]);
    expect(live).toHaveLength(1);
    expect(live[0]!.props.activeCount).toBe(1);
    expect(live[0]!.stale).toEqual(new Date(NOW + 10 * 60_000));
    expect(relayCalls).toEqual([
      { url: `${RELAY}/v1/devices/dev-1/grants/grant-1/activity`, auth: "Bearer rpd_secret", body: { activityToken: "ab".repeat(40) } },
    ]);
    expect(stored()?.activities).toEqual({ "env-mac": { id: "card-1", token: "ab".repeat(40) } });

    // The app comes back: the same card is refreshed, no second one, and the relay already has the token.
    await syncLiveActivities(deps, [MAC]);
    expect(live).toHaveLength(1);
    expect(relayCalls).toHaveLength(1);
  });

  it("waits for iOS to hand out the token when it is not there yet", async () => {
    const { deps, live, relayCalls, stored } = world({ token: null });
    await syncLiveActivities(deps, [MAC]);
    expect(relayCalls).toEqual([]);
    live[0]!.listener!({ pushToken: "cd".repeat(40) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relayCalls.map((call) => call.body)).toEqual([{ activityToken: "cd".repeat(40) }]);
    expect(stored()?.activities?.["env-mac"]).toEqual({ id: "card-1", token: "cd".repeat(40) });
  });

  it("does not open when nothing runs, and closes showing how the work ended", async () => {
    const { deps, live, relayCalls, setMac, stored } = world();
    setMac(card(0));
    await syncLiveActivities(deps, [MAC]);
    expect(live).toHaveLength(0);
    setMac(card(1));
    await syncLiveActivities(deps, [MAC]);
    setMac(card(0));
    await syncLiveActivities(deps, [MAC]);
    expect(live[0]!.ended).toBe("default");
    expect(live[0]!.props.subtitle).toBe("Agent work completed");
    expect(relayCalls.at(-1)?.body).toEqual({ activityToken: null });
    expect(stored()?.activities).toEqual({});
  });

  it("stays as it is while the Mac is out of reach", async () => {
    const { deps, live, macDown } = world();
    await syncLiveActivities(deps, [MAC]);
    macDown(true);
    await syncLiveActivities(deps, [MAC]);
    expect(live[0]!.ended).toBeNull();
  });

  it("closes at once when turned off, and closes cards no Mac owns", async () => {
    const { deps, live, stored, setStored } = world();
    deps.start(card(1), new Date(NOW));
    await syncLiveActivities(deps, [MAC]);
    expect(live[0]!.ended).toBe("immediate");
    expect(live[1]!.ended).toBeNull();
    setStored({ ...stored()!, preferences: { ...DEFAULT_PREFERENCES, liveActivity: false } });
    await syncLiveActivities(deps, [MAC]);
    expect(live[1]!.ended).toBe("immediate");
  });

  it("forgets a card the person swiped away, so the next run opens a new one", async () => {
    const { deps, live, relayCalls, stored } = world();
    await syncLiveActivities(deps, [MAC]);
    live[0]!.ended = "default";
    await syncLiveActivities(deps, [MAC]);
    expect(relayCalls.map((call) => call.body)).toEqual([
      { activityToken: "ab".repeat(40) },
      { activityToken: null },
      { activityToken: "ab".repeat(40) },
    ]);
    expect(live).toHaveLength(2);
    expect(stored()?.activities?.["env-mac"]?.id).toBe("card-2");
  });
});
