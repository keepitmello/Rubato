// The Live Activity card of each paired Mac's running threads, on the lock screen and in the Dynamic
// Island (upstream's AgentActivity widget). iOS lets the app start a card only while it is in front,
// so the phone opens one when it comes to the front or the person starts work from it, and hands the
// card's token to the relay; from then on the Mac keeps the card current and ends it when nothing runs
// (src/push/service.mjs, activityCard).
//
//   phone ── what is running? ──▶ Mac     POST /rubato/push/activity      → { state }
//   phone ── card token ────────▶ relay   PUT /v1/devices/:id/grants/:grantId/activity
//   Mac   ── card ──────────────▶ relay ──▶ APNs ──▶ the card
//
// Upstream starts its card only in front for the same reason: a card the relay started in the
// background often never got its token back to the relay.
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import type { MacConnection, PushState, PushSyncDeps } from "./sync";
import { pushPreferences } from "./sync";

/** What the Mac's card shows; `environmentId` says whose card it is. */
export type MacCard = AgentActivityProps & { readonly environmentId?: string };

/** One card on this phone (expo-widgets' LiveActivity). */
export interface CardHandle {
  readonly getId: () => string;
  readonly update: (props: MacCard, staleDate?: Date) => Promise<void>;
  readonly end: (dismissal?: "default" | "immediate", props?: MacCard) => Promise<void>;
  readonly getPushToken: () => Promise<string | null>;
  readonly addPushTokenListener: (listener: (event: { pushToken?: string | null }) => void) => { remove(): void };
}

export interface LiveActivityDeps extends PushSyncDeps {
  readonly cards: () => ReadonlyArray<CardHandle>;
  readonly start: (props: MacCard, staleDate: Date) => CardHandle | null;
  readonly now?: () => number;
}

/** The relay dims a card it has not heard about for 10 minutes; a card started here does the same. */
const STALE_AFTER_MS = 10 * 60_000;

const listening = new Set<string>();

async function macCard(deps: LiveActivityDeps, connection: MacConnection, httpBaseUrl: string): Promise<MacCard | null | undefined> {
  try {
    const response = await deps.fetch(`${httpBaseUrl}/rubato/push/activity`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${connection.bearerToken}` },
      body: "{}",
    });
    if (!response.ok) return undefined;
    const { state } = (await response.json()) as { state?: MacCard | null };
    return state ?? null;
  } catch {
    return undefined;
  }
}

async function tellRelay(deps: LiveActivityDeps, state: PushState, grantId: string, activityToken: string | null): Promise<boolean> {
  const response = await deps
    .fetch(`${state.relay}/v1/devices/${encodeURIComponent(state.deviceId)}/grants/${encodeURIComponent(grantId)}/activity`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.deviceSecret}` },
      body: JSON.stringify({ activityToken }),
    })
    .catch(() => null);
  return response?.ok === true;
}

/**
 * Opens, refreshes or closes this phone's card for every paired Mac, as each Mac says its threads are
 * now. A Mac out of reach keeps its card as it is. Run it while the app is in front.
 */
export async function syncLiveActivities(deps: LiveActivityDeps, connections: ReadonlyArray<MacConnection>): Promise<void> {
  const log = deps.log ?? (() => {});
  let state = await deps.load();
  if (!state) return;
  const now = deps.now ?? Date.now;
  const enabled = pushPreferences(state).liveActivity;
  const cards = new Map(deps.cards().map((card) => [card.getId(), card]));
  const open: Record<string, { id: string; token: string | null }> = { ...state.activities };
  const save = async () => {
    state = { ...state!, activities: { ...open } };
    await deps.save(state);
  };

  // Cards no Mac owns (an older build's, or a mapping lost) would never end: close them.
  const owned = new Set(Object.values(open).map((item) => item.id));
  for (const [id, card] of cards) {
    if (!owned.has(id)) await card.end("immediate").catch(() => {});
  }
  // Cards the person swiped away or iOS ended: the relay forgets their tokens.
  for (const [environmentId, item] of Object.entries(open)) {
    if (cards.has(item.id)) continue;
    const grant = state.grants[environmentId];
    if (!grant || (await tellRelay(deps, state, grant.grantId, null))) delete open[environmentId];
  }

  for (const connection of connections) {
    const grant = state.grants[connection.environmentId];
    if (!grant) continue;
    const wanted = enabled ? await macCard(deps, connection, grant.httpBaseUrl) : null;
    if (wanted === undefined) continue;
    const current = open[connection.environmentId];
    let card = current ? cards.get(current.id) : undefined;
    const staleDate = new Date(now() + STALE_AFTER_MS);
    try {
      if (wanted && wanted.activeCount > 0) {
        if (card) await card.update(wanted, staleDate);
        else {
          card = deps.start(wanted, staleDate) ?? undefined;
          if (!card) continue;
          open[connection.environmentId] = { id: card.getId(), token: null };
          await save();
        }
        await handOver(deps, connection.environmentId, card, open);
      } else if (card) {
        await card.end(wanted ? "default" : "immediate", wanted ?? undefined);
        if (await tellRelay(deps, state, grant.grantId, null)) delete open[connection.environmentId];
      }
    } catch (error) {
      log("rubato push: live activity not synced", { environmentId: connection.environmentId, error });
    }
  }
  await save();
}

/**
 * The card's token to the relay, now or when iOS hands it out. A token that comes after the sync is
 * kept against the state saved by then, not the sync's copy.
 */
async function handOver(
  deps: LiveActivityDeps,
  environmentId: string,
  card: CardHandle,
  open: Record<string, { id: string; token: string | null }>,
): Promise<void> {
  const give = async (token: string) => {
    const saved = await deps.load();
    const entry = saved?.activities?.[environmentId];
    const grant = saved?.grants[environmentId];
    if (!saved || !entry || entry.id !== card.getId() || entry.token === token || !grant) return;
    if (!(await tellRelay(deps, saved, grant.grantId, token))) return;
    open[environmentId] = { id: entry.id, token };
    await deps.save({ ...saved, activities: { ...saved.activities, [environmentId]: { id: entry.id, token } } });
  };
  const token = await card.getPushToken().catch(() => null);
  if (token) return give(token);
  if (listening.has(card.getId())) return;
  listening.add(card.getId());
  card.addPushTokenListener((event) => {
    if (event.pushToken) void give(event.pushToken);
  });
}

/** For tests: forget which cards already wait for a token. */
export function __resetLiveActivitiesForTest(): void {
  listening.clear();
}

const syncRequests = new Set<() => void>();

/**
 * The person just started work from this phone (upstream's armAgentAwarenessLiveActivityForLocalWork):
 * once the Mac has the run, the card opens. Asked twice, as a slow start reaches the Mac later.
 */
export function requestLiveActivitySync(): void {
  for (const delay of [2_500, 8_000]) {
    setTimeout(() => {
      for (const listener of syncRequests) listener();
    }, delay);
  }
}

export function onLiveActivitySyncRequest(listener: () => void): () => void {
  syncRequests.add(listener);
  return () => syncRequests.delete(listener);
}
