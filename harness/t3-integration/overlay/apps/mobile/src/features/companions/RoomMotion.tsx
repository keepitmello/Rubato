// The room's motion, the way Messages moves (user 76b939e4: "아이메시지처럼 거의 클론"). Springs are
// iOS's own feel, critically close: a sent bubble rises out of the composer, the companion's grows
// out of the typing bubble's corner, and the rows around them slide instead of jumping. The typing
// bubble is Messages' (three dots that pulse in turn, two small circles for its tail); while the
// companion's tool runs, a small mark of the kind of work stands before the dots (user a9b0890f:
// rebuild it as Messages' and make it show; the split itself is the user's, decisions
// why-the-phone-room-splits-thinking-and-work).
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

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { copy } from "./copy";
import type { RoomTool } from "./roomModel";

/** iOS's default spring (response 0.4 s, damping 0.85): lands without a bounce you notice. */
export const ROOM_SPRING = { stiffness: 247, damping: 26.7, mass: 1 } as const;
/** The typing bubble's pop: response 0.35 s, damping 0.62, the small overshoot Messages gives it. */
const POP_SPRING = { stiffness: 322, damping: 22.2, mass: 1 } as const;

/** A bubble the person just sent: up out of the composer, from a little smaller, its corner first. */
export function sentEntering() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 44 }, { scale: 0.94 }] },
    animations: {
      opacity: withTiming(1, { duration: 90 }),
      transform: [{ translateY: withSpring(0, ROOM_SPRING) }, { scale: withSpring(1, ROOM_SPRING) }],
    },
  };
}

/** A bubble the companion just sent: grown out of where the typing bubble stood. */
export function receivedEntering() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.55 }] },
    animations: {
      opacity: withTiming(1, { duration: 140 }),
      transform: [{ scale: withSpring(1, ROOM_SPRING) }],
    },
  };
}

/** The typing bubble arriving: popped out of its tail. */
function typingEntering() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.2 }] },
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ scale: withSpring(1, POP_SPRING) }],
    },
  };
}

/** The typing bubble leaving: shrinks back into its tail. */
function typingExiting() {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: 150 }),
      transform: [{ scale: withTiming(0.4, { duration: 180, easing: Easing.in(Easing.quad) }) }],
    },
  };
}

export const hapticSend = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
export const hapticReceive = () => void Haptics.selectionAsync().catch(() => undefined);

const TOOL_SYMBOL: Record<RoomTool, AppSymbolName> = {
  search: { ios: "magnifyingglass", android: "public" },
  file: "doc.text",
  terminal: { ios: "apple.terminal", android: "terminal" },
  other: { ios: "sparkles", android: "bolt" },
};

const HEIGHT = 38;
const THINKING_WIDTH = 60;
const WORKING_WIDTH = 82;
const DOT = 8;
const DOT_GAP = 5;
const DOTS_WIDTH = DOT * 3 + DOT_GAP * 2;

/**
 * Messages' typing bubble, where the companion's next words will come. Thinking: the dots alone.
 * Working: the bubble widens and the kind of work stands before the dots.
 */
export function CompanionTypingBubble(props: { readonly tool: RoomTool | null; readonly bubbleColor: string; readonly dotColor: string }) {
  const working = useSharedValue(props.tool ? 1 : 0);
  useEffect(() => {
    working.set(withSpring(props.tool ? 1 : 0, ROOM_SPRING));
  }, [props.tool, working]);
  const shell = useAnimatedStyle(() => ({ width: interpolate(working.get(), [0, 1], [THINKING_WIDTH, WORKING_WIDTH]) }));
  const dots = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(working.get(), [0, 1], [(THINKING_WIDTH - DOTS_WIDTH) / 2, WORKING_WIDTH - DOTS_WIDTH - 14]) }],
  }));
  const mark = useAnimatedStyle(() => ({ opacity: working.get(), transform: [{ scale: 0.6 + 0.4 * working.get() }] }));
  return (
    <Animated.View
      accessible
      accessibilityLabel={copy.writing}
      entering={typingEntering}
      exiting={typingExiting}
      className="self-start"
      style={{ marginTop: 10, marginLeft: 2, transformOrigin: "left bottom" }}
    >
      {/* The tail: a small circle at the corner and a smaller one beyond it. */}
      <View style={{ position: "absolute", left: -3, bottom: -2, width: 13, height: 13, borderRadius: 6.5, backgroundColor: props.bubbleColor }} />
      <View style={{ position: "absolute", left: -8.5, bottom: -8.5, width: 6.5, height: 6.5, borderRadius: 3.25, backgroundColor: props.bubbleColor }} />
      <Animated.View style={[{ height: HEIGHT, borderRadius: HEIGHT / 2, backgroundColor: props.bubbleColor, overflow: "hidden", justifyContent: "center" }, shell]}>
        <Animated.View style={[{ position: "absolute", left: 13, width: 18, height: 18, alignItems: "center", justifyContent: "center" }, mark]}>
          {props.tool ? (
            // A new kind of work fades its mark in, the old one out.
            <Animated.View key={props.tool} entering={FadeIn.duration(220)} exiting={FadeOut.duration(140)}>
              <SymbolView name={TOOL_SYMBOL[props.tool]} size={14} weight="semibold" tintColor={props.dotColor} />
            </Animated.View>
          ) : null}
        </Animated.View>
        <Animated.View style={[{ position: "absolute", left: 0, flexDirection: "row", gap: DOT_GAP }, dots]}>
          {[0, 1, 2].map((index) => (
            <Dot key={index} index={index} color={props.dotColor} />
          ))}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/** One dot: brightens after the one before it, as Messages' do, and dims again. */
function Dot(props: { readonly index: number; readonly color: string }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.set(withDelay(
      props.index * 180,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 320, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 420, easing: Easing.in(Easing.quad) }),
          withTiming(0, { duration: 420 }),
        ),
        -1,
        false,
      ),
    ));
  }, [props.index, pulse]);
  const style = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * pulse.get(), transform: [{ scale: 0.92 + 0.08 * pulse.get() }] }));
  return <Animated.View style={[{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: props.color }, style]} />;
}

/** A bubble the person sent that the Mac has not taken yet stands dimmed, and clears when it is taken. */
export function usePendingFade(pending: boolean) {
  const shown = useSharedValue(pending ? 0.6 : 1);
  useEffect(() => {
    shown.set(withTiming(pending ? 0.6 : 1, { duration: 320, easing: Easing.out(Easing.quad) }));
  }, [pending, shown]);
  return useAnimatedStyle(() => ({ opacity: shown.get() }));
}

/** How far the room slides left to show each message's time (Messages' drag). */
export const TIME_REVEAL = 64;

/** A row's slide while the person drags the room left; its time stands just past its right edge. */
export function useRevealStyle(reveal: SharedValue<number>) {
  return useAnimatedStyle(() => ({ transform: [{ translateX: -reveal.get() }] }));
}
