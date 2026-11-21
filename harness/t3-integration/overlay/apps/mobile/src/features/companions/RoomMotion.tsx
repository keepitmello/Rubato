// The room's motion, the way Messages moves (user 76b939e4: "아이메시지처럼 거의 클론"). Springs are
// iOS's own feel, critically close: a sent bubble rises out of the composer, the companion's grows
// out of the typing bubble's corner, and the rows around them slide instead of jumping. The typing
// bubble is Messages' shape (two small circles for its tail) with a pen in it: it writes a line
// while the companion thinks and draws the kind of work while its tool runs (user a7a3ec4e chose
// the drawing; the split itself is the user's, decisions why-the-phone-room-splits-thinking-and-work).
import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import Svg, { Circle, G, Path } from "react-native-svg";

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

const HEIGHT = 38;
const THINKING_WIDTH = 60;
const WORKING_WIDTH = 84;

/** The pen line the bubble writes while the companion thinks: a short cursive wave, as points. */
function squiggle(x0: number, x1: number, steps = 24): ReadonlyArray<readonly [number, number]> {
  const points: Array<readonly [number, number]> = [[x0, 21]];
  for (let index = 1; index <= steps; index += 1) {
    const u = index / steps;
    points.push([x0 + (x1 - x0) * u, 19 + Math.sin(u * Math.PI * 4.5) * 3.4 * (1 - Math.abs(u - 0.5))]);
  }
  return points;
}
const LINE = squiggle(13, 47);
const LINE_D = LINE.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
const LINE_AT: number[] = [0];
for (let index = 1; index < LINE.length; index += 1)
  LINE_AT.push(LINE_AT[index - 1]! + Math.hypot(LINE[index]![0] - LINE[index - 1]![0], LINE[index]![1] - LINE[index - 1]![1]));
const LINE_LENGTH = LINE_AT[LINE_AT.length - 1]!;
const LINE_XS = LINE.map(([x]) => x);
const LINE_YS = LINE.map(([, y]) => y);
/** Of one stroke of the pen: the share of the time it writes; the rest it erases. */
const WRITE_SHARE = 0.6;

/**
 * Each kind of work as the pen draws it, in a 16 pt box around (0, 0): its strokes and their
 * lengths, so each stroke is drawn from its start to its end.
 */
const WORK_STROKES: Record<RoomTool, ReadonlyArray<{ readonly d: string; readonly length: number }>> = {
  search: [
    { d: "M -2.2 -6.8 a 4.6 4.6 0 1 0 0.01 0", length: 28.9 },
    { d: "M 1.3 1.3 L 5.6 5.6", length: 6.1 },
  ],
  file: [
    { d: "M -4.8 -6.5 L 1.6 -6.5 L 4.8 -3.3 L 4.8 6.5 L -4.8 6.5 Z", length: 43.4 },
    { d: "M -2.6 -0.6 L 2.6 -0.6", length: 5.2 },
    { d: "M -2.6 2.6 L 2.6 2.6", length: 5.2 },
  ],
  terminal: [
    { d: "M -6.4 -5.2 L 6.4 -5.2 Q 7.4 -5.2 7.4 -4.2 L 7.4 4.6 Q 7.4 5.6 6.4 5.6 L -6.4 5.6 Q -7.4 5.6 -7.4 4.6 L -7.4 -4.2 Q -7.4 -5.2 -6.4 -5.2 Z", length: 49.5 },
    { d: "M -4.2 -2 L -1.6 0.3 L -4.2 2.6", length: 7 },
    { d: "M 0.4 2.8 L 3.8 2.8", length: 3.4 },
  ],
  other: [
    { d: "M 0 -6.5 Q 0.9 -0.9 6.5 0 Q 0.9 0.9 0 6.5 Q -0.9 0.9 -6.5 0 Q -0.9 -0.9 0 -6.5 Z", length: 30 },
  ],
};

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

/**
 * Messages' typing bubble with a pen in it (user a7a3ec4e chose the drawing among four motions):
 * while the companion thinks, a line writes itself across the bubble and is erased, again and
 * again; while its tool runs, the bubble widens and the pen draws the kind of work, with the
 * dots pulsing after it.
 */
