// The long press on a bubble the person sent: iOS lifts it with the native context menu (the
// Messages look) and offers to edit or copy it. Editing hands the words to the composer
// (sentMessageEdit.ts); the banner over the composer says what sending will do and cancels it.
import { useAtomValue } from "@effect/atom-react";
import * as Haptics from "expo-haptics";
import type { ReactElement } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { beginSentMessageEdit, cancelSentMessageEdit, editableText, sentMessageEditsAtom } from "./sentMessageEdit";
import type { MessageId } from "@t3tools/contracts";

export interface SentMessageLabels {
  readonly edit: string;
  readonly copy: string;
  readonly editing: string;
  readonly cancel: string;
}

export const SENT_MESSAGE_LABELS_EN: SentMessageLabels = {
  edit: "Edit",
  copy: "Copy",
  editing: "Editing — sending goes back to this message",
  cancel: "Cancel",
};

export function SentMessageMenu(props: {
  readonly threadKey: string;
  readonly message: { readonly id: MessageId; readonly text: string };
  readonly companion: boolean;
  /** A message that carries files is copied but not edited yet: its files would not come along. */
  readonly editable: boolean;
  readonly labels: SentMessageLabels;
  /** Where the menu sits in the row; the bubble keeps its own width inside it. */
  readonly style?: StyleProp<ViewStyle>;
  readonly contentStyle?: StyleProp<ViewStyle>;
  readonly children: ReactElement;
}) {
  const actions = [
    ...(props.editable ? [{ id: "edit", title: props.labels.edit, image: "pencil" }] : []),
    { id: "copy", title: props.labels.copy, image: "doc.on.doc" },
  ];
  return (
    <Menu
      style={props.style}
      actions={actions}
      shouldOpenOnLongPress
      onMenuInteractionStart={() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined)}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "edit") beginSentMessageEdit(props.threadKey, props.message, props.companion);
        else if (nativeEvent.event === "copy") copyTextWithHaptic(editableText(props.message.text));
      }}
    >
      {/* The long press is the native menu's own; the bubble keeps its links and text selection. */}
      <View style={props.contentStyle}>{props.children}</View>
    </Menu>
  );
}

/** The message under edit, or null: its bubble and the ones after it show what the send drops. */
export function useEditedMessageId(threadKey: string | null): MessageId | null {
  const edits = useAtomValue(sentMessageEditsAtom);
  return threadKey ? (edits[threadKey]?.messageId ?? null) : null;
}

/** Over the composer while a sent message is edited: what sending does, and the way out. */
export function SentMessageEditBanner(props: { readonly threadKey: string | null; readonly labels: SentMessageLabels }) {
  const editing = useEditedMessageId(props.threadKey) !== null;
  if (!editing || !props.threadKey) return null;
  const threadKey = props.threadKey;
  return (
    <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOut.duration(120)}>
      <View className="flex-row items-center gap-2 px-4 pb-2">
        <SymbolView name="pencil" size={12} tintColorClassName="accent-foreground-muted" />
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {props.labels.editing}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.labels.cancel}
          onPress={() => cancelSentMessageEdit(threadKey)}
          hitSlop={8}
          className="min-h-8 justify-center px-1 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-primary">{props.labels.cancel}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
