// One call's whole transcript in an iOS sheet (route CompanionCall; medium and large detents, swipe
// down to close). The call's summary stays pinned at the top while what both sides said scrolls
// under it, each line beside its speaker.
import { useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { CallSummary, callLines, MeDot } from "./CallCard";
import { callApi } from "./callStore";
import type { CallRecord } from "./callTypes";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion } from "./companionsStore";
import { copy } from "./copy";

export type CompanionCallParams = {
  readonly companionId: string;
  readonly callId: string;
  readonly environmentId: string;
};

export function CallTranscriptScreen(_props: StaticScreenProps<CompanionCallParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionCallParams>>>();
  const { companionId, callId, environmentId } = route.params;
  const insets = useSafeAreaInsets();
  const body = useScaledTextRole("body");
  const { companion } = useCompanion(companionId, environmentId);
  const [call, setCall] = useState<CallRecord | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      callApi.calls(environmentId as EnvironmentId, companionId).then(
        (calls) => {
          if (!live) return;
          const found = calls.find((item) => item.id === callId) ?? null;
          setCall(found);
          if (!found) setFailed(copy.callGone);
        },
        (error: unknown) => {
          if (live) setFailed(error instanceof Error ? error.message : String(error));
        },
      );
    void load();
    // A live call's transcript keeps growing.
    const timer = setInterval(() => void load(), 4_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environmentId, companionId, callId]);
  const title = companion?.title ?? call?.title ?? companionId;
  const art = companion?.art ?? null;
  const lines = call ? callLines(call) : [];
  return (
    <View className="flex-1 bg-screen">
      <View className="border-b border-border px-4 pb-3 pt-5">
        {call ? <CallSummary call={call} /> : null}
      </View>
      {call === null ? (
        <View className="flex-1 items-center justify-center px-8">
          {failed ? <Text className="text-center text-[15px] text-foreground-muted">{failed}</Text> : <AppActivityIndicator />}
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: insets.bottom + 24, gap: 8 }}>
          {lines.length === 0 ? (
            <Text className="py-6 text-center text-[15px] text-foreground-muted">{copy.nothingSaid}</Text>
          ) : (
            lines.map((line, index) => {
              const theirs = line.who === "companion";
              return (
                <View
                  key={`${line.at}:${index}`}
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
            })
          )}
        </ScrollView>
      )}
    </View>
  );
}
