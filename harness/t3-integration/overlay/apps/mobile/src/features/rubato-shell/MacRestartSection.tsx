// Rubato: Settings › Environments › selected Mac — restart that Mac's Rubato from the phone
// (macRestart.ts). Asks first, then follows the job through the Mac's absence to its result.
import { AuthEnvironmentMaintainScope, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentScope } from "../../state/session";
import { isRubatoRequestError, postRubato } from "../companions/rubatoHttp";
import { SettingsSection } from "../settings/components/SettingsSection";
import { describeMacRestart, macRestartLine, type MacRestartStatus } from "./macRestart";

const APP_ROUTE = "/rubato/app";
const POLL_MS = 3_000;

export function MacRestartSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly supported: boolean;
}) {
  const gt = useGT();
  const canMaintain = useEnvironmentScope(props.environmentId, AuthEnvironmentMaintainScope);
  const canRestart = props.supported && props.connected && canMaintain;
  const [job, setJob] = useState<{ token: string; startedAt: number } | null>(null);
  const [view, setView] = useState<ReturnType<typeof describeMacRestart>>({ phase: "idle" });
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const settled = view.phase === "idle" || view.phase === "succeeded" ||
    view.phase === "failed" || view.phase === "unconfirmed";

  // While a restart runs, ask the Mac again; no answer means it is between processes.
  useEffect(() => {
    if (job === null || settled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      const next = await postRubato<MacRestartStatus>(
        props.environmentId,
        APP_ROUTE,
        "restart-status",
        {},
        { timeoutMs: 5_000, signal: controller.signal },
      ).catch(() => null);
      if (stopped) return;
      setView(describeMacRestart(job.token, next, Date.now() - job.startedAt));
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [props.environmentId, job, settled]);

  function start() {
    Alert.alert(
      gt("Restart Rubato on {mac}?", { mac: props.label }),
      gt("Rubato waits for running work to finish before reopening on your Mac."),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Restart"),
          onPress: () => {
            setStarting(true);
            postRubato<{ token: string }>(props.environmentId, APP_ROUTE, "restart-app")
              .then((answer) => {
                if (!mounted.current) return;
                if (!answer?.token) throw new Error("Missing restart token");
                setView({ phase: "building" });
                setJob({ token: answer.token, startedAt: Date.now() });
              })
              .catch((error: unknown) => {
                if (!mounted.current) return;
                const message = !isRubatoRequestError(error)
                  ? gt("The Mac did not take the restart.")
                  : error.status === 404
                    ? gt("Update Rubato on this Mac to restart it from the phone.")
                    : error.message;
                Alert.alert(
                  gt("Could not restart"),
                  message,
                );
              })
              .finally(() => mounted.current && setStarting(false));
          },
        },
      ],
    );
  }

  function restartNow() {
    Alert.alert(gt("Restart now?"), gt("Work still running on the Mac will be interrupted."), [
      { text: gt("Keep waiting"), style: "cancel" },
      {
        text: gt("Restart now"),
        style: "destructive",
        onPress: () =>
          void postRubato(props.environmentId, APP_ROUTE, "restart-now").catch((error: unknown) => {
            if (mounted.current)
              Alert.alert(gt("Could not restart now"), error instanceof Error ? error.message : String(error));
          }),
      },
    ]);
  }

  // Keep a requested restart visible while the connection (and its config) is down.
  if (!props.supported && job === null && !starting) return null;
  const line = macRestartLine(view);
  const description = !settled
    ? null
    : !props.connected
      ? gt("Connect to this Mac to restart Rubato.")
      : !canMaintain
        ? gt("This connection does not have permission to restart Rubato.")
        : null;
  return (
    <SettingsSection
      title="Rubato"
      footer={gt("This phone reconnects automatically when Rubato is back on your Mac.")}
    >
      <View>
        <ListActionRow
          icon="arrow.clockwise"
          label={gt("Restart Rubato")}
          {...(description === null ? {} : { description })}
          loading={starting || !settled}
          disabled={!canRestart || starting || !settled}
          onPress={start}
        />
        {canRestart && view.phase === "draining" && !view.now ? (
          <ListActionRow icon="bolt.circle" label={gt("Restart now")} tone="danger" onPress={restartNow} />
        ) : null}
        {line ? (
          <Text className="px-4 pb-3 text-sm text-foreground-muted" selectable={view.phase === "failed"}>
            {line}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
