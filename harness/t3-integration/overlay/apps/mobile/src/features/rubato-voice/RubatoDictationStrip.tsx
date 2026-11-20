// Rubato: the composer's row while live dictation runs, as ChatGPT's iOS app draws it (measured
// frame by frame from the user's screen recording, 2026-11-20): cancel, the microphone as a waveform
// that glides left every frame, stop, and send. The cancel cross turns in from where the plus stood
// and turns back out; stop shrinks away into a spinner while the final text comes, and the waveform
// keeps gliding meanwhile. Both phone composers (thread and companion room) use it in place of
// T3's flipping dictation toolbar.
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Pressable, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ComposerDictationStatus } from "../voice-input/ComposerDictationControl";
import type { VoiceComposerPresentation } from "../voice-input/voiceInputPresentation";

const TIMING = { duration: 180, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System } as const;
/** The waveform: one sample every STEP, SPACING apart, gliding by SPACING per STEP. */
const STEP = 80;
const SPACING = 4;
const HISTORY = 128;
const WAVE_HEIGHT = 26;
/** Below this (normalized metering) the microphone counts as quiet and draws a dot. */
const QUIET = 0.12;

const crossIn: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ rotate: "-45deg" }, { scale: 0.85 }] },
    animations: {
      opacity: withTiming(1, TIMING),
      transform: [{ rotate: withTiming("0deg", TIMING) }, { scale: withTiming(1, TIMING) }],
    },
  };
};
const crossOut: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ rotate: "0deg" }, { scale: 1 }] },
    animations: {
      opacity: withTiming(0, TIMING),
      transform: [{ rotate: withTiming("-45deg", TIMING) }, { scale: withTiming(0.85, TIMING) }],
    },
  };
};

function WaveBar(props: { readonly history: SharedValue<ReadonlyArray<number>>; readonly index: number; readonly count: number }) {
  const { history, index, count } = props;
  const style = useAnimatedStyle(() => {
    const level = history.value[HISTORY - count + index] ?? 0;
    const quiet = level < QUIET;
    // The left end fades out, as the strip's does.
    const edge = Math.min(1, (index + 1) / 6);
    return {
      height: quiet ? 2 : Math.max(5, Math.min(WAVE_HEIGHT, level * WAVE_HEIGHT * 1.15)),
      opacity: (quiet ? 0.35 : 0.85) * edge,
    };
  });
  return <Animated.View className="rounded-full bg-foreground" style={[{ width: 2, marginRight: SPACING - 2 }, style]} />;
}

/** The microphone gliding left: bars for sound, dots for quiet. `sampling` is whether it is read at all. */
function GlidingWaveform(props: { readonly audioLevels: SharedValue<ReadonlyArray<number>>; readonly sampling: boolean }) {
  const { audioLevels } = props;
  const [count, setCount] = useState(0);
  const history = useSharedValue<ReadonlyArray<number>>(Array<number>(HISTORY).fill(0));
  const elapsed = useSharedValue(0);
  const sampling = useSharedValue(props.sampling);
  useEffect(() => {
    sampling.value = props.sampling;
  }, [props.sampling, sampling]);
  useFrameCallback((frame) => {
    "worklet";
    elapsed.value += frame.timeSincePreviousFrame ?? 16;
    let next: number[] | null = null;
    while (elapsed.value >= STEP) {
      elapsed.value -= STEP;
      const levels = audioLevels.value;
      const level = sampling.value ? (levels[levels.length - 1] ?? 0) : 0;
      next = [...(next ?? history.value).slice(1), level];
    }
    if (next !== null) history.value = next;
  });
  const glide = useAnimatedStyle(() => ({ transform: [{ translateX: SPACING - (elapsed.value / STEP) * SPACING }] }));
  const onLayout = (event: LayoutChangeEvent) =>
    setCount(Math.min(HISTORY, Math.ceil(event.nativeEvent.layout.width / SPACING) + 1));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="min-w-0 flex-1 overflow-hidden"
      style={{ height: WAVE_HEIGHT }}
      onLayout={onLayout}
    >
      <Animated.View className="absolute bottom-0 right-0 top-0 flex-row items-center" style={glide}>
        {Array.from({ length: count }, (_, index) => (
          <WaveBar key={index} history={history} index={index} count={count} />
        ))}
      </Animated.View>
    </View>
  );
}

