// Rubato: Settings › About › "Rubato on your Mac" — restart the Mac's Rubato from the phone
// (macRestart.ts). Asks first, then follows the job through the Mac's absence to its result.
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { postRubato, RubatoRequestError } from "../companions/rubatoHttp";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { describeMacRestart, macRestartLine, type MacRestartStatus } from "./macRestart";

const APP_ROUTE = "/rubato/app";
const POLL_MS = 3_000;

export function MacRestartSection() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const macs = Object.values(savedConnectionsById);
  if (macs.length === 0) return null;
  return (
    <SettingsSection
      title="Rubato on your Mac"
      footer="Rebuilds and reopens Rubato on the Mac, like Restart in the Mac's Settings › About. This phone reconnects by itself."
    >
      {macs.map((mac) => (
        <MacRestartRow
          key={mac.environmentId}
          environmentId={mac.environmentId}
          label={mac.environmentLabel}
          many={macs.length > 1}
        />
      ))}
    </SettingsSection>
  );
}

function MacRestartRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly many: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<MacRestartStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const view = describeMacRestart(token, status);
  const settled = view.phase === "idle" || view.phase === "succeeded" || view.phase === "failed";

  // While a restart runs, ask the Mac again; no answer means it is between processes.
  useEffect(() => {
    if (token === null || settled) return;
    const poll = () =>
      postRubato<MacRestartStatus>(props.environmentId, APP_ROUTE, "restart-status", {}, { timeoutMs: 5_000 })
        .then((next) => mounted.current && setStatus(next))
        .catch(() => mounted.current && setStatus(null));
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [props.environmentId, token, settled]);

  const start = useCallback(() => {
    Alert.alert(
      `Restart Rubato on ${props.label}?`,
      "It rebuilds and reopens Rubato on the Mac. Conversations that are working are waited for unless you choose Restart now.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restart",
          onPress: () => {
            setStarting(true);
            postRubato<{ token: string }>(props.environmentId, APP_ROUTE, "restart")
              .then((answer) => {
                setStatus(null);
                setToken(answer.token);
              })
              .catch((error: unknown) =>
                Alert.alert(
                  "Could not restart",
                  error instanceof RubatoRequestError ? error.message : "The Mac did not take the restart.",
                ),
              )
              .finally(() => mounted.current && setStarting(false));
          },
        },
      ],
    );
  }, [props.environmentId, props.label]);

  const restartNow = useCallback(() => {
    Alert.alert("Restart now?", "Work still running on the Mac is cut off.", [
      { text: "Keep waiting", style: "cancel" },
      {
        text: "Restart now",
        style: "destructive",
        onPress: () =>
          void postRubato(props.environmentId, APP_ROUTE, "restart-now").catch((error: unknown) =>
            Alert.alert("Could not restart now", error instanceof Error ? error.message : String(error)),
          ),
      },
    ]);
  }, [props.environmentId]);

  const line = macRestartLine(view);
  return (
    <View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label={props.many ? `Restart Rubato on ${props.label}` : "Restart Rubato"}
        loading={starting || !settled}
        disabled={starting || !settled}
        onPress={start}
      />
      {view.phase === "draining" && !view.now ? (
        <SettingsActionRow icon="bolt.circle" label="Restart now" tone="danger" onPress={restartNow} />
      ) : null}
      {line ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted" selectable={view.phase === "failed"}>
          {line}
        </Text>
      ) : null}
    </View>
  );
}
