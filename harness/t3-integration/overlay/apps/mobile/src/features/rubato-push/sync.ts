// The phone's side of Rubato push (harness/push-relay). The phone is the only party that knows its
// APNs and VoIP tokens: it registers them at the relay and, for each Mac it is paired with, mints a
// grant there and hands it to that Mac. A Mac with no grant from this phone cannot push to it; an
// unpaired Mac's grant is revoked here.
//
//   phone ── tokens ─────────▶ relay   POST/PUT /v1/devices
//   phone ── mint grant ─────▶ relay   POST /v1/devices/:id/grants
//   phone ── grant ──────────▶ Mac     POST /rubato/push/register (the paired bearer session)
//   phone ── revoke ─────────▶ relay   DELETE /v1/devices/:id/grants/:grantId

export type ApsEnvironment = "sandbox" | "production";

/** What the phone wants to hear about; each paired Mac sends nothing of a kind turned off. */
export interface PushPreferences {
  readonly threads: boolean;
  readonly companionMessages: boolean;
  readonly companionCalls: boolean;
}

export const DEFAULT_PREFERENCES: PushPreferences = { threads: true, companionMessages: true, companionCalls: true };

export interface PushGrant {
  readonly grantId: string;
  readonly httpBaseUrl: string;
  /** The choices this Mac last took. */
  readonly preferences?: PushPreferences;
}

export interface PushState {
  readonly relay: string;
  readonly bundleId: string;
  readonly environment: ApsEnvironment;
  readonly deviceId: string;
  readonly deviceSecret: string;
  readonly apnsToken: string | null;
  readonly voipToken: string | null;
  /** By the Mac's environment id. */
  readonly grants: Readonly<Record<string, PushGrant>>;
  readonly preferences?: PushPreferences;
}

