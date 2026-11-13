// A call in a companion's room (user 0d108939; Pickle's call card is the reference): one compact card
// for how it went with the last words as a preview. Tapping it opens the whole transcript in a sheet
// (CallTranscriptScreen; user decision 534dda27: no inline expand). The words come from the Mac's call
// log, which hears the person and the companion alike.
import { CommonActions, useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { CallRecord } from "./callTypes";
import { CompanionAvatar } from "./CompanionAvatar";
import { copy, phoneLocale } from "./copy";
import { callHeadline, spokenText } from "./roomModel";

export const clock = new Intl.DateTimeFormat(phoneLocale(), { hour: "numeric", minute: "2-digit" });
export const MISSED_RED = "#FF3B30";

export function callIcon(call: CallRecord): string {
  if (call.status === "missed") return "phone.arrow.down.left";
  if (call.status === "declined") return "phone.down.fill";
  if (call.status === "active" || call.status === "ringing") return "phone.fill";
  return call.direction === "incoming" ? "phone.arrow.down.left" : "phone.arrow.up.right";
}

/** What both sides said, without voice directions; empty lines go. */
export function callLines(call: CallRecord) {
  return call.transcript.map((line) => ({ ...line, text: spokenText(line.text) })).filter((line) => line.text);
}

/** A call's length that keeps moving while it is live. */
export function useCallHeadline(call: CallRecord) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call.status !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.status]);
  return callHeadline(call, now);
}

/** The call's icon, headline, direction and time, and its length: the card's and the sheet's top. */
export function CallSummary(props: { readonly call: CallRecord }) {
  const { call } = props;
  const headline = useCallHeadline(call);
  const missed = call.status === "missed" || call.status === "declined";
  return (
    <View className="flex-row items-center gap-3">
      <View className="h-11 w-11 items-center justify-center rounded-[14px] bg-screen">
        <SymbolView
          name={{ ios: callIcon(call) as never, android: "smartphone" }}
          size={18}
          {...(missed ? { tintColor: MISSED_RED } : { tintColorClassName: "accent-foreground" })}
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-t3-bold text-[16px] text-foreground" style={missed ? { color: MISSED_RED } : undefined}>
          {copy[headline.key]}
        </Text>
        <Text numberOfLines={1} className="mt-0.5 text-[13px] text-foreground-muted">
          {call.direction === "incoming" ? copy.incoming : copy.outgoing} · {clock.format(call.createdAt)}
        </Text>
      </View>
      {headline.length ? (
        <View className="flex-row items-center gap-1">
          <SymbolView name={{ ios: "waveform", android: "smartphone" }} size={13} tintColorClassName="accent-primary" />
          <Text className="text-[15px] text-primary" style={{ fontVariant: ["tabular-nums"] }}>
            {headline.length}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function CallCard(props: {
  readonly call: CallRecord;
  readonly title: string;
  readonly art: string | null;
  readonly environmentId: string;
}) {
  const { call } = props;
  const navigation = useNavigation();
  const preview = callLines(call).slice(-2);
  const open = () =>
    navigation.dispatch(
      CommonActions.navigate("CompanionCall", {
        companionId: call.companion,
        callId: call.id,
        environmentId: props.environmentId,
      }),
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={copy.openTranscript}
      onPress={open}
      className="self-start rounded-[22px] bg-grouped-card px-2 py-2 active:opacity-80"
      style={{ width: "86%" }}
    >
      <View className="pl-0.5 pr-1.5">
        <CallSummary call={call} />
      </View>
      {preview.length > 0 ? (
        <View className="mt-2 gap-1 rounded-[16px] bg-screen px-3 py-2.5">
          {preview.map((line, index) => (
            <View key={`${line.at}:${index}`} className="flex-row items-center gap-2">
              {line.who === "companion" ? (
                <CompanionAvatar art={props.art} title={props.title} size={18} />
              ) : (
                <MeDot size={18} />
              )}
              <Text numberOfLines={1} className="min-w-0 flex-1 text-[14px] text-foreground-muted">
                {line.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** The person's small face in a transcript: the system's person glyph in the bubble color. */
export function MeDot(props: { readonly size?: number }) {
  const size = props.size ?? 22;
  return (
    <View className="items-center justify-center rounded-full bg-user-bubble" style={{ width: size, height: size }}>
      <SymbolView name={{ ios: "person.fill", android: "smartphone" }} size={size / 2} tintColorClassName="accent-user-bubble-foreground" />
    </View>
  );
}
