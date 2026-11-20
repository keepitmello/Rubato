// A companion's room: its face and name at the top, the conversation as bubbles with each call as a
// card, and a composer with dictation and a call button (user 3ec923c9; Pickle is the reference for
// layout and finish, the look is iOS Liquid Glass in the user's theme, intent rubato-ios-app rev 2).
// The header and composer float on glass over the conversation, which fades under them.
// The room is the companion's T3 thread; sending goes through the thread's own composer state. What
// the person sends while the companion works steers into that work, since the room never shows it
// (user item 6b6a88c5).
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Pressable, ScrollView, useWindowDimensions, View, type FlatList, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import Animated, { FadeInDown, FadeOut, LinearTransition, ZoomIn, ZoomOut } from "react-native-reanimated";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import { ComposerAttachmentThumbnail } from "../../components/ComposerAttachmentStrip";
import { ControlPill } from "../../components/ui/ControlPill";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import type { FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { composerStripAttachments, type DraftComposerAttachment } from "../../lib/composerImages";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { ComposerEditorHandle, ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useComposerDraft } from "../../state/use-composer-drafts";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { ComposerSurface } from "../../components/ComposerSurface";
import { appendPendingThreadMessages } from "../threads/pending-thread-feed";
import {
  ComposerDictationPrimaryAction,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { RubatoComposerField } from "../rubato-voice/RubatoComposerField";
import { RubatoDictationStrip, RubatoDictationToolbar } from "../rubato-voice/RubatoDictationStrip";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useAtomValue } from "@effect/atom-react";
import { clearThreadComposerError, threadComposerErrorsAtom } from "../../state/thread-composer-error";
import { SentMessageEditBanner, SentMessageMenu, useEditedMessageId, type SentMessageLabels } from "../rubato-message-edit/SentMessageMenu";
import { BubbleAttachments } from "./BubbleAttachments";
import { BubbleFiles } from "./BubbleFiles";
import { BubbleMarkdown } from "./BubbleMarkdown";
import { CallCard } from "./CallCard";
import { callActions, callApi, useCallView, type CallRecord } from "./callStore";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion, type CompanionEntry } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { EdgeFade } from "./EdgeFade";
import { useRoomMedia, type RoomMedia } from "./roomMedia";
import { companionIsWriting, companionTool, roomItems, type RoomItem, type RoomMessageInput, type RoomStep } from "./roomModel";
import {
  CompanionWorkIndicator,
  hapticReceive,
  hapticSend,
  receivedEntering,
  ROOM_SPRING,
  sentEntering,
  usePendingFade,
} from "./RoomMotion";

export type CompanionRoomParams = {
  readonly companionId: string;
  readonly environmentId?: string;
  readonly threadId?: string;
};

const separatorFormat = new Intl.DateTimeFormat(phoneLocale(), { month: "long", day: "numeric", weekday: "short" });
const timeFormat = new Intl.DateTimeFormat(phoneLocale(), { hour: "numeric", minute: "2-digit" });
const separatorText = (at: number) =>
  new Date(at).toDateString() === new Date().toDateString()
    ? timeFormat.format(at)
    : `${separatorFormat.format(at)} ${timeFormat.format(at)}`;

