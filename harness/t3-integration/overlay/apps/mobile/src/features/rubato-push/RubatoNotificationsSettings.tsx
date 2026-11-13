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
import { macConnections, rubatoPushDeps } from "./deps";
import { loadPushState } from "./storage";
import { DEFAULT_PREFERENCES, setRubatoPushPreferences, type MacConnection, type PushPreferences, type PushState } from "./sync";

// Settings > Notifications in the Rubato app. Each kind (companion messages, companion calls,
// threads) is turned off on the Macs themselves, so nothing of it leaves them (sync.ts tells them).
// Whether the lock screen shows thread names, and whether companions' words also go to Telegram,
// live on each Mac too (/rubato/push/settings, /rubato/push/telegram).

type Permission = "checking" | "granted" | "ask" | "off";

interface MacStatus {
  readonly preview?: "full" | "generic";
  readonly telegram?: { readonly enabled: boolean } | null;
}

async function readPermission(): Promise<Permission> {
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted ? "granted" : permission.canAskAgain ? "ask" : "off";
}

function macRequest(connection: MacConnection, action: string, body: unknown = {}): Promise<unknown> {
  return fetch(`${connection.httpBaseUrl.replace(/\/+$/, "")}/rubato/push/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${connection.bearerToken}` },
    body: JSON.stringify(body),
  }).then((response) => (response.ok ? response.json() : null));
}

export function RubatoNotificationsSettings() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const saved = Object.values(savedConnectionsById);
  const connections = macConnections(saved);
  const [permission, setPermission] = useState<Permission>("checking");
  const [state, setState] = useState<PushState | null>(null);
  const [status, setStatus] = useState<MacStatus | null>(null);

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

  const first = connections[0];
  const firstId = first?.environmentId;
  useEffect(() => {
    if (!first) return;
    void macRequest(first, "status")
      .then((value) => setStatus((value as MacStatus | null) ?? null))
      .catch(() => setStatus(null));
    // One status read per Mac shown; the connection object changes identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId]);

  const preferences = state?.preferences ?? DEFAULT_PREFERENCES;
  const changePreference = (kind: keyof PushPreferences, on: boolean) => {
    const next = { ...preferences, [kind]: on };
    setState((current) => (current ? { ...current, preferences: next } : current));
    void setRubatoPushPreferences(rubatoPushDeps(), connections, next).then((saved) => saved && setState(saved));
  };

  const changePermission = (on: boolean) => {
    if (on && permission === "ask") {
      void Notifications.requestPermissionsAsync().then(refresh);
      return;
    }
    // iOS only turns alerts off, or back on after a refusal, in its own Settings.
    void Linking.openSettings();
  };

  const changeShowNames = (on: boolean) => {
    setStatus((current) => ({ ...current, preview: on ? "full" : "generic" }));
    void Promise.all(connections.map((connection) => macRequest(connection, "settings", { preview: on ? "full" : "generic" }).catch(() => null)));
  };

  const changeTelegram = (on: boolean) => {
    setStatus((current) => ({ ...current, telegram: { enabled: on } }));
    void Promise.all(connections.map((connection) => macRequest(connection, "telegram", { enabled: on }).catch(() => null)));
  };

  const registered = state !== null;
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
            label="Allow Notifications"
            subtitle={
              permission === "off"
                ? "Turned off in iOS Settings. Companion calls still ring."
                : "Messages and thread updates on the lock screen. Calls ring either way."
            }
            disabled={permission === "checking"}
            value={permission === "granted"}
            onValueChange={changePermission}
          />
        </SettingsSection>
        <SettingsSection title="Notify Me About">
          <SettingsSwitchRow
            icon="text.bubble"
            label="Companion Messages"
            subtitle="What a companion sends you, with its name and words."
            disabled={!registered}
            value={preferences.companionMessages}
            onValueChange={(on) => changePreference("companionMessages", on)}
          />
          <SettingsSwitchRow
            icon={{ ios: "phone", android: "smartphone" }}
            label="Companion Calls"
            subtitle="A companion calling rings this iPhone. Off: only the Mac rings."
            disabled={!registered}
            value={preferences.companionCalls}
            onValueChange={(on) => changePreference("companionCalls", on)}
          />
          <SettingsSwitchRow
            icon="checkmark.circle"
            label="Threads"
            subtitle="A thread finished, failed or needs your answer."
            disabled={!registered}
            value={preferences.threads}
            onValueChange={(on) => changePreference("threads", on)}
          />
          <SettingsSwitchRow
            icon={{ ios: "lock", android: "lock" }}
            label="Show Thread Names"
            subtitle="Off: the lock screen only says that a thread finished or needs you."
            disabled={status === null || !preferences.threads}
            value={status?.preview !== "generic"}
            onValueChange={changeShowNames}
          />
        </SettingsSection>
        {status?.telegram ? (
          <SettingsSection title="Telegram">
            <SettingsSwitchRow
              icon={{ ios: "paperplane", android: "chat" }}
              label="Send Companion Messages to Telegram"
              subtitle="Off: companions write to you only here. Messages you send them on Telegram still arrive. During a call nothing goes to Telegram."
              value={status.telegram.enabled}
              onValueChange={changeTelegram}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection title="Macs">
          {saved.length === 0 ? (
            <SettingsRow icon="desktopcomputer" label="No Mac paired yet" />
          ) : (
            saved.map((connection) => (
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
