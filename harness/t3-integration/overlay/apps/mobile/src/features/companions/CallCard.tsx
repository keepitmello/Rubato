// A call in a companion's room (user 0d108939, in the style of Pickle's call card): one card for how
// it went, opened in place to read what both sides said. The words come from the Mac's call log,
// which hears the person and the companion alike.
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { CallRecord } from "./callTypes";
import { CompanionAvatar } from "./CompanionAvatar";
import { copy, phoneLocale } from "./copy";
import { callHeadline, spokenText } from "./roomModel";

const clock = new Intl.DateTimeFormat(phoneLocale(), { hour: "numeric", minute: "2-digit" });

function iconOf(call: CallRecord) {
  if (call.status === "missed") return { ios: "phone.arrow.down.left", android: "smartphone" } as const;
  if (call.status === "declined") return { ios: "phone.down", android: "smartphone" } as const;
  if (call.status === "active" || call.status === "ringing") return { ios: "phone.fill", android: "smartphone" } as const;
  return call.direction === "incoming"
    ? ({ ios: "phone.arrow.down.left", android: "smartphone" } as const)
    : ({ ios: "phone.arrow.up.right", android: "smartphone" } as const);
}

export function CallCard(props: { readonly call: CallRecord; readonly title: string; readonly art: string | null }) {
  const { call } = props;
  const [open, setOpen] = useState(false);
  // A live call keeps its length moving.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call.status !== "active") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [call.status]);
  const headline = callHeadline(call, now);
  const missed = call.status === "missed" || call.status === "declined";
  const lines = call.transcript.map((line) => ({ ...line, text: spokenText(line.text) })).filter((line) => line.text);
  const who = call.direction === "incoming" ? copy.incoming : copy.outgoing;
  return (
    <View className="mr-10 self-start rounded-[22px] bg-grouped-card p-2" style={{ maxWidth: "88%", minWidth: "72%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="flex-row items-center gap-3 rounded-[16px] px-2 py-1.5 active:opacity-70"
      >
        <View className="h-11 w-11 items-center justify-center rounded-[13px] bg-screen">
          <SymbolView name={iconOf(call)} size={19} {...(missed ? { tintColor: "#E5484D" } : { tintColorClassName: "accent-foreground" })} />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className={missed ? "font-t3-bold text-[16px] text-[#E5484D]" : "font-t3-bold text-[16px] text-foreground"}>
            {copy[headline.key]}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 text-[13px] text-foreground-muted">
            {who} · {clock.format(call.createdAt)}
          </Text>
        </View>
        {headline.length ? (
          <View className="flex-row items-center gap-1">
            <SymbolView name={{ ios: "waveform", android: "smartphone" }} size={14} tintColor="#3B8BF6" />
            <Text className="text-[16px] text-[#3B8BF6]">{headline.length}</Text>
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <View className="mt-2 gap-2 rounded-[18px] bg-screen px-3 py-3">
          {lines.length === 0 ? (
            <Text className="py-1 text-center text-[13px] text-foreground-muted">{copy.nothingSaid}</Text>
          ) : (
            lines.map((line, index) =>
              line.who === "companion" ? (
                <View key={`${line.at}:${index}`} className="flex-row items-end gap-1.5 self-start" style={{ maxWidth: "86%" }}>
                  <CompanionAvatar art={props.art} title={props.title} size={22} />
                  <View className="flex-row gap-1.5 rounded-[14px] bg-grouped-card px-3 py-2">
                    <SymbolView name={{ ios: "waveform", android: "smartphone" }} size={11} className="mt-1" tintColorClassName="accent-foreground-muted" />
                    <Text className="flex-shrink text-[14px] leading-[19px] text-foreground">{line.text}</Text>
                  </View>
                </View>
              ) : (
                <View
                  key={`${line.at}:${index}`}
                  className="flex-row gap-1.5 self-end rounded-[14px] bg-[#7BE383]/35 px-3 py-2"
                  style={{ maxWidth: "80%" }}
                >
                  <SymbolView name={{ ios: "waveform", android: "smartphone" }} size={11} className="mt-1" tintColorClassName="accent-foreground-muted" />
                  <Text className="flex-shrink text-[14px] leading-[19px] text-foreground">{line.text}</Text>
                </View>
              ),
            )
          )}
        </View>
      ) : null}
    </View>
  );
}