/** A companion's calls for its room, fetched again when a call this phone saw ends, and every so often. */
function useRoomCalls(environmentId: EnvironmentId | null, companionId: string) {
  const { version, current } = useCallView();
  const [calls, setCalls] = useState<readonly CallRecord[]>([]);
  const onCall = current !== null;
  useEffect(() => {
    if (environmentId === null) return;
    let live = true;
    const load = () =>
      callApi.calls(environmentId, companionId).then(
        (list) => {
          if (live) setCalls(list);
        },
        () => undefined,
      );
    void load();
    const timer = setInterval(load, onCall ? 5_000 : 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environmentId, companionId, version, onCall]);
  return calls;
}

/**
 * The room's title in the native bar, the same bar a thread has: the companion's face over its
 * name, sized to the bar (Pickle's centered layout at the thread title's scale).
 */
function RoomTitle(props: { readonly companion: CompanionEntry | null; readonly title: string }) {
  return (
    <View className="items-center" accessibilityRole="header" accessibilityLabel={props.title}>
      <CompanionAvatar art={props.companion?.art ?? null} title={props.title} size={28} />
      <Text numberOfLines={1} className="mt-0.5 font-t3-bold text-[12px] leading-[14px] text-foreground">
        {props.title}
      </Text>
    </View>
  );
}

/**
 * The band under the transparent bar: the screen color behind the bar, then a short fade, so the
 * conversation goes out of sight under it. (A blur view here blurred the whole room.)
 */
function HeaderBand(props: { readonly height: number }) {
  const fade = 18;
  return <EdgeFade edge="top" height={props.height + fade} solid={props.height / (props.height + fade)} />;
}

function RoomRow(props: {
  readonly item: RoomItem;
  readonly companion: CompanionEntry | null;
  readonly title: string;
  readonly environmentId: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly media: RoomMedia;
  /** Arrived while the room is open: it moves in instead of just being there. */
  readonly fresh: boolean;
  readonly threadKey: string;
  /** Sending the edit under way drops this row: the edited message or one after it. */
  readonly dropped: boolean;
}) {
  const { item } = props;
  if (item.kind === "separator")
    return <Text className="mb-1 mt-4 text-center text-[12px] font-t3-bold text-foreground-muted">{separatorText(item.at)}</Text>;
  if (item.kind === "call")
    return (
      <View className={item.call.status === "ringing" ? "mt-2.5 opacity-70" : "mt-2.5"}>
        <CallCard call={item.call} title={props.title} art={props.companion?.art ?? null} environmentId={props.environmentId} />
      </View>
    );
  const bubble = <Bubble {...props} item={item} />;
  const dimmed = props.dropped ? <View style={{ opacity: 0.35 }}>{bubble}</View> : bubble;
  // The person's own sent words: a long press offers to edit (rewinding to here) or copy them.
  if (item.side !== "me" || item.pending !== null) return dimmed;
  return (
    // The menu hugs the bubble, so iOS lifts just the bubble (the bubble's width is in points).
    <SentMessageMenu
      threadKey={props.threadKey}
      message={{ id: item.id as MessageId, text: item.text }}
      companion
      editable={item.attachments.length === 0 && item.files === "" && item.text !== ""}
      labels={ROOM_EDIT_LABELS}
      style={{ alignSelf: "flex-end" }}
    >
      {dimmed}
    </SentMessageMenu>
  );
}

function Bubble(props: {
  readonly item: Extract<RoomItem, { kind: "bubble" }>;
  readonly environmentId: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly media: RoomMedia;
  readonly fresh: boolean;
}) {
  const { item } = props;
  const mine = item.side === "me";
  // 80% of the room's width inside its 16 pt sides, in points: a percentage would be of the
  // long-press menu around the person's bubble, which takes its size from the bubble.
  const { width } = useWindowDimensions();
  const fade = usePendingFade(item.pending !== null);
  return (
    <Animated.View
      entering={props.fresh ? (mine ? sentEntering : receivedEntering) : undefined}
      className={mine ? "gap-2 self-end rounded-[20px] bg-user-bubble px-3.5 py-2.5" : "gap-2 self-start rounded-[20px] bg-grouped-card px-3.5 py-2.5"}
      style={[
        {
          maxWidth: Math.floor((width - 32) * 0.8),
          marginTop: item.groupStart ? 10 : 2,
          // A bubble grows from its tail, as in Messages.
          transformOrigin: mine ? "right bottom" : "left bottom",
          ...(item.groupEnd ? (mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) : {}),
        },
        fade,
      ]}
    >
      <BubbleAttachments attachments={item.attachments} media={props.media} />
      {item.pending && item.pending.attachments.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {item.pending.attachments.map((attachment) => (
            <ComposerAttachmentThumbnail
              key={attachment.id}
              environmentId={props.environmentId as EnvironmentId}
              attachment={attachment}
              size={item.pending!.attachments.length === 1 ? 180 : 96}
              borderRadius={14}
              onPressPreview={props.media.onPressPreview}
            />
          ))}
        </View>
      ) : null}
      {item.text && !mine ? (
        <BubbleMarkdown markdown={item.text} body={props.body} media={props.media} />
      ) : item.text || (item.streaming && item.attachments.length === 0) ? (
        <Text selectable={!mine} className={mine ? "text-user-bubble-foreground" : "text-foreground"} style={props.body}>
          {item.text || "…"}
        </Text>
      ) : null}
      {item.files ? <BubbleFiles files={item.files} body={props.body} mine={mine} media={props.media} /> : null}
    </Animated.View>
  );
}

