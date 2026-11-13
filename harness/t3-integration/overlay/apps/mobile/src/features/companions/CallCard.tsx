// A call in a companion's room (user 0d108939; Pickle's call card is the reference): one card for how
// it went, opened in place to read what both sides said, each line beside its speaker. The words come
// from the Mac's call log, which hears the person and the companion alike.
import { useEffect, useState } from "react";
import { LayoutAnimation, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { CallRecord } from "./callTypes";
import { CompanionAvatar } from "./CompanionAvatar";
import { copy, phoneLocale } from "./copy";
import { callHeadline, spokenText } from "./roomModel";

const clock = new Intl.DateTimeFormat(phoneLocale(), { hour: "numeric", minute: "2-digit" });
const MISSED_RED = "#FF3B30";

function iconOf(call: CallRecord): string {
  if (call.status === "missed") return "phone.arrow.down.left";
  if (call.status === "declined") return "phone.down.fill";
  if (call.status === "active" || call.status === "ringing") return "phone.fill";
  return call.direction === "incoming" ? "phone.arrow.down.left" : "phone.arrow.up.right";
}

/** The person's small face in the transcript: the system's person glyph in the bubble color. */
function MeDot() {
  return (
    <View className="h-[22px] w-[22px] items-center justify-center rounded-full bg-user-bubble">
      <SymbolView name={{ ios: "person.fill", android: "smartphone" }} size={11} tintColorClassName="accent-user-bubble-foreground" />
    </View>
  );
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
  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen(!open);
  };
  return (
    <View className="self-start rounded-[22px] bg-grouped-card p-1.5" style={{ width: "86%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        className="flex-row items-center gap-3 rounded-[18px] py-1.5 pl-1.5 pr-3 active:opacity-70"
      >
        <View className="h-11 w-11 items-center justify-center rounded-[14px] bg-screen">
          <SymbolView
            name={{ ios: iconOf(call) as never, android: "smartphone" }}
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
        <SymbolView
          name={{ ios: open ? "chevron.up" : "chevron.down", android: "smartphone" }}
          size={11}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
      {open ? (
        <View className="mt-1 gap-2 rounded-[18px] bg-screen px-2.5 py-3">
          {lines.length === 0 ? (
            <Text className="py-1 text-center text-[13px] text-foreground-muted">{copy.nothingSaid}</Text>
          ) : (
            lines.map((line, index) => {
              const theirs = line.who === "companion";
              return (
                <View
                  key={`${line.at}:${index}`}
                  className={theirs ? "flex-row items-end gap-1.5 self-start" : "flex-row items-end gap-1.5 self-end"}
                  style={{ maxWidth: "90%" }}
                >
                  {theirs ? <CompanionAvatar art={props.art} title={props.title} size={22} /> : null}
                  <View
                    className={theirs ? "flex-shrink flex-row gap-1.5 rounded-[14px] bg-grouped-card px-3 py-2" : "flex-shrink flex-row gap-1.5 rounded-[14px] bg-user-bubble px-3 py-2"}
                  >
                    <SymbolView
                      name={{ ios: "waveform", android: "smartphone" }}
                      size={10}
                      className="mt-[3px]"
                      tintColorClassName={theirs ? "accent-foreground-muted" : "accent-user-bubble-foreground-muted"}
                    />
                    <Text
                      className={theirs ? "flex-shrink text-[14px] leading-[19px] text-foreground" : "flex-shrink text-[14px] leading-[19px] text-user-bubble-foreground"}
                    >
                      {line.text}
                    </Text>
                  </View>
                  {theirs ? null : <MeDot />}
                </View>
              );
            })
          )}
        </View>
      ) : null}
    </View>
  );
}