/** Stop, which shrinks away into a spinner once the final text is on its way. */
function StopAction(props: { readonly busy: boolean; readonly disabled: boolean; readonly onStop: () => void }) {
  const busy = useSharedValue(props.busy ? 1 : 0);
  useLayoutEffect(() => {
    busy.value = withTiming(props.busy ? 1 : 0, TIMING);
  }, [busy, props.busy]);
  const stopStyle = useAnimatedStyle(() => ({ opacity: 1 - busy.value, transform: [{ scale: 1 - busy.value * 0.4 }] }));
  const spinnerStyle = useAnimatedStyle(() => ({ opacity: busy.value }));
  return (
    <Pressable
      accessibilityLabel="Finish dictation"
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled || props.busy}
      onPress={props.onStop}
    >
      <Animated.View className="size-[30px] items-center justify-center rounded-full bg-subtle" style={stopStyle}>
        <SymbolView name="stop.fill" size={11} tintColorClassName="accent-icon" type="monochrome" />
      </Animated.View>
      <Animated.View className="absolute inset-0 items-center justify-center" pointerEvents="none" style={spinnerStyle}>
        {props.busy ? <AppActivityIndicator size="small" colorClassName="accent-icon-muted" /> : null}
      </Animated.View>
    </Pressable>
  );
}

export function RubatoDictationStrip(props: {
  readonly state: VoiceInputState;
  readonly presentation: VoiceComposerPresentation;
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
  readonly elapsedSeconds: number;
  readonly onCancel: () => void;
  readonly onStop: () => void;
  /** What stands after stop: the composer's send. */
  readonly trailing?: ReactNode;
}) {
  const phase = props.state.phase;
  return (
    <View className="h-[44px] min-w-0 flex-1 flex-row items-center">
      <Animated.View entering={crossIn} exiting={crossOut}>
        <Pressable
          accessibilityLabel="Cancel dictation"
          accessibilityRole="button"
          className="size-[44px] items-center justify-center active:opacity-70"
          onPress={props.onCancel}
        >
          <View className="size-[30px] items-center justify-center rounded-full bg-subtle">
            <SymbolView name="xmark" size={13} weight="semibold" tintColorClassName="accent-icon" type="monochrome" />
          </View>
        </Pressable>
      </Animated.View>
      {phase === "error" ? (
        <ComposerDictationStatus
          audioLevels={props.audioLevels}
          elapsedSeconds={props.elapsedSeconds}
          phase={phase}
          presentation={props.presentation}
        />
      ) : (
        <Animated.View className="min-w-0 flex-1 flex-row items-center pl-1" entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)}>
          <GlidingWaveform audioLevels={props.audioLevels} sampling={phase === "recording"} />
          <StopAction busy={phase === "transcribing"} disabled={phase !== "recording"} onStop={props.onStop} />
        </Animated.View>
      )}
      {props.trailing}
    </View>
  );
}

/** The composer's lower row: the draft's buttons or the dictation strip, crossfading as ChatGPT's do. */
export function RubatoDictationToolbar(props: {
  readonly children: ReactNode;
  readonly showsDictation: boolean;
  readonly visible?: boolean;
}) {
  return (
    <View className="relative h-[44px]">
      {props.visible !== false ? (
        <Animated.View
          key={props.showsDictation ? "dictation" : "draft"}
          className="absolute inset-0"
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(140)}
        >
          {props.children}
        </Animated.View>
      ) : null}
    </View>
  );
}