/** Why the last send did not go out (an edit that could not rewind, a send the Mac refused). */
function RoomComposerError(props: { readonly threadKey: string }) {
  const error = useAtomValue(threadComposerErrorsAtom)[props.threadKey]?.message ?? null;
  if (error === null) return null;
  return (
    <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOut.duration(120)} className="mb-2 flex-row items-center gap-2 px-3">
      <Text className="min-w-0 flex-1 text-xs text-danger-foreground" numberOfLines={3}>
        {error}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.dismiss} hitSlop={8} onPress={() => clearThreadComposerError(props.threadKey)}>
        <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </Animated.View>
  );
}

/**
 * The thread composer's shell (ComposerSurface, its 44 pt action slots and dictation control) with
 * the room's one difference: an empty field offers the call where a thread offers send.
 */
function RoomComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onPasteImages: (uris: ReadonlyArray<string>) => Promise<unknown>;
  readonly onPasteText: (paste: ComposerTextPaste) => Promise<unknown>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly draft: string;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  readonly canCall: boolean;
  readonly onCall: () => void;
  readonly ownerKey: string | null;
  readonly title: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly onHeight: (height: number) => void;
  readonly threadKey: string;
}) {
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState({ start: props.draft.length, end: props.draft.length });
  const [height, setHeight] = useState(insets.bottom + 64);
  const draftRef = useRef(props.draft);
  draftRef.current = props.draft;
  const dictation = useVoiceInputController({
    ownerKey: props.ownerKey,
    label: props.title,
    readDraftMessage: () => draftRef.current,
    selection,
    onChangeDraftMessage: props.onChange,
    onChangeSelection: setSelection,
  });
  const presentation = resolveVoiceComposerPresentation(dictation.state, dictation.elapsedSeconds);
  const dictating = presentation.statusLabel !== null || dictation.isBusy;
  // Editing a sent message brings its words here: the field opens on them, the cursor at the end.
  const editorRef = useRef<ComposerEditorHandle>(null);
  const editing = useEditedMessageId(props.threadKey);
  useEffect(() => {
    if (editing === null) return;
    const end = draftRef.current.length;
    setSelection({ start: end, end });
    editorRef.current?.focus();
  }, [editing]);
  const foreground = useUniwindTheme()["--color-foreground"];
  const hasText = props.draft.trim().length > 0 || props.attachments.length > 0;
  // Send while dictating, as ChatGPT's: stop, and send once the final text is in the draft.
  const sendAfterDictation = useRef(false);
  const sendWhenDictated = () => {
    sendAfterDictation.current = true;
    void dictation.stop();
  };
  const phase = dictation.state.phase;
  useEffect(() => {
    if (!sendAfterDictation.current || phase === "recording" || phase === "transcribing") return;
    sendAfterDictation.current = false;
    if (phase === "idle") props.onSend();
  }, [phase, props.draft, props.onSend]);
  const strip = composerStripAttachments(props.attachments, () => undefined);
  const bottomPadding = Math.max(insets.bottom, 10);
  return (
    // The screen's keyboard padding moves the list only: an absolute child is placed from the
    // padding box, under the keyboard. The composer rides the keyboard as the thread's does, and
    // above it gives up the home indicator's room, which the keyboard covers.
    <KeyboardStickyView
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      offset={{ closed: 0, opened: bottomPadding - 10 }}
      onLayout={(event) => {
        setHeight(event.nativeEvent.layout.height);
        props.onHeight(event.nativeEvent.layout.height);
      }}
    >
      <EdgeFade edge="bottom" height={height + 16} solid={0.3} />
      <View className="px-4" style={{ paddingBottom: bottomPadding, paddingTop: 6 }}>
        <RoomComposerError threadKey={props.threadKey} />
        <SentMessageEditBanner threadKey={props.threadKey} labels={ROOM_EDIT_LABELS} />
        {strip.length > 0 ? (
          <View className="mb-2 flex-row gap-2 px-1">
            {strip.map((attachment) => (
              <View key={attachment.id}>
                <ComposerAttachmentThumbnail
                  environmentId={props.environmentId}
                  attachment={attachment}
                  size={56}
                  borderRadius={12}
                  onPressPreview={props.onPressPreview}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${copy.remove} ${attachment.name}`}
                  onPress={() => props.onRemoveAttachment(attachment.id)}
                  hitSlop={8}
                  className="absolute -right-1.5 -top-1.5 h-[22px] w-[22px] items-center justify-center rounded-full bg-foreground active:opacity-70"
                >
                  <SymbolView name="xmark" size={10} weight="bold" tintColorClassName="accent-screen" />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {/* ChatGPT's composer (user 2026-11-20): the field across the top, growing with its text up
            to six lines and opening full screen past that (RubatoComposerField); the buttons on a row
            below. While dictation runs the row becomes cancel, the live waveform, stop and send, and
            the heard words are written into the field as they come. */}
        <ComposerSurface style={{ borderRadius: 24, overflow: "hidden", paddingTop: 8, paddingBottom: 4 }}>
          <View className="px-4">
            <RubatoComposerField
              ref={editorRef}
              dictating={dictation.isBusy}
              lineHeight={props.body.lineHeight}
              expand={{ sendLabel: copy.send, canSend: hasText && !dictation.blocksSubmission, onSend: props.onSend }}
              draftKey={props.ownerKey}
              environmentId={props.environmentId}
              multiline
              value={props.draft}
              selection={selection}
              onChangeText={props.onChange}
              onSelectionChange={setSelection}
              onPasteImages={(uris) => void props.onPasteImages(uris)}
              onPasteText={(paste) => void props.onPasteText(paste)}
              placeholder={copy.placeholder}
              contentInsetVertical={6}
              textStyle={{ ...props.body, color: foreground }}
            />
          </View>
          <RubatoDictationToolbar showsDictation={dictating}>
            {dictating ? (
              <RubatoDictationStrip
                state={dictation.state}
                presentation={presentation}
                audioLevels={dictation.audioLevels}
                elapsedSeconds={dictation.elapsedSeconds}
                onCancel={dictation.cancel}
                onStop={() => void dictation.stop()}
                trailing={dictation.state.phase === "error" ? null : (
                  <ComposerActionButton
                    accessibilityLabel={copy.send}
                    icon="arrow.up"
                    variant="primary"
                    disabled={dictation.state.phase !== "recording"}
                    onPress={sendWhenDictated}
                  />
                )}
              />
            ) : (
              <View className="h-[44px] flex-row items-center">
                <ComposerAttachmentButton
                  supportsFiles={props.supportsFiles}
                  onPickMedia={props.onPickMedia}
                  onPickFiles={props.onPickFiles}
                />
                <View className="flex-1" />
                <ComposerDictationPrimaryAction
                  state={dictation.state}
                  presentation={presentation}
                  isAvailable={dictation.isAvailable}
                  onStart={dictation.start}
                  onConfirm={() => void dictation.stop()}
                  onCancel={dictation.cancel}
                />
                {hasText ? (
                  <ComposerActionButton
                    accessibilityLabel={copy.send}
                    icon="arrow.up"
                    variant="primary"
                    disabled={dictation.blocksSubmission}
                    onPress={props.onSend}
                  />
                ) : (
                  <ComposerActionButton
                    accessibilityLabel={props.canCall ? copy.call : copy.cannotCall}
                    icon={{ ios: "phone.fill", android: "smartphone" }}
                    variant="primary"
                    onPress={props.onCall}
                  />
                )}
              </View>
            )}
          </RubatoDictationToolbar>
        </ComposerSurface>
      </View>
    </KeyboardStickyView>
  );
}

/**
 * The room's list, registered with the screen as threads register theirs, with every scroll edge
 * effect off: left to find it on its own, UIKit read the inverted list from the wrong end and
 * blurred the whole room under the transparent bar. The room draws its own band (HeaderBand).
 */
const NO_EDGE_EFFECTS = { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" } as const;
const ROOM_EDIT_LABELS: SentMessageLabels = { edit: copy.edit, copy: copy.copyMessage, editing: copy.editing, cancel: copy.cancel };
const ROW_LAYOUT = LinearTransition.springify().damping(ROOM_SPRING.damping).stiffness(ROOM_SPRING.stiffness);
function RoomScrollView(props: ComponentProps<typeof ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }} scrollEdgeEffects={NO_EDGE_EFFECTS}>
      <ScrollView {...props} />
    </NativeScrollViewMarker>
  );
}
// FlatList clones the element this returns with its scroll props (inversion, padding, ref), so the
// element must be the component that hands them to the ScrollView, not the marker around it.
function renderRoomScrollView(props: ComponentProps<typeof ScrollView>) {
  return <RoomScrollView {...props} />;
}

/** The room once its thread is known: route params carry environmentId and threadId. */
function RoomBody(props: {
  readonly companion: CompanionEntry | null;
  readonly companionId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly headerHeight: number;
}) {
  // A room starts no side chats; its follow-ups steer the companion's work (user item 6b6a88c5).
  const composer = useThreadComposerState({ followUpBehavior: "steer", startSideChat: async () => false });
  const draft = useComposerDraft(composer.composerDraftKey ?? null);
  const { selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const body = useScaledTextRole("body");
  const { media, modals } = useRoomMedia({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: selectedThreadCwd ?? null,
  });
  const supportsFiles = Boolean(selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments);
  const [composerHeight, setComposerHeight] = useState(80);
  const title = props.companion?.title ?? props.companionId;
  const calls = useRoomCalls(props.environmentId, props.companionId);
  // What the person sent shows the moment they send it, as a thread shows its outbox: a message
  // waits there until the Mac takes it, and a steer into the companion's work until that work
  // reaches it, and only then does the conversation hold it.
  const messages = useMemo<RoomMessageInput[]>(
    () =>
      appendPendingThreadMessages(composer.selectedThreadFeed, composer.selectedThreadFeed, composer.selectedThreadQueuedMessages)
        .flatMap((entry) =>
          entry.type === "message"
            ? [{ id: entry.message.id, role: entry.message.role, text: entry.message.text, createdAt: entry.message.createdAt,
                streaming: entry.message.streaming, attachments: entry.message.attachments,
                ...(entry.pendingMessage ? { pending: { attachments: entry.pendingMessage.attachments } } : {}) }]
            : [],
        ),
    [composer.selectedThreadFeed, composer.selectedThreadQueuedMessages],
  );
  const items = useMemo(() => roomItems(messages, calls), [messages, calls]);
  const writing = companionIsWriting(items, composer.activeThreadBusy);
  // Thinking or working: the tool the companion runs since the person's last message.
  const tool = useMemo(
    () =>
      companionTool(
        composer.selectedThreadFeed.flatMap((entry): RoomStep[] =>
          entry.type === "message"
            ? [{ kind: "message", role: entry.message.role }]
            : entry.type === "activity-group"
              ? entry.activities.map((activity) => {
                  const item = activity.projectedItem.item;
                  return {
                    kind: "tool" as const,
                    running: activity.lifecycleStatus === "inProgress",
                    icon: activity.icon,
                    name: item.type === "dynamic_tool" ? item.toolName : null,
                  };
                })
              : [],
        ),
      ),
    [composer.selectedThreadFeed],
  );
  // What the room showed when it opened stays put; what arrives after moves in. A bubble the list
  // recycles back into view later does not move in again.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null && items.length > 0) seen.current = new Set(items.map((item) => item.id));
  useEffect(() => {
    const known = seen.current;
    if (!known) return;
    let received = false;
    for (const item of items) {
      if (known.has(item.id)) continue;
      known.add(item.id);
      if (item.kind === "bubble" && item.side === "companion") received = true;
    }
    if (received) hapticReceive();
  }, [items]);
  const threadKey = scopedThreadKey(props.environmentId, props.threadId);
  const editedId = useEditedMessageId(threadKey);
  // While a sent message is edited, it and everything after it go when the edit is sent.
  const dropped = useMemo(() => {
    const at = editedId === null ? -1 : items.findIndex((item) => item.id === editedId);
    return new Set(at < 0 ? [] : items.slice(at).map((item) => item.id));
  }, [items, editedId]);
  const theme = useUniwindTheme();
  const listRef = useRef<FlatList<RoomItem>>(null);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // The list is inverted: its end, the newest message, is offset 0.
    const away = event.nativeEvent.contentOffset.y > 320;
    setAwayFromEnd((current) => (current === away ? current : away));
  }, []);
  const toEnd = useCallback(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }), []);
  const send = useCallback(() => {
    hapticSend();
    toEnd();
    void composer.onSendMessage();
  }, [composer, toEnd]);
  const reversed = useMemo(() => [...items].reverse(), [items]);
  const callable = props.companion?.callable ?? null;
  const call = useCallback(() => {
    if (!callable?.ready) {
      Alert.alert(copy.cannotCall, callable?.reason ?? undefined);
      return;
    }
    void callActions.dial(props.environmentId, props.companionId, title);
  }, [callable, props.environmentId, props.companionId, title]);
  return (
    <>
      {/* Inverted: the header component sits at the bottom, the footer at the top. */}
      <Animated.FlatList
        ref={listRef}
        inverted
        // The rows around a bubble that moves in slide to their new places instead of jumping.
        itemLayoutAnimation={ROW_LAYOUT}
        onScroll={onScroll}
        scrollEventThrottle={32}
        data={reversed}
        extraData={dropped}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RoomRow
            item={item}
            companion={props.companion}
            title={title}
            environmentId={props.environmentId}
            body={body}
            media={media}
            fresh={seen.current !== null && !seen.current.has(item.id)}
            threadKey={threadKey}
            dropped={dropped.has(item.id)}
          />
        )}
        ListHeaderComponent={
          <View style={{ paddingBottom: composerHeight + 6 }}>
            {writing ? (
              <CompanionWorkIndicator tool={tool} bubbleColor={theme["--color-grouped-card"]} dotColor={theme["--color-foreground-muted"]} />
            ) : null}
          </View>
        }
        ListFooterComponent={<View style={{ height: props.headerHeight + 8 }} />}
        contentContainerStyle={{ paddingHorizontal: 16 }}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        renderScrollComponent={renderRoomScrollView}
        scrollIndicatorInsets={{ top: composerHeight, bottom: props.headerHeight }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
      {awayFromEnd ? (
        <Animated.View
          entering={ZoomIn.springify().damping(ROOM_SPRING.damping).stiffness(ROOM_SPRING.stiffness)}
          exiting={ZoomOut.duration(160)}
          pointerEvents="box-none"
          style={{ position: "absolute", alignSelf: "center", bottom: composerHeight + 10 }}
        >
          <ControlPill
            accessibilityLabel={copy.toLatest}
            activateOnPressIn
            className="h-11 w-11 border border-border bg-glass-fallback shadow-md shadow-black/10"
            icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
            onPress={toEnd}
          />
        </Animated.View>
      ) : null}
      <RoomComposer
        environmentId={props.environmentId}
        attachments={draft.attachments}
        supportsFiles={supportsFiles}
        onPickMedia={composer.onPickDraftMedia}
        onPickFiles={composer.onPickDraftFiles}
        onRemoveAttachment={composer.onRemoveDraftImage}
        onPasteImages={composer.onNativePasteImages}
        onPasteText={composer.onNativePasteText}
        onPressPreview={media.onPressPreview}
        draft={draft.text}
        onChange={composer.onChangeDraftMessage}
        onSend={send}
        canCall={callable?.ready === true}
        onCall={call}
        ownerKey={composer.composerDraftKey ?? null}
        title={title}
        body={body}
        onHeight={setComposerHeight}
        threadKey={threadKey}
      />
      {modals}
    </>
  );
}

export function CompanionRoomScreen(_props: StaticScreenProps<CompanionRoomParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionRoomParams>>>();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // The native bar is transparent over the room; the room lays out below it.
  const headerHeight = useContext(HeaderHeightContext) ?? insets.top + 44;
  const { companionId, environmentId, threadId } = route.params;
  const { companion, loaded } = useCompanion(companionId, environmentId);
  // A room opened by name (a call, a link) learns its Mac and thread once the list knows them.
  useEffect(() => {
    if (!companion?.threadId) return;
    if (companion.threadId === threadId && companion.environmentId === environmentId) return;
    navigation.setParams({ environmentId: companion.environmentId, threadId: companion.threadId } as never);
  }, [companion?.threadId, companion?.environmentId, threadId, environmentId, navigation]);
  const title = companion?.title ?? companionId;
  const options = useMemo(
    () => ({
      title,
      headerTitle: () => <RoomTitle companion={companion} title={title} />,
      // The face and name stand centered over the room (Pickle's layout), not leading as a thread's title.
      unstable_navigationItemStyle: "navigator" as const,
      // UIKit's scroll edge reads the inverted list from the wrong end and blurs the whole room;
      // the room draws its own band under the bar (HeaderBand).
      scrollEdgeEffects: NO_EDGE_EFFECTS,
    }),
    [companion, title],
  );
  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
      <NativeStackScreenOptions options={options} optionsVersion={[title, companion?.art ?? null]} />
      {environmentId && threadId ? (
        <RoomBody
          companion={companion}
          companionId={companionId}
          environmentId={environmentId as EnvironmentId}
          threadId={threadId as ThreadId}
          headerHeight={headerHeight}
        />
      ) : loaded && companion && !companion.threadId ? (
        <View className="flex-1 justify-center">
          <EmptyState variant="plain" title={copy.roomMissing} detail={copy.roomMissingDetail} />
        </View>
      ) : (
        <LoadingScreen message={copy.roomLoading} />
      )}
      <HeaderBand height={headerHeight} />
    </KeyboardAvoidingView>
  );
}
