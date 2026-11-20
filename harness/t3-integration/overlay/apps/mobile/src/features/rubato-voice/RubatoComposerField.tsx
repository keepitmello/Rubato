// Rubato: the phone composers' text field (thread and companion room), as ChatGPT's works.
//
// - It grows with its text from `minLines` to `maxLines`, then scrolls. T3's field sat between
//   fixed heights because nothing read the native editor's content height; this reads it
//   (T3ComposerEditorView emits it as onComposerContentSizeChange).
// - Past `maxLines` an expand control appears at its top right and opens the draft full screen,
//   with its own send.
// - While live dictation runs for this composer, the editor shows the draft with the words heard
//   so far where the final text will land, all grey with the newest words blue, the caret after
//   them. It stays the draft's editor, read-only, so the keyboard stays up; the final text goes
//   into the draft through T3's controller at stop (client-runtime rubatoLiveDictationDisplay.ts).
import { liveDictationDisplay, type LiveDictationDisplay } from "@t3tools/client-runtime/voice-input";
import {
  LIVE_FRESH_MS,
  liveDictationStore,
  liveDictationView,
} from "@t3tools/shared/rubatoLiveDictation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { ComposerEditor, type ComposerEditorProps } from "../../components/ComposerEditor";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import type { ComposerEditorSelection } from "../../native/T3ComposerEditor.types";

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

function useLiveDictationDisplay(
  active: boolean,
  draft: string,
  selection: ComposerEditorSelection | undefined,
): LiveDictationDisplay | null {
  const snapshot = useSyncExternalStore(liveDictationStore.subscribe, liveDictationStore.snapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (active) setNow(Date.now());
  }, [active, snapshot]);
  const view = liveDictationView(snapshot, now);
  // Blue turns grey a moment after the newest word: tick only while something is blue.
  useEffect(() => {
    if (!active || view.fresh.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), LIVE_FRESH_MS / 4);
    return () => clearTimeout(timer);
  }, [active, view.fresh, now]);
  if (!active) return null;
  return liveDictationDisplay(draft, selection ?? { start: draft.length, end: draft.length }, view);
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
  const live = useLiveDictationDisplay(dictating, props.value, props.selection);
  const inset = props.contentInsetVertical ?? 0;
  const minHeight = minLines * lineHeight + inset * 2;
  const maxHeight = maxLines * lineHeight + inset * 2;
  const [contentHeight, setContentHeight] = useState(0);
  const height = Math.min(maxHeight, Math.max(minHeight, Math.ceil(contentHeight)));
  const overflows = contentHeight > maxHeight + 1;
  const [fullScreen, setFullScreen] = useState(false);
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
