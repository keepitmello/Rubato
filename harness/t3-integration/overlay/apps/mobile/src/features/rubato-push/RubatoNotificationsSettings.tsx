import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { loadPushState } from "./storage";
import type { PushState } from "./sync";

// Settings > Notifications in the Rubato app: whether iOS lets alerts through, which Macs can
// notify this phone (RubatoPushHost pairs them by itself), and whether the lock screen may show
// thread names. That last choice lives on each Mac (/rubato/push/settings), which writes the alert.

type Permission = "checking" | "granted" | "ask" | "off";

async function readPermission(): Promise<Permission> {
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted ? "granted" : permission.canAskAgain ? "ask" : "off";
}

export function RubatoNotificationsSettings() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById).filter(
    (connection) => connection.bearerToken && connection.authenticationMethod !== "dpop",
  );
  const [permission, setPermission] = useState<Permission>("checking");
  const [state, setState] = useState<PushState | null>(null);
  const [showNames, setShowNames] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    void readPermission().then(setPermission, () => setPermission("off"));
    void loadPushState().then(setState, () => setState(null));
  }, []);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const macRequest = useCallback(
    (connection: (typeof connections)[number], action: string, body: unknown = {}) =>
      fetch(`${connection.httpBaseUrl.replace(/\/+$/, "")}/rubato/push/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.bearerToken}` },
        body: JSON.stringify(body),
      }).then((response) => (response.ok ? response.json() : null)),
    [],
  );

  const first = connections[0];
  useEffect(() => {
    if (!first) return;
    void macRequest(first, "status")
      .then((status: { preview?: string } | null) => setShowNames(status ? status.preview !== "generic" : null))
      .catch(() => setShowNames(null));
  }, [first, macRequest]);

  const changePermission = (on: boolean) => {
    if (on && permission === "ask") {
      void Notifications.requestPermissionsAsync().then(refresh);
      return;
    }
    // iOS only turns alerts off, or back on after a refusal, in its own Settings.
    void Linking.openSettings();
  };

  const changeShowNames = (on: boolean) => {
    setShowNames(on);
    void Promise.all(connections.map((connection) => macRequest(connection, "settings", { preview: on ? "full" : "generic" }).catch(() => null)));
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="This iPhone">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Notifications"
            subtitle={
              permission === "off"
                ? "Turned off in iOS Settings. Companion calls still ring."
                : "When a thread needs you or finishes. Companion calls ring either way."
            }
            disabled={permission === "checking"}
            value={permission === "granted"}
            onValueChange={changePermission}
          />
          <SettingsSwitchRow
            icon={{ ios: "lock", android: "lock" }}
            label="Show thread names"
            subtitle="Off: the lock screen says only that a thread finished or needs you."
            disabled={showNames === null}
            value={showNames ?? true}
            onValueChange={changeShowNames}
          />
        </SettingsSection>
        <SettingsSection title="Macs">
          {connections.length === 0 ? (
            <SettingsRow icon="desktopcomputer" label="No Mac paired yet" />
          ) : (
            connections.map((connection) => (
              <SettingsRow
                key={connection.environmentId}
                icon="desktopcomputer"
                label={connection.environmentLabel}
                value={state?.grants[connection.environmentId] ? "Can notify" : "Connecting…"}
              />
            ))
          )}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
