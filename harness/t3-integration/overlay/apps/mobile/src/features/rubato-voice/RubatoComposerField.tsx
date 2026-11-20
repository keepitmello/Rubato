// Rubato: the phone composers' text field (thread and companion room), as ChatGPT's works.
//
// - It grows with its text from `minLines` to `maxLines`, then scrolls. T3's field sat between
//   fixed heights because nothing read the native editor's content height; this reads it
//   (T3ComposerEditorView emits it as onComposerContentSizeChange).
// - Past `maxLines` an expand control appears at its top right and opens the draft full screen,
//   with its own send.
// - While live dictation runs for this composer, the editor shows the draft with the words heard
//   so far where the final text will land, grey, each new word fading in blue and fading to grey a
//   moment later on its own clock, the caret after them; once the final text lands it all turns
//   from grey to ink (ChatGPT's dictation, measured from the user's recording). It stays the draft's editor, read-only, so the keyboard stays up; the final text goes
//   into the draft through T3's controller at stop (client-runtime rubatoLiveDictationDisplay.ts).
import { liveDictationDisplay } from "@t3tools/client-runtime/voice-input";
import { createDictationEdits, liveDictationPieces, liveDictationStore } from "@t3tools/shared/rubatoLiveDictation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { ComposerEditor, type ComposerEditorProps } from "../../components/ComposerEditor";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import type { ComposerEditorProps as NativeEditorProps, ComposerEditorSelection } from "../../native/T3ComposerEditor.types";
import { onDictated, reportDictationEdits } from "./macLiveDictation";

export type RubatoComposerFieldProps = ComposerEditorProps & {
  /** Live dictation is running for this composer's draft. */
  readonly dictating: boolean;
  readonly lineHeight: number;
  readonly minLines?: number;
  readonly maxLines?: number;
  /** Offers the full-screen editor past `maxLines`, sending with this. */
  readonly expand?: {
    readonly sendLabel: string;
    readonly canSend: boolean;
    readonly onSend: () => void;
  };
};

const EXPAND_LABELS = { open: "Expand", close: "Collapse" } as const;
type Rgba = readonly [number, number, number, number];
/** iOS's grey and blue, as ChatGPT's dictation draws its words. */
const DICTATION_GREY: Rgba = [142 / 255, 142 / 255, 147 / 255, 1];
const DICTATION_BLUE: Rgba = [10 / 255, 132 / 255, 255 / 255, 1];
/** How long the committed text takes to turn from grey to ink. */
const SETTLE_MS = 160;
/** At most this often the colours are sent while words move (about 30 frames a second). */
const FRAME_MS = 33;

const mix = (from: Rgba, to: Rgba, amount: number, alpha = 1): Rgba => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
  alpha,
];

/** A theme colour string (#rgb, #rrggbb, #rrggbbaa or rgb[a](…)) as RGBA 0…1, or null. */
function rgbaOf(color: unknown): Rgba | null {
  if (typeof color !== "string") return null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1];
  if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const full = hex.length === 3 ? hex.split("").map((digit) => digit + digit).join("") : hex;
    const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
    return [channel(0), channel(1), channel(2), full.length === 8 ? channel(3) : 1];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim())?.[1]?.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (rgb && rgb.length >= 3 && rgb.every(Number.isFinite)) return [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, rgb[3] ?? 1];
  return null;
}

type FieldDisplay = {
  readonly value: string;
  readonly selection: ComposerEditorSelection;
  readonly dictation: NonNullable<NativeEditorProps["dictation"]>;
};

/**
 * What the field shows while dictation runs, and for a moment after: the draft with the heard
 * words placed where the final text lands, every word fading in blue and fading to grey on its own
 * clock, and once the final text is in the draft, all of it turning from grey to ink.
 */
function useLiveDictationDisplay(
  active: boolean,
  draft: string,
  selection: ComposerEditorSelection | undefined,
  ink: Rgba,
): FieldDisplay | null {
  const snapshot = useSyncExternalStore(liveDictationStore.subscribe, liveDictationStore.snapshot);
  const [now, setNow] = useState(() => Date.now());
  const [settledAt, setSettledAt] = useState<number | null>(null);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active) setSettledAt(null);
    else if (wasActive.current) setSettledAt(Date.now());
    wasActive.current = active;
  }, [active]);
  useEffect(() => {
    if (active) setNow(Date.now());
  }, [active, snapshot]);
  const live = active
    ? liveDictationDisplay(draft, selection ?? { start: draft.length, end: draft.length }, liveDictationPieces(snapshot), now)
    : null;
  const settling = !active && settledAt !== null && now - settledAt < SETTLE_MS;
  // One frame after another while a word moves or the committed text turns to ink.
  const moving = (live?.animating ?? false) || settling;
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => setNow(Date.now()), FRAME_MS);
    return () => clearTimeout(timer);
  }, [moving, now]);
  if (live) {
    return {
      value: live.value,
      selection: live.selection,
      dictation: {
        base: DICTATION_GREY,
        runs: live.runs.map((run) => ({
          start: run.start,
          end: run.end,
          color: mix(DICTATION_GREY, DICTATION_BLUE, run.blue, run.visible),
        })),
      },
    };
  }
  if (settling && settledAt !== null) {
    return {
      value: draft,
      selection: selection ?? { start: draft.length, end: draft.length },
      dictation: { base: mix(DICTATION_GREY, ink, Math.min(1, Math.max(0, (now - settledAt) / SETTLE_MS))), runs: [] },
    };
  }
  return null;
}

