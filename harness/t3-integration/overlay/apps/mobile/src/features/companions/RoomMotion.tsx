// The room's motion, the way Messages moves (the mockup the user approved, 2026-11-20): a sent
// bubble springs up out of the composer, the companion's bubble grows in where the answer will be,
// and while it owes an answer one bubble tells thinking from working. Thinking: three dots wave and
// the bubble breathes. Working: the dots gather into a turning ring, a small mark says what kind of
// work runs (search, a file, the terminal), and light runs round the border. No words like "using
// a tool": the motion says it.
import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { copy } from "./copy";
import type { RoomTool } from "./roomModel";

/** One spring for everything that lands: quick, with the slight overshoot Messages has. */
export const ROOM_SPRING = { damping: 16, stiffness: 210, mass: 0.9 } as const;

/** A bubble the person just sent: up out of the composer, from a little smaller. */
export function sentEntering() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 46 }, { scale: 0.82 }] },
    animations: {
      opacity: withTiming(1, { duration: 160 }),
      transform: [{ translateY: withSpring(0, ROOM_SPRING) }, { scale: withSpring(1, ROOM_SPRING) }],
    },
  };
}

/** A bubble the companion just sent, or its thinking bubble: grown in where it stands. */
export function receivedEntering() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.7 }, { translateY: 8 }] },
    animations: {
      opacity: withTiming(1, { duration: 180 }),
      transform: [{ scale: withSpring(1, ROOM_SPRING) }, { translateY: withSpring(0, ROOM_SPRING) }],
    },
  };
}

export const hapticSend = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
export const hapticReceive = () => void Haptics.selectionAsync().catch(() => undefined);

const TOOL_SYMBOL: Record<RoomTool, AppSymbolName> = {
  search: { ios: "magnifyingglass", android: "public" },
  file: "doc.text",
  terminal: { ios: "apple.terminal", android: "terminal" },
  other: { ios: "sparkles", android: "auto_awesome" },
};

const THINKING_WIDTH = 66;
const WORKING_WIDTH = 78;
const HEIGHT = 40;
const BORDER = 1.5;

/** The bubble that stands where the companion's answer will come, while it thinks or works. */
export function CompanionWorkIndicator(props: { readonly tool: RoomTool | null; readonly bubbleColor: string; readonly dotColor: string }) {
  const working = useSharedValue(props.tool ? 1 : 0);
  useEffect(() => {
    working.value = withSpring(props.tool ? 1 : 0, ROOM_SPRING);
  }, [props.tool, working]);
  const breath = useSharedValue(0);
  const spin = useSharedValue(0);
  useEffect(() => {
    breath.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }), -1, true);
    spin.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1, false);
  }, [breath, spin]);
  const glow = useSharedValue(0);
  useEffect(() => {
    glow.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear }), -1, false);
  }, [glow]);

  const shell = useAnimatedStyle(() => ({
    width: interpolate(working.value, [0, 1], [THINKING_WIDTH, WORKING_WIDTH]),
    // Breathes only while it thinks.
    transform: [{ scale: 1 + 0.035 * breath.value * (1 - Math.min(1, Math.max(0, working.value))) }],
  }));
  const ring = useAnimatedStyle(() => ({
    opacity: working.value,
    transform: [{ scale: 0.5 + 0.5 * working.value }, { rotate: `${spin.value * 360}deg` }],
  }));
  const mark = useAnimatedStyle(() => ({ opacity: working.value, transform: [{ scale: 0.5 + 0.5 * working.value }] }));
  const light = useAnimatedStyle(() => ({ opacity: working.value, transform: [{ rotate: `${glow.value * 360}deg` }] }));

  return (
    <Animated.View
      accessible
      accessibilityLabel={copy.writing}
      entering={receivedEntering}
      exiting={FadeOut.duration(140)}
      className="mt-2.5 self-start"
      style={[{ height: HEIGHT, borderRadius: 20, borderBottomLeftRadius: 6, overflow: "hidden" }, shell]}
    >
      {/* Light running round the border: a turning gradient behind the bubble's own face. */}
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: WORKING_WIDTH / 2 - 60, top: HEIGHT / 2 - 60, width: 120, height: 120 }, light]}>
        <Svg width={120} height={120}>
          <Defs>
            <LinearGradient id="roomGlow" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#7aa2ff" stopOpacity={0} />
              <Stop offset="0.35" stopColor="#7aa2ff" />
              <Stop offset="0.6" stopColor="#c58cff" />
              <Stop offset="0.8" stopColor="#ff8fb1" />
              <Stop offset="1" stopColor="#ff8fb1" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={120} height={60} fill="url(#roomGlow)" />
        </Svg>
      </Animated.View>
      <View
        style={{
          position: "absolute", left: BORDER, top: BORDER, right: BORDER, bottom: BORDER,
          borderRadius: 20 - BORDER, borderBottomLeftRadius: 6 - BORDER / 2, backgroundColor: props.bubbleColor,
          flexDirection: "row", alignItems: "center", paddingHorizontal: 13,
        }}
      >
        <View style={{ width: 36, height: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          {[0, 1, 2].map((index) => (
            <Dot key={index} index={index} working={working} color={props.dotColor} />
          ))}
        </View>
        <Animated.View style={[{ position: "absolute", left: 13, width: 20, height: 20 }, ring]}>
          <Svg width={20} height={20} viewBox="0 0 20 20">
            <Circle cx={10} cy={10} r={7.5} fill="none" stroke={props.dotColor} strokeOpacity={0.3} strokeWidth={2.4} />
            <Path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" fill="none" stroke={props.dotColor} strokeWidth={2.4} strokeLinecap="round" />
          </Svg>
        </Animated.View>
        <Animated.View style={[{ position: "absolute", left: 41, width: 18, height: 18, alignItems: "center", justifyContent: "center" }, mark]}>
          {props.tool ? (
            // A new kind of work fades its mark in, the old one out.
            <Animated.View key={props.tool} entering={FadeIn.duration(260)} exiting={FadeOut.duration(160)}>
              <SymbolView name={TOOL_SYMBOL[props.tool]} size={15} weight="semibold" tintColor={props.dotColor} />
            </Animated.View>
          ) : null}
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/** A thinking dot: waves after the one before it; while work runs it gathers into the ring. */
function Dot(props: { readonly index: number; readonly working: SharedValue<number>; readonly color: string }) {
  const wave = useSharedValue(0);
  useEffect(() => {
    wave.value = withDelay(
      props.index * 150,
      withRepeat(withSequence(withTiming(1, { duration: 300, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 300 }), withTiming(0, { duration: 600 })), -1, false),
    );
  }, [props.index, wave]);
  const style = useAnimatedStyle(() => {
    const gathered = Math.min(1, Math.max(0, props.working.value));
    return {
      opacity: (0.45 + 0.55 * wave.value) * (1 - gathered),
      transform: [
        { translateX: (1 - props.index) * 13 * gathered },
        { translateY: -5 * wave.value * (1 - gathered) },
        { scale: 1 - 0.7 * gathered },
      ],
    };
  });
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.color }, style]} />;
}

/** A bubble the person sent that the Mac has not taken yet stands dimmed, and clears when it is taken. */
export function usePendingFade(pending: boolean) {
  const shown = useSharedValue(pending ? 0.7 : 1);
  useEffect(() => {
    shown.value = withTiming(pending ? 0.7 : 1, { duration: 380, easing: Easing.out(Easing.quad) });
  }, [pending, shown]);
  return useAnimatedStyle(() => ({ opacity: shown.value }));
}
