// Rubato: what the thread composer shows in its field's place while live dictation runs, above the
// dictation row (cancel, waveform, stop). T3's thread composer flips its draft row away while
// dictating, so this draws what the field would: the draft, with the words heard so far placed where
// the final text will land (liveDictationDisplay, as the companion room's field places them), all
// grey, each new word fading in blue and fading to grey a moment later on its own clock. The final
// text still goes into the draft through T3's controller at stop, so nothing moves when it lands.
//
// It stands inside the composer's rounded surface, so its text keeps clear of the corners, and a
// long draft scrolls to its end within four lines, as the field would.
import { liveDictationDisplay } from "@t3tools/client-runtime/voice-input";
import { liveDictationPieces, liveDictationStore } from "@t3tools/shared/rubatoLiveDictation";
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import { ScrollView, Text } from "react-native";

import { liveWordsSegments, NATIVE_MEASURED_LINES } from "./composerFieldLayout";

type Rgb = readonly [number, number, number];
/** iOS's grey and blue, as ChatGPT's dictation draws its words. */
const GREY: Rgb = [142, 142, 147];
const BLUE: Rgb = [10, 132, 255];
/** At most this often the colours move (about 30 frames a second). */
const FRAME_MS = 33;
/** Clear of the composer surface's 27 pt corners, where the expanded editor's text starts. */
const PADDING_HORIZONTAL = 18;
const PADDING_TOP = 12;
const PADDING_BOTTOM = 4;

function tint(segment: { readonly visible: number; readonly blue: number } | null): string {
  if (segment === null) return `rgb(${GREY.join(",")})`;
  const channel = (index: 0 | 1 | 2) => Math.round(GREY[index] + (BLUE[index] - GREY[index]) * segment.blue);
  return `rgba(${channel(0)},${channel(1)},${channel(2)},${segment.visible.toFixed(3)})`;
}

export function RubatoLiveWords(props: {
  readonly visible: boolean;
  readonly draft: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly textStyle: { readonly fontSize: number; readonly lineHeight: number };
}) {
  const snapshot = useSyncExternalStore(liveDictationStore.subscribe, liveDictationStore.snapshot);
  const [now, setNow] = useState(() => Date.now());
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const pieces = props.visible ? liveDictationPieces(snapshot) : [];
  const display = liveDictationDisplay(props.draft, props.selection, pieces, now);
  const newest = pieces.reduce((latest, piece) => Math.max(latest, piece.at ?? 0), 0);
  const moving = display.animating || newest > now;
  useEffect(() => {
    if (props.visible) setNow(Date.now());
  }, [props.visible, snapshot]);
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => setNow(Date.now()), FRAME_MS);
    return () => clearTimeout(timer);
  }, [moving, now]);
  if (!props.visible || display.value.trim().length === 0) return null;
  // A word old enough carries no run: it reads plain grey with the draft.
  const segments = liveWordsSegments(display.value, display.runs);
  const { fontSize, lineHeight } = props.textStyle;
  return (
    <ScrollView
      ref={scroll}
      style={{ maxHeight: NATIVE_MEASURED_LINES * lineHeight + PADDING_TOP + PADDING_BOTTOM }}
      contentContainerStyle={{ paddingHorizontal: PADDING_HORIZONTAL, paddingTop: PADDING_TOP, paddingBottom: PADDING_BOTTOM }}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
    >
      <Text className="font-sans" style={{ fontSize, lineHeight, color: tint(null) }} accessibilityLiveRegion="polite">
        {segments.map((segment, index) => (
          <Text key={index} style={{ color: tint(segment.tint) }}>
            {segment.text}
          </Text>
        ))}
      </Text>
    </ScrollView>
  );
}
