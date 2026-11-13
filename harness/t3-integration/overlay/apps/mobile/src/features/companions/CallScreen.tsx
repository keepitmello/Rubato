// The call the phone is on, drawn like iOS's own call screen: the companion's face blurred behind
// everything, its face and name, what it is doing, its latest words, and glass buttons for mute and
// speaker beside the red end button. The system call screen shows the same call while locked.
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { callActions, type CurrentCall } from "./callStore";
import type { CallRecord } from "./callTypes";
import { CompanionAvatar } from "./CompanionAvatar";
import type { CompanionEntry } from "./companionsStore";
import { copy } from "./copy";
import { callLength, spokenText } from "./roomModel";

const END_RED = "#FF3B30";
const ANSWER_GREEN = "#34C759";

/** The companion's face filling the screen, blurred and darkened; plain dark without one. */
function CallBackdrop(props: { readonly art: string | null }) {
  return (
    <View style={StyleSheet.absoluteFill} className="bg-[#101114]">
      {props.art ? (
        <Image source={{ uri: props.art }} contentFit="cover" blurRadius={60} style={StyleSheet.absoluteFill} />
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.42)" }]} />
    </View>
  );
}

function RoundButton(props: {
  readonly label: string;
  readonly icon: string;
  readonly on?: boolean;
  readonly fill?: string;
  readonly onPress: () => void;
}) {
  const size = 76;
  const icon = (
    <SymbolView
      name={{ ios: props.icon as never, android: "smartphone" }}
      size={30}
      tintColor={props.on ? "#111111" : "#FFFFFF"}
    />
  );
  return (
    <View className="items-center gap-2">
      {props.fill ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.label}
          onPress={props.onPress}
          className="items-center justify-center rounded-full active:opacity-70"
          style={{ width: size, height: size, backgroundColor: props.fill }}
        >
          {icon}
        </Pressable>
      ) : (
        <GlassSurface
          glassEffectStyle="clear"
          chrome="none"
          tintColor={props.on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.16)"}
          fallbackColor={props.on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.18)"}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ selected: props.on === true }}
            onPress={props.onPress}
            className="flex-1 items-center justify-center active:opacity-70"
          >
            {icon}
          </Pressable>
        </GlassSurface>
      )}
      <Text className="text-[13px]" style={{ color: "rgba(255,255,255,0.85)" }}>
        {props.label}
      </Text>
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
  const art = props.companion?.art ?? null;
  const title = props.companion?.title ?? current.call.title ?? current.call.companion;
  const status =
    current.connectedAt === null
      ? copy.connecting
      : `${callLength(now - current.connectedAt)} · ${copy[current.state === "connecting" ? "listening" : current.state]}`;
  const theirs = [...current.lines].reverse().find((line) => line.who === "companion");
  const mine = [...current.lines].reverse().find((line) => line.who === "me");
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent statusBarTranslucent onRequestClose={callActions.hangUp}>
      <CallBackdrop art={art} />
      <View className="flex-1 items-center px-8" style={{ paddingTop: insets.top + 56, paddingBottom: insets.bottom + 32 }}>
        <CompanionAvatar art={art} title={title} size={120} />
        <Text className="mt-5 font-t3-bold text-[30px]" style={{ color: "#FFFFFF" }}>
          {title}
        </Text>
        <Text className="mt-1 text-[16px]" style={{ color: "rgba(255,255,255,0.75)", fontVariant: ["tabular-nums"] }}>
          {status}
        </Text>
        <View className="w-full flex-1 justify-center gap-3">
          {theirs ? (
            <Text numberOfLines={5} className="text-center text-[21px] leading-[29px]" style={{ color: "#FFFFFF" }}>
              {spokenText(theirs.text)}
            </Text>
          ) : null}
          {mine ? (
            <Text numberOfLines={2} className="text-center text-[15px] leading-[21px]" style={{ color: "rgba(255,255,255,0.65)" }}>
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
          <RoundButton label={copy.hangUp} icon="phone.down.fill" fill={END_RED} onPress={callActions.hangUp} />
          <RoundButton
            label={copy.speaker}
            icon="speaker.wave.2.fill"
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
  const art = props.companion?.art ?? null;
  const title = props.companion?.title ?? props.call.title ?? props.call.companion;
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent statusBarTranslucent onRequestClose={() => void callActions.decline()}>
      <CallBackdrop art={art} />
      <View className="flex-1 items-center px-8" style={{ paddingTop: insets.top + 72, paddingBottom: insets.bottom + 44 }}>
        <CompanionAvatar art={art} title={title} size={120} />
        <Text className="mt-5 font-t3-bold text-[30px]" style={{ color: "#FFFFFF" }}>
          {title}
        </Text>
        <Text className="mt-1 text-[16px]" style={{ color: "rgba(255,255,255,0.75)" }}>
          {copy.isCalling}
        </Text>
        {props.call.reason ? (
          <Text className="mt-6 text-center text-[16px] leading-[22px]" style={{ color: "#FFFFFF" }}>
            {props.call.reason}
          </Text>
        ) : null}
        <View className="flex-1" />
        <View className="w-full flex-row justify-around">
          <RoundButton label={copy.decline} icon="phone.down.fill" fill={END_RED} onPress={() => void callActions.decline()} />
          <RoundButton label={copy.answer} icon="phone.fill" fill={ANSWER_GREEN} onPress={() => void callActions.answer()} />
        </View>
      </View>
    </Modal>
  );
}
