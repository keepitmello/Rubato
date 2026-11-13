import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { resolveApsEnvironment } from "../agent-awareness/registrationPayload";
import { RUBATO_PUSH_RELAY } from "./config";
import { loadPushState as load, savePushState as save } from "./storage";
import { syncRubatoPush, type MacConnection } from "./sync";

// Mounted once in App.tsx. Keeps the relay and every paired Mac in line with this phone's push
// tokens (sync.ts): at start, when a Mac is paired or removed, when iOS hands out a new token,
// and each time the app comes to the front.

/** companion-ui's CallKit module (modules/rubato-call): the PushKit VoIP token and its changes. */
interface RubatoCallModule {
  getVoipToken(): string | null | Promise<string | null>;
  addListener(event: "voipToken", listener: (event: { token?: string | null }) => void): { remove(): void };
}
const rubatoCall = requireOptionalNativeModule<RubatoCallModule>("RubatoCall");

async function alertToken(): Promise<string | null> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) await Notifications.requestPermissionsAsync();
  // iOS hands out the token even without alert permission; a ring needs no permission at all.
  const token = await Notifications.getDevicePushTokenAsync();
  return typeof token.data === "string" ? token.data : null;
}

async function voipToken(): Promise<string | null> {
  return (await rubatoCall?.getVoipToken()) ?? null;
}

export function RubatoPushHost(): null {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = useRef<ReadonlyArray<MacConnection>>([]);
  const tokens = useRef<{ apns: string | null; voip: string | null }>({ apns: null, voip: null });
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const sync = useRef(() => {
    if (Platform.OS !== "ios") return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = (async () => {
      do {
        again.current = false;
        try {
          await syncRubatoPush(
            {
              relay: RUBATO_PUSH_RELAY,
              bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? "com.keepitmello.rubato",
              environment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
              deviceLabel: Device.deviceName ?? Device.modelName ?? "iPhone",
              fetch: globalThis.fetch,
              load,
              save,
              log: (message, detail) => console.warn(message, detail),
            },
            { apnsToken: tokens.current.apns, voipToken: tokens.current.voip, connections: connections.current },
          );
        } catch (error) {
          console.warn("rubato push: sync failed", error);
        }
      } while (again.current);
      running.current = null;
    })();
  }).current;

  useEffect(() => {
    connections.current = Object.values(savedConnectionsById).flatMap((connection) =>
      connection.bearerToken && connection.authenticationMethod !== "dpop"
        ? [{ environmentId: connection.environmentId, httpBaseUrl: connection.httpBaseUrl, bearerToken: connection.bearerToken }]
        : [],
    );
    sync();
  }, [savedConnectionsById, sync]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let live = true;
    void Promise.all([alertToken().catch(() => null), voipToken().catch(() => null)]).then(([apns, voip]) => {
      if (!live) return;
      tokens.current = { apns, voip };
      sync();
    });
    const apnsChanged = Notifications.addPushTokenListener((token) => {
      tokens.current = { ...tokens.current, apns: typeof token.data === "string" ? token.data : null };
      sync();
    });
    const voipChanged = rubatoCall?.addListener("voipToken", (event) => {
      tokens.current = { ...tokens.current, voip: event.token ?? null };
      sync();
    });
    const foreground = AppState.addEventListener("change", (next) => {
      if (next === "active") sync();
    });
    return () => {
      live = false;
      apnsChanged.remove();
      voipChanged?.remove();
      foreground.remove();
    };
  }, [sync]);

  return null;
}
