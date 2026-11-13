// The call the phone is on: the companion's face and name, what it is doing, the latest words, and
// mute, speaker and end. The system call screen shows the same call while the phone is locked.
import { useEffect, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { callActions, type CallRecord, type CurrentCall } from "./callStore";
import { CompanionAvatar } from "./CompanionAvatar";
import type { CompanionEntry } from "./companionsStore";
import { copy } from "./copy";
import { callLength, spokenText } from "./roomModel";

function RoundButton(props: {
  readonly label: string;
  readonly icon: string;
  readonly on?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  const fill = props.danger ? "bg-[#E5484D]" : props.on ? "bg-foreground" : "bg-grouped-card";
  return (
    <View className="items-center gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ selected: props.on === true }}
        onPress={props.onPress}
        className={`h-[72px] w-[72px] items-center justify-center rounded-full active:opacity-70 ${fill}`}
      >
        <SymbolView
          name={{ ios: props.icon as never, android: "smartphone" }}
          size={28}
          {...(props.danger ? { tintColor: "#FFFFFF" } : { tintColorClassName: props.on ? "accent-screen" : "accent-foreground" })}
        />
      </Pressable>
      <Text className="text-[13px] text-foreground-muted">{props.label}</Text>
    </View>
  );
}

export function CallScreen(props: { readonly current: CurrentCall; readonly companion: CompanionEntry | null }) {
  const { current } = props;
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const title = props.companion?.title ?? current.call.title ?? current.call.companion;
  const status =
    current.connectedAt === null
      ? copy.connecting
      : `${callLength(now - current.connectedAt)} · ${copy[current.state === "connecting" ? "listening" : current.state]}`;
  const theirs = [...current.lines].reverse().find((line) => line.who === "companion");
  const mine = [...current.lines].reverse().find((line) => line.who === "me");
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={callActions.hangUp}>
      <View className="flex-1 items-center bg-screen px-8" style={{ paddingTop: insets.top + 48, paddingBottom: insets.bottom + 28 }}>
        <CompanionAvatar art={props.companion?.art ?? null} title={title} size={132} ring />
        <Text className="mt-5 font-t3-bold text-[28px] text-foreground">{title}</Text>
        <Text className="mt-1 text-[16px] text-foreground-muted">{status}</Text>
        <View className="w-full flex-1 justify-center gap-3">
          {theirs ? (
            <Text numberOfLines={5} className="text-center text-[20px] leading-[28px] text-foreground">
              {spokenText(theirs.text)}
            </Text>
          ) : null}
          {mine ? (
            <Text numberOfLines={2} className="text-center text-[15px] leading-[21px] text-foreground-muted">
              {spokenText(mine.text)}
            </Text>
          ) : null}
        </View>
        <View className="w-full flex-row items-start justify-around">
          <RoundButton
            label={copy.mute}
            icon={current.muted ? "mic.slash.fill" : "mic.slash"}
            on={current.muted}
            onPress={() => callActions.setMuted(!current.muted)}
          />
          <RoundButton label={copy.hangUp} icon="phone.down.fill" danger onPress={callActions.hangUp} />
          <RoundButton
            label={copy.speaker}
            icon={current.speaker ? "speaker.wave.2.fill" : "speaker.wave.2"}
            on={current.speaker}
            onPress={() => callActions.setSpeaker(!current.speaker)}
          />
        </View>
      </View>
    </Modal>
  );
}

/** A companion's ring the app shows itself, only where CallKit is not built in. */
export function RingScreen(props: { readonly call: CallRecord; readonly companion: CompanionEntry | null }) {
  const insets = useSafeAreaInsets();
  const title = props.companion?.title ?? props.call.title ?? props.call.companion;
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => void callActions.decline()}>
      <View className="flex-1 items-center bg-screen px-8" style={{ paddingTop: insets.top + 64, paddingBottom: insets.bottom + 40 }}>
        <CompanionAvatar art={props.companion?.art ?? null} title={title} size={132} ring />
        <Text className="mt-5 font-t3-bold text-[28px] text-foreground">{title}</Text>
        <Text className="mt-1 text-[16px] text-foreground-muted">{copy.isCalling}</Text>
        {props.call.reason ? (
          <Text className="mt-6 text-center text-[16px] leading-[22px] text-foreground">{props.call.reason}</Text>
        ) : null}
        <View className="flex-1" />
        <View className="w-full flex-row justify-around">
          <RoundButton label={copy.hangUp} icon="phone.down.fill" danger onPress={() => void callActions.decline()} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.call}
            onPress={() => void callActions.answer()}
            className="h-[72px] w-[72px] items-center justify-center rounded-full bg-[#30C452] active:opacity-70"
          >
            <SymbolView name={{ ios: "phone.fill", android: "smartphone" }} size={28} tintColor="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
