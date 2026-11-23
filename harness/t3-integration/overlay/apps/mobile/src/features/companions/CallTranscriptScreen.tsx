// One call's whole transcript in an iOS sheet (route CompanionCall; medium and large detents, swipe
// down to close). The call's summary stays pinned at the top while what both sides said scrolls
// under it, each line beside its speaker.
import { useIsFocused, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { CallSummary, MeDot } from "./CallCard";
import { callApi } from "./callStore";
import type { CallLine, CallRecord } from "./callTypes";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion } from "./companionsStore";
import { copy } from "./copy";
import { useAppActive } from "../../lib/appState";
import { startRoomPoll } from "./roomPoll";
import { spokenText } from "./roomModel";

export type CompanionCallParams = {
  readonly companionId: string;
  readonly callId: string;
  readonly environmentId: string;
};

export function CallTranscriptScreen(_props: StaticScreenProps<CompanionCallParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionCallParams>>>();
  return <CallTranscript key={JSON.stringify([route.params.environmentId, route.params.companionId, route.params.callId])} {...route.params} />;
}

const lineKey = (line: CallLine, index: number) => `${line.at}:${index}`;
const separator = () => <View style={{ height: 8 }} />;

function CallTranscript({ companionId, callId, environmentId }: CompanionCallParams) {
  const insets = useSafeAreaInsets();
  const body = useScaledTextRole("body");
  const { companion } = useCompanion(companionId, environmentId);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const focused = useIsFocused();
  const active = useAppActive();
  useEffect(() => {
    if (!focused || !active) return;
    return startRoomPoll(4_000, async (signal) => {
      try {
        const found = await callApi.call(environmentId as EnvironmentId, companionId, callId, signal);
        if (signal.aborted) return;
        setCall(found);
        setFailed(found ? null : copy.callGone);
        if (found && found.status !== "ringing" && found.status !== "active") return false;
      } catch (error) {
        if (!signal.aborted) setFailed(error instanceof Error ? error.message : String(error));
      }
    });
  }, [environmentId, companionId, callId, focused, active]);
  const title = companion?.title ?? call?.title ?? companionId;
  const art = companion?.art ?? null;
  const transcript = call?.transcript;
  const lines = useMemo(() => {
    const result: CallLine[] = [];
    for (const line of transcript ?? []) {
      const text = spokenText(line.text);
      if (text) result.push(text === line.text ? line : { ...line, text });
    }
    return result;
  }, [transcript]);
  return (
    <View className="flex-1 bg-screen">
      <View className="border-b border-border px-4 pb-3 pt-5">
        {call ? <CallSummary call={call} iconSurface="card" /> : null}
      </View>
      {call === null ? (
        <View className="flex-1 items-center justify-center px-8">
          {failed ? <Text className="text-center text-[15px] text-foreground-muted">{failed}</Text> : <AppActivityIndicator />}
        </View>
      ) : (
        <FlatList
          data={lines}
          keyExtractor={lineKey}
          ItemSeparatorComponent={separator}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: insets.bottom + 24 }}
          ListEmptyComponent={
            <Text className="py-6 text-center text-[15px] text-foreground-muted">{copy.nothingSaid}</Text>
          }
          renderItem={({ item: line }) => {
            const theirs = line.who === "companion";
            return (
              <View
                className={theirs ? "flex-row items-end gap-2 self-start" : "flex-row items-end gap-2 self-end"}
                style={{ maxWidth: "88%" }}
              >
                {theirs ? <CompanionAvatar art={art} title={title} size={26} /> : null}
                <View className={theirs ? "flex-shrink rounded-[18px] bg-grouped-card px-3.5 py-2.5" : "flex-shrink rounded-[18px] bg-user-bubble px-3.5 py-2.5"}>
                  <Text selectable className={theirs ? "text-foreground" : "text-user-bubble-foreground"} style={body}>
                    {line.text}
                  </Text>
                </View>
                {theirs ? null : <MeDot size={26} />}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}
