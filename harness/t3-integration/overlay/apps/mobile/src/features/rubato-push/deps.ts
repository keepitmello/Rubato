import Constants from "expo-constants";
import * as Device from "expo-device";

import { getAgentLiveActivities, startAgentLiveActivity } from "../agent-awareness/agentLiveActivity";
import { savedMacHeaders } from "../companions/rubatoHttp";
import { resolveApsEnvironment } from "../agent-awareness/registrationPayload";
import { RUBATO_PUSH_RELAY } from "./config";
import type { LiveActivityDeps } from "./liveActivity";
import { loadPushState, savePushState } from "./storage";
import type { MacConnection, PushSyncDeps } from "./sync";

/** This app's relay registration: which relay, app and APNs environment, and where the state is kept. */
export function rubatoPushDeps(): PushSyncDeps {
  return {
    relay: RUBATO_PUSH_RELAY,
    bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? "com.keepitmello.rubato",
    environment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
    deviceLabel: Device.deviceName ?? Device.modelName ?? "iPhone",
    fetch: globalThis.fetch,
    load: loadPushState,
    save: savePushState,
    log: (message, detail) => console.warn(message, detail),
  };
}

/** Whether this binary carries the card's widget extension (shell-edits.mjs, RUBATO_WIDGETS). */
export function liveActivitySupported(): boolean {
  return Constants.expoConfig?.extra?.rubatoLiveActivity === true;
}

/** The Live Activity cards of upstream's AgentActivity widget, on top of the relay registration. */
export function liveActivityDeps(): LiveActivityDeps {
  return {
    ...rubatoPushDeps(),
    cards: () => getAgentLiveActivities(),
    start: (props, staleDate) => startAgentLiveActivity(props, staleDate),
  };
}

/**
 * The saved Macs this phone pairs with directly (T3's cloud-managed ones are gone), each request
 * authorized with that pairing's credentials: a bearer, or a DPoP-bound token (savedMacHeaders).
 */
export function macConnections(
  connections: ReadonlyArray<{ environmentId: string; httpBaseUrl: string; bearerToken: string | null }>,
): MacConnection[] {
  return connections.map((connection) => ({
    environmentId: connection.environmentId,
    httpBaseUrl: connection.httpBaseUrl,
    authorize: (method, url) => savedMacHeaders(connection, method, url),
  }));
}