export function CompanionTypingBubble(props: {
  readonly tool: RoomTool | null;
  readonly bubbleColor: string;
  readonly dotColor: string;
  readonly penColor: string;
}) {
  const working = useSharedValue(props.tool ? 1 : 0);
  useEffect(() => {
    working.set(withSpring(props.tool ? 1 : 0, ROOM_SPRING));
  }, [props.tool, working]);
  const stroke = useSharedValue(0);
  useEffect(() => {
    stroke.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1, false));
  }, [stroke]);
  const shell = useAnimatedStyle(() => ({ width: interpolate(working.get(), [0, 1], [THINKING_WIDTH, WORKING_WIDTH]) }));
  const lineFade = useAnimatedProps(() => ({ opacity: Math.max(0, 1 - working.get() * 1.8) }));
  const line = useAnimatedProps(() => {
    const phase = stroke.get();
    if (phase < WRITE_SHARE) {
      const head = Easing.inOut(Easing.quad)(phase / WRITE_SHARE);
      return { strokeDashoffset: LINE_LENGTH * (1 - head) };
    }
    const tail = Easing.in(Easing.quad)((phase - WRITE_SHARE) / (1 - WRITE_SHARE));
    return { strokeDashoffset: -LINE_LENGTH * tail };
  });
  const pen = useAnimatedProps(() => {
    const phase = stroke.get();
    const writing = phase < WRITE_SHARE;
    const at = LINE_LENGTH * Easing.inOut(Easing.quad)(Math.min(1, phase / WRITE_SHARE));
    let index = 1;
    while (index < LINE_AT.length - 1 && LINE_AT[index]! < at) index += 1;
    const from = LINE_AT[index - 1]!;
    const span = LINE_AT[index]! - from || 1;
    const u = (at - from) / span;
    return {
      cx: LINE_XS[index - 1]! + (LINE_XS[index]! - LINE_XS[index - 1]!) * u,
      cy: LINE_YS[index - 1]! + (LINE_YS[index]! - LINE_YS[index - 1]!) * u,
      opacity: writing ? Math.max(0, 1 - working.get() * 1.8) : 0,
    };
  });
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
      <Animated.View style={[{ height: HEIGHT, borderRadius: HEIGHT / 2, backgroundColor: props.bubbleColor, overflow: "hidden" }, shell]}>
        <Svg width={WORKING_WIDTH} height={HEIGHT} style={{ position: "absolute", left: 0, top: 0 }}>
          <AnimatedG animatedProps={lineFade}>
            <AnimatedPath
              d={LINE_D}
              fill="none"
              stroke={props.dotColor}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={[LINE_LENGTH, LINE_LENGTH]}
              animatedProps={line}
            />
          </AnimatedG>
          <AnimatedCircle r={2.2} fill={props.penColor} animatedProps={pen} />
          {props.tool ? <WorkDrawing key={props.tool} tool={props.tool} color={props.penColor} working={working} /> : null}
        </Svg>
        {props.tool ? (
          <View style={{ position: "absolute", left: 38, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 5.5 }}>
            {[0, 1, 2].map((index) => (
              <Dot key={index} index={index} color={props.dotColor} />
            ))}
          </View>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

/** The pen drawing one kind of work, stroke after stroke, once; a new kind is drawn afresh. */
function WorkDrawing(props: { readonly tool: RoomTool; readonly color: string; readonly working: SharedValue<number> }) {
  const strokes = WORK_STROKES[props.tool];
  const drawn = useSharedValue(0);
  useEffect(() => {
    drawn.set(withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }));
  }, [drawn]);
  const shown = useAnimatedProps(() => ({ opacity: Math.min(1, props.working.get() * 1.4) }));
  return (
    <AnimatedG animatedProps={shown} transform="translate(15 19)">
      {strokes.map((part, index) => (
        <WorkStroke key={index} d={part.d} length={part.length} color={props.color} drawn={drawn} from={index / strokes.length} to={(index + 1) / strokes.length} />
      ))}
    </AnimatedG>
  );
}

/** One stroke of a drawing, drawn over its share of the drawing's time. */
function WorkStroke(props: {
  readonly d: string;
  readonly length: number;
  readonly color: string;
  readonly drawn: SharedValue<number>;
  readonly from: number;
  readonly to: number;
}) {
  const { length, from, to } = props;
  const style = useAnimatedProps(() => {
    const share = Math.min(1, Math.max(0, (props.drawn.get() - from) / (to - from)));
    return { strokeDashoffset: length * (1 - share) };
  });
  return (
    <AnimatedPath
      d={props.d}
      fill="none"
      stroke={props.color}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={[length, length]}
      animatedProps={style}
    />
  );
}

/** One of the working dots: brightens after the one before it, as Messages' do, and dims again. */
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
  const style = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * pulse.get() }));
  return <Animated.View style={[{ width: 5.2, height: 5.2, borderRadius: 2.6, backgroundColor: props.color }, style]} />;
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