export interface MacConnection {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

export interface PushSyncDeps {
  readonly relay: string;
  readonly bundleId: string;
  readonly environment: ApsEnvironment;
  /** How this phone is named on a Mac's list of paired phones. */
  readonly deviceLabel: string;
  readonly fetch: typeof fetch;
  readonly load: () => Promise<PushState | null>;
  readonly save: (state: PushState | null) => Promise<void>;
  readonly log?: (message: string, detail?: unknown) => void;
}

export interface PushSyncInput {
  readonly apnsToken: string | null;
  readonly voipToken: string | null;
  readonly connections: ReadonlyArray<MacConnection>;
}

class RelayRefused extends Error {
  constructor(readonly status: number) {
    super(`relay answered ${status}`);
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

async function call<T>(
  deps: PushSyncDeps,
  url: string,
  method: string,
  { bearer, body }: { bearer?: string; body?: unknown } = {},
): Promise<T> {
  const response = await deps.fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new RelayRefused(response.status);
  return (await response.json().catch(() => ({}))) as T;
}

async function registerDevice(deps: PushSyncDeps, input: PushSyncInput): Promise<PushState> {
  const created = await call<{ deviceId: string; deviceSecret: string }>(deps, `${deps.relay}/v1/devices`, "POST", {
    body: {
      bundleId: deps.bundleId,
      environment: deps.environment,
      ...(input.apnsToken ? { apnsToken: input.apnsToken } : {}),
      ...(input.voipToken ? { voipToken: input.voipToken } : {}),
    },
  });
  return {
    relay: deps.relay,
    bundleId: deps.bundleId,
    environment: deps.environment,
    deviceId: created.deviceId,
    deviceSecret: created.deviceSecret,
    apnsToken: input.apnsToken,
    voipToken: input.voipToken,
    grants: {},
  };
}

/** Brings the relay and every paired Mac in line with this phone's tokens and connections. */
export async function syncRubatoPush(deps: PushSyncDeps, input: PushSyncInput): Promise<PushState | null> {
  const log = deps.log ?? (() => {});
  if (!input.apnsToken && !input.voipToken) return deps.load();
  let state = await deps.load();
  const relayDevice = (path = "") => `${deps.relay}/v1/devices/${encodeURIComponent(state!.deviceId)}${path}`;

  // A different relay, app or APNs environment is a different registration.
  if (state && (state.relay !== deps.relay || state.bundleId !== deps.bundleId || state.environment !== deps.environment)) {
    const old = state;
    await call(deps, `${old.relay}/v1/devices/${encodeURIComponent(old.deviceId)}`, "DELETE", { bearer: old.deviceSecret }).catch(() => {});
    state = null;
  }
  if (state && (state.apnsToken !== input.apnsToken || state.voipToken !== input.voipToken)) {
    try {
      await call(deps, relayDevice(), "PUT", {
        bearer: state.deviceSecret,
        body: { apnsToken: input.apnsToken, voipToken: input.voipToken },
      });
      state = { ...state, apnsToken: input.apnsToken, voipToken: input.voipToken };
      await deps.save(state);
    } catch (error) {
      // The relay no longer knows this phone: start over, and every Mac gets a fresh grant.
      if (!(error instanceof RelayRefused && error.status === 401)) throw error;
      state = null;
    }
  }
  if (!state) {
    state = await registerDevice(deps, input);
    await deps.save(state);
  }

  const wanted = new Map(input.connections.map((connection) => [connection.environmentId, connection]));
  let grants: Record<string, PushGrant> = { ...state.grants };

  // Unpaired Macs lose their grant.
  for (const [environmentId, grant] of Object.entries(grants)) {
    const connection = wanted.get(environmentId);
    if (connection && trimSlash(connection.httpBaseUrl) === grant.httpBaseUrl) continue;
    try {
      await call(deps, relayDevice(`/grants/${encodeURIComponent(grant.grantId)}`), "DELETE", { bearer: state.deviceSecret });
      delete grants[environmentId];
      state = { ...state, grants };
      await deps.save(state);
    } catch (error) {
      log("rubato push: grant not revoked yet", error);
    }
  }

  // Newly paired Macs get one.
  for (const connection of wanted.values()) {
    if (grants[connection.environmentId]) continue;
    const httpBaseUrl = trimSlash(connection.httpBaseUrl);
    let minted: { grantId: string; grant: string } | null = null;
    try {
      minted = await call<{ grantId: string; grant: string }>(deps, relayDevice("/grants"), "POST", {
        bearer: state.deviceSecret,
        body: { label: new URL(httpBaseUrl).host },
      });
      await call(deps, `${httpBaseUrl}/rubato/push/register`, "POST", {
        bearer: connection.bearerToken,
        body: {
          relay: deps.relay,
          grant: minted.grant,
          grantId: minted.grantId,
          deviceId: state.deviceId,
          label: deps.deviceLabel,
          preferences: state.preferences ?? DEFAULT_PREFERENCES,
        },
      });
      grants = { ...grants, [connection.environmentId]: { grantId: minted.grantId, httpBaseUrl, preferences: state.preferences ?? DEFAULT_PREFERENCES } };
      state = { ...state, grants };
      await deps.save(state);
    } catch (error) {
      // The Mac is unreachable or too old for push: leave no grant behind; the next sync tries again.
      if (minted) {
        await call(deps, relayDevice(`/grants/${encodeURIComponent(minted.grantId)}`), "DELETE", { bearer: state.deviceSecret }).catch(() => {});
      }
      log("rubato push: Mac not paired for push yet", { environmentId: connection.environmentId, error });
    }
  }
  return tellPreferences(deps, state, input.connections);
}

const samePreferences = (a: PushPreferences | undefined, b: PushPreferences) =>
  !!a && a.threads === b.threads && a.companionMessages === b.companionMessages && a.companionCalls === b.companionCalls;

/** Every paired Mac that has not taken the phone's current choices hears them (POST /rubato/push/preferences). */
async function tellPreferences(deps: PushSyncDeps, start: PushState, connections: ReadonlyArray<MacConnection>): Promise<PushState> {
  let state = start;
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;
  for (const connection of connections) {
    const grant = state.grants[connection.environmentId];
    if (!grant || samePreferences(grant.preferences, preferences)) continue;
    try {
      await call(deps, `${grant.httpBaseUrl}/rubato/push/preferences`, "POST", {
        bearer: connection.bearerToken,
        body: { deviceId: state.deviceId, preferences },
      });
      state = { ...state, grants: { ...state.grants, [connection.environmentId]: { ...grant, preferences } } };
      await deps.save(state);
    } catch (error) {
      (deps.log ?? (() => {}))("rubato push: Mac has not taken the new choices yet", error);
    }
  }
  return state;
}

/** The phone's choices: kept here, and told to every paired Mac now or on a later sync. */
export async function setRubatoPushPreferences(
  deps: PushSyncDeps,
  connections: ReadonlyArray<MacConnection>,
  preferences: PushPreferences,
): Promise<PushState | null> {
  const state = await deps.load();
  if (!state) return null;
  const next = { ...state, preferences };
  await deps.save(next);
  return tellPreferences(deps, next, connections);
}


