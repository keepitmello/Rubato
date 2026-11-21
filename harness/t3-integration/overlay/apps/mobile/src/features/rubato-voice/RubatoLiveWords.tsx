// Rubato: the words heard so far, above the thread composer's dictation row (cancel, waveform,
// stop) while live dictation runs. T3's thread composer flips its draft row away while dictating, so
// nothing showed what was being heard; this shows it as the companion room's field does: grey, each
// new word fading in blue and fading to grey a moment later on its own clock (shared
// liveDictationTint). The final text still goes into the draft through T3's controller at stop.
import {
  LIVE_SETTLE_MS,
  liveDictationPieces,
  liveDictationStore,
  liveDictationTint,
} from "@t3tools/shared/rubatoLiveDictation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";

type Rgb = readonly [number, number, number];
/** iOS's grey and blue, as ChatGPT's dictation draws its words. */
const GREY: Rgb = [142, 142, 147];
const BLUE: Rgb = [10, 132, 255];
/** At most this often the colours move (about 30 frames a second). */
const FRAME_MS = 33;

function tint(age: number | null): string {
  if (age === null) return `rgb(${GREY.join(",")})`;
  const { visible, blue } = liveDictationTint(age);
  const channel = (index: 0 | 1 | 2) => Math.round(GREY[index] + (BLUE[index] - GREY[index]) * blue);
  return `rgba(${channel(0)},${channel(1)},${channel(2)},${visible.toFixed(3)})`;
}

export function RubatoLiveWords(props: { readonly visible: boolean }) {
  const snapshot = useSyncExternalStore(liveDictationStore.subscribe, liveDictationStore.snapshot);
  const [now, setNow] = useState(() => Date.now());
  const pieces = props.visible ? liveDictationPieces(snapshot) : [];
  const moving = pieces.some((piece) => piece.at !== null && now - piece.at < LIVE_SETTLE_MS);
  const newest = pieces.reduce((latest, piece) => Math.max(latest, piece.at ?? 0), 0);
  useEffect(() => {
    if (!moving && newest <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), FRAME_MS);
    return () => clearTimeout(timer);
  }, [moving, newest, now]);
  if (pieces.length === 0) return null;
  return (
    <View className="px-1 pb-2 pt-1">
      <Text className="font-sans text-base" accessibilityLiveRegion="polite">
        {pieces.map((piece, index) => (
          <Text key={index} style={{ color: tint(piece.at === null ? null : now - piece.at) }}>
            {index === 0 ? piece.text.trimStart() : piece.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}
