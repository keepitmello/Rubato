import Constants from "expo-constants";
import * as Device from "expo-device";

import { resolveApsEnvironment } from "../agent-awareness/registrationPayload";
import { RUBATO_PUSH_RELAY } from "./config";
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

/** The saved Macs this phone reaches with its own session token (T3's cloud-managed ones are gone). */
export function macConnections(
  connections: ReadonlyArray<{ environmentId: string; httpBaseUrl: string; bearerToken: string | null; authenticationMethod?: string }>,
): MacConnection[] {
  return connections.flatMap((connection) =>
    connection.bearerToken && connection.authenticationMethod !== "dpop"
      ? [{ environmentId: connection.environmentId, httpBaseUrl: connection.httpBaseUrl, bearerToken: connection.bearerToken }]
      : [],
  );
}