export function RubatoComposerField({
  dictating,
  lineHeight,
  minLines = 1,
  maxLines = 6,
  expand,
  style,
  ...props
}: RubatoComposerFieldProps) {
  const ink = rgbaOf(StyleSheet.flatten(props.textStyle)?.color) ?? [0, 0, 0, 1];
  const live = useLiveDictationDisplay(dictating, props.value, props.selection, ink);
  const inset = props.contentInsetVertical ?? 0;
  const minHeight = minLines * lineHeight + inset * 2;
  const maxHeight = maxLines * lineHeight + inset * 2;
  const [contentHeight, setContentHeight] = useState(0);
  const height = Math.min(maxHeight, Math.max(minHeight, Math.ceil(contentHeight)));
  const overflows = contentHeight > maxHeight + 1;
  const [fullScreen, setFullScreen] = useState(false);
  // A dictation the person changed is reported once the draft goes out (the Mac keeps the fixed words
  // for the user dream's dictation vocabulary); another draft starts afresh.
  const edits = useRef(createDictationEdits());
  const dictatingRef = useRef(dictating);
  dictatingRef.current = dictating;
  useEffect(() => onDictated((text) => {
    if (dictatingRef.current) edits.current.dictated(text);
  }), []);
  useEffect(() => edits.current.reset(), [props.draftKey]);
  useEffect(() => {
    const report = edits.current.draft(props.value);
    if (report) reportDictationEdits(report);
  }, [props.value]);
  useEffect(() => {
    if (dictating) setFullScreen(false);
  }, [dictating]);

  return (
    <View className="relative">
      <ComposerEditor
        {...props}
        value={live?.value ?? props.value}
        selection={live?.selection ?? props.selection}
        dictation={live?.dictation ?? null}
        readOnly={props.readOnly || dictating}
        // The display is not the draft: nothing it does may reach the draft's selection.
        onSelectionChange={dictating ? undefined : props.onSelectionChange}
        scrollEnabled
        onTextHeightChange={(size) => setContentHeight(size.height)}
        style={[style, { height, minHeight: undefined, maxHeight: undefined }]}
      />
      {expand && overflows && !dictating ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={EXPAND_LABELS.open}
          hitSlop={10}
          onPress={() => setFullScreen(true)}
          className="absolute right-0 top-0 h-7 w-7 items-center justify-center rounded-full bg-subtle active:opacity-60"
        >
          <SymbolView
            name="arrow.up.left.and.arrow.down.right"
            size={12}
            weight="semibold"
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
      ) : null}
      {expand ? (
        <FullScreenComposer
          visible={fullScreen}
          onClose={() => setFullScreen(false)}
          editor={props}
          send={expand}
        />
      ) : null}
    </View>
  );
}

/** The draft over the whole screen: a collapse control, the editor, and send above the keyboard. */
function FullScreenComposer(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly editor: ComposerEditorProps;
  readonly send: NonNullable<RubatoComposerFieldProps["expand"]>;
}) {
  const insets = useSafeAreaInsets();
  const { ref: _inlineRef, style: _inlineStyle, ...editor } = props.editor;
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row justify-end px-4 pt-4">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={EXPAND_LABELS.close}
            hitSlop={10}
            onPress={props.onClose}
            className="h-8 w-8 items-center justify-center rounded-full bg-subtle active:opacity-60"
          >
            <SymbolView
              name="arrow.down.right.and.arrow.up.left"
              size={13}
              weight="semibold"
              tintColorClassName="accent-icon-muted"
            />
          </Pressable>
        </View>
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <View className="flex-1 px-5 pt-1">
            <ComposerEditor {...editor} autoFocus scrollEnabled style={{ flex: 1 }} />
          </View>
          <View
            className="flex-row justify-end px-4 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <ComposerActionButton
              accessibilityLabel={props.send.sendLabel}
              icon="arrow.up"
              variant="primary"
              disabled={!props.send.canSend}
              onPress={() => {
                props.onClose();
                props.send.onSend();
              }}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
