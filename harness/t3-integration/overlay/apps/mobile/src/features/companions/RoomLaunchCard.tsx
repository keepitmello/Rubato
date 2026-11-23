import { useGT } from "gt-react-native";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import type { RoomLaunch } from "./roomModel";
import { postRubato } from "./rubatoHttp";

export function RoomLaunchCard({ environmentId, launch }: { environmentId: EnvironmentId; launch: RoomLaunch }) {
  const gt = useGT();
  const selectDetail = useSelectWorkspaceDetail();
  const [opening, setOpening] = useState(false);
  const canOpen = launch.sessionId !== null && !launch.error;
  const status = launch.error ? gt("Couldn’t start") : opening ? gt("Opening…") :
    canOpen ? gt("Open thread") : launch.done == null ? gt("Starting…") : gt("Thread unavailable");
  async function open() {
    if (opening || !canOpen) return;
    setOpening(true);
    try {
      const { threadId } = await postRubato<{ threadId: string | null }>(
        environmentId, "/rubato/companion", "thread", { sessionId: launch.sessionId },
      );
      if (threadId) selectDetail({ name: "Thread", params: { environmentId, threadId } });
      else Alert.alert(gt("Thread isn’t ready yet"), gt("Try opening it again in a moment."));
    } catch {
      Alert.alert(gt("Couldn’t open the thread"), gt("Check the connection to your Mac and try again."));
    } finally {
      setOpening(false);
    }
  }
  return (
    <Pressable
      className="flex-row items-center gap-3 self-start rounded-2xl border border-border bg-card px-3.5 py-2.5"
      style={{ maxWidth: "85%" }}
      disabled={!canOpen || opening}
      accessibilityRole={canOpen ? "button" : undefined}
      onPress={() => void open()}
    >
      <SymbolView name="arrow.branch" tintColorClassName="text-foreground-muted" size={16} />
      <View className="shrink">
        <Text className="font-semibold text-foreground" numberOfLines={2}>{launch.title || gt("Lead thread")}</Text>
        <Text className="text-sm text-foreground-muted">{status}</Text>
      </View>
      {canOpen ? <SymbolView name="chevron.right" tintColorClassName="text-foreground-muted" size={12} /> : null}
    </Pressable>
  );
}
