import { useEffect, useMemo, useRef } from "react";
import { AppState, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import * as Notifications from "expo-notifications";

import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { liveActivityDeps, liveActivitySupported, macConnections, rubatoPushDeps } from "./deps";
import { onLiveActivitySyncRequest, syncLiveActivities } from "./liveActivity";
import { librarySounds } from "./soundFolder";
import { syncNotificationSounds } from "./sounds";
import { syncRubatoPush, type MacConnection } from "./sync";
import { createPushSyncQueue, foregroundPushRefresh } from "./syncQueue";

// Mounted once in App.tsx. Keeps the relay and every paired Mac in line with this phone's push
// tokens (sync.ts): at start, when a Mac is paired or removed, when iOS hands out a new token,
// and each time the app comes to the front. Then the chimes the Macs ring with (sounds.ts), and,
// while the app is in front, each Mac's Live Activity card (liveActivity.ts).

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
  const resume = useMemo(() => foregroundPushRefresh(AppState.currentState ?? null), []);
  const sync = useMemo(() => createPushSyncQueue(async () => {
    try {
      await syncRubatoPush(rubatoPushDeps(), {
        apnsToken: tokens.current.apns,
        voipToken: tokens.current.voip,
        connections: connections.current,
      });
    } catch (error) {
      console.warn("rubato push: sync failed", error);
    }
    await syncNotificationSounds({ folder: librarySounds(), fetch: globalThis.fetch }, connections.current).catch(() => {});
  }, async () => {
    if (AppState.currentState !== "active") resume.missedCard();
    else if (liveActivitySupported()) {
      await syncLiveActivities(liveActivityDeps(), connections.current).catch((error: unknown) =>
        console.warn("rubato push: live activity sync failed", error),
      );
    }
  }), [resume]);

  useEffect(() => {
    connections.current = macConnections(Object.values(savedConnectionsById));
    if (Platform.OS === "ios") void sync("full");
  }, [savedConnectionsById, sync]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let live = true;
    void Promise.all([alertToken().catch(() => null), voipToken().catch(() => null)]).then(([apns, voip]) => {
      if (!live) return;
      tokens.current = { apns, voip };
      void sync("full");
    });
    const apnsChanged = Notifications.addPushTokenListener((token) => {
      tokens.current = { ...tokens.current, apns: typeof token.data === "string" ? token.data : null };
      void sync("full");
    });
    const voipChanged = rubatoCall?.addListener("voipToken", (event) => {
      tokens.current = { ...tokens.current, voip: event.token ?? null };
      void sync("full");
    });
    const foreground = AppState.addEventListener("change", (next) => {
      const scope = resume.change(next);
      if (scope) void sync(scope);
    });
    const workStarted = onLiveActivitySyncRequest(() => { void sync("card"); });
    return () => {
      live = false;
      workStarted();
      apnsChanged.remove();
      voipChanged?.remove();
      foreground.remove();
    };
  }, [sync, resume]);

  return null;
}
