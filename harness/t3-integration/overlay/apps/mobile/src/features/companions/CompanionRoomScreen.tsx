// A companion's room, made after Messages (user 76b939e4): measures in roomLayout.ts, colors in
// roomColors.ts, motion in RoomMotion.tsx. It is the companion's T3 thread; what the person sends
// while the companion works steers into that work (user item 6b6a88c5), and the typing bubble
// stands while the person's turn runs (roomLive.ts). A change the companion proposes to itself
// shows as a card to apply, a new companion's first conversation shows its progress as chips under
// the header, and the face or name at the top opens its profile, where its picture changes
// (intent companion-manage).
import { CommonActions, useIsFocused, useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Pressable, ScrollView, useWindowDimensions, View, type FlatList, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeInDown,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { KeyboardAvoidingView, KeyboardStickyView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { initialWindowMetrics, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { Toolbar } from "../../components/ui/Toolbar";
import { ComposerAttachmentButton } from "../threads/ComposerAttachmentButton";
import { ComposerAttachmentThumbnail } from "../../components/ComposerAttachmentStrip";
import type { FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { composerStripAttachments } from "../../lib/composerImages";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useAppActive } from "../../lib/appState";
import { startRoomPoll } from "./roomPoll";
import type { ComposerEditorHandle, ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useComposerDraft } from "../../state/use-composer-drafts";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { appendPendingThreadMessages } from "../threads/pending-thread-feed";
import { ComposerDictationPrimaryAction } from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { RubatoComposerField } from "../rubato-voice/RubatoComposerField";
import { RubatoDictationStrip } from "../rubato-voice/RubatoDictationStrip";
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
import { forgetCompanionArt, useCompanion, type CompanionEntry } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { EdgeFade } from "./EdgeFade";
import { OnboardingChips } from "./OnboardingChips";
import { ProposalCard } from "./ProposalCard";
import type { Proposal } from "./proposalModel";
import { isClosedProposal, isStaleProposal, proposalActions, useProposals } from "./proposalsStore";
import { takeRoomRequest, useRoomRequest } from "./roomRequests";
import { SENT_FOREGROUND, sentBubbleColor } from "./roomColors";
import {
  BUBBLE_LINE_RATIO,
  BUBBLE_MAX_WIDTH,
  BUBBLE_PADDING_X,
  BUBBLE_PADDING_Y,
  BUBBLE_RADIUS,
  COMPOSER_HEIGHT,
  COMPOSER_SIDE,
  COMPOSER_SIDE_TYPING,
  GAP_BEFORE_GROUP,
  GAP_IN_GROUP,
  HEADER_AVATAR,
  HEADER_DEPTH,
  HEADER_NAME_HEIGHT,
  ROOM_SIDE,
} from "./roomLayout";
import { useRoomLiveWork } from "./roomLive";
import { useRoomMedia, type RoomMedia } from "./roomMedia";
import { companionTyping, roomItems, separatorParts, typedSoFar, type RoomItem, type RoomMessageInput } from "./roomModel";
import {
  CompanionTypingBubble,
  hapticReceive,
  hapticSend,
  receivedEntering,
  ROOM_SPRING,
  sentEntering,
  TIME_REVEAL,
  usePendingFade,
  useRevealStyle,
} from "./RoomMotion";

export type CompanionRoomParams = {
  readonly companionId: string;
  readonly environmentId?: string;
  readonly threadId?: string;
};

const LOCALE = phoneLocale();
/**
 * The status bar's height, from the window: inside a screen whose stack bar shows, the screen's own
 * top inset also counts the bar, which pushed the face and the blur down over the messages.
 */
const STATUS_TOP = initialWindowMetrics?.insets.top ?? 59;
const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" });

/** The two bubble colors and the words on the companion's. */
type BubbleColors = { readonly sent: string; readonly received: string; readonly receivedText: string };
type BodyText = { readonly fontSize: number; readonly lineHeight: number };

/** A companion's calls for its room, fetched again when a call this phone saw ends, and every so often. */
function useRoomCalls(environmentId: EnvironmentId | null, companionId: string, visible: boolean) {
  const { version, current } = useCallView();
  const [calls, setCalls] = useState<readonly CallRecord[]>([]);
  const onCall = current !== null;
  useEffect(() => {
    if (!visible || environmentId === null) return;
    let lastJson = "";
    return startRoomPoll(onCall ? 5_000 : 30_000, async (signal) => {
      const list = await callApi.calls(environmentId, companionId, undefined, signal);
      if (signal.aborted) return;
      const nextJson = JSON.stringify(list);
      if (nextJson === lastJson) return;
      lastJson = nextJson;
      setCalls(list);
    });
  }, [environmentId, companionId, version, onCall, visible]);
  return calls;
}

/**
 * Messages' soft top edge: the conversation blurs and darkens as it goes under the header. Blur
 * views stacked, each a little shorter, make the blur grow toward the top; the screen color fades
 * over them.
 */
function TopEdge(props: { readonly height: number }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: props.height + 24 }}>
      {[1, 0.82, 0.64].map((share) => (
        <BlurView key={share} intensity={10} tint="default" style={{ position: "absolute", left: 0, right: 0, top: 0, height: props.height * share }} />
      ))}
      <EdgeFade edge="top" height={props.height + 24} solid={0.3} />
    </View>
  );
}

/**
 * The face with its name in a glass pill under it, over the stack's own transparent bar: the bar
 * keeps iOS's glass back button, the call button and the swipe back (hiding the bar turns UIKit's
 * swipe back off; user b29122dd, a127a93e). Messages lays its header out the same way. The name
 * pill opens the profile, where the picture changes; the face sits over the bar, which takes taps
 * there.
 */
function RoomHeader(props: {
  readonly companion: CompanionEntry | null;
  readonly title: string;
  readonly onProfile: () => void;
  /** What hangs under the header (a first conversation's chips): the soft edge reaches past it. */
  readonly below: number;
}) {
  // The window's status bar height: with the bar shown, the safe-area top counts the bar too (f32806572).
  const top = STATUS_TOP;
  const named = props.companion === null || props.companion.macTitle !== null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: 0, height: top + HEADER_DEPTH + props.below + 24 }}>
      <TopEdge height={top + HEADER_DEPTH + props.below} />
      <View pointerEvents="box-none" accessibilityRole="header" accessibilityLabel={props.title} style={{ position: "absolute", left: 0, right: 0, top: top - 1.5, alignItems: "center" }}>
        <CompanionAvatar art={props.companion?.art ?? null} title={named ? props.title : "?"} size={HEADER_AVATAR} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.title}, ${copy.profile}`}
          onPress={props.onProfile}
          hitSlop={8}
          className="active:opacity-70"
        >
        <GlassSurface
          chrome="none"
          style={{ marginTop: -3, height: HEADER_NAME_HEIGHT, borderRadius: HEADER_NAME_HEIGHT / 2, paddingLeft: 14, paddingRight: 11, flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Text numberOfLines={1} className="font-t3-bold text-foreground" style={{ fontSize: 17, lineHeight: 21, maxWidth: 220 }}>
            {props.title}
          </Text>
          <SymbolView name="chevron.right" size={10} weight="bold" tintColorClassName="accent-icon-muted" />
        </GlassSurface>
        </Pressable>
      </View>
    </View>
  );
}

/** A time line: the day in bold, then the time, as Messages writes it. */
function TimeLine(props: { readonly at: number }) {
  // Today and yesterday as of when the line came into view.
  const [now] = useState(() => Date.now());
  const { day, time } = separatorParts(props.at, now, LOCALE);
  return (
    <Text className="text-center text-foreground-muted" style={{ fontSize: 12, lineHeight: 15, marginTop: 14, marginBottom: -1 }}>
      <Text className="font-t3-bold text-foreground-muted" style={{ fontSize: 12, lineHeight: 15 }}>{day}</Text> {time}
    </Text>
  );
}

/** The path of Messages' tail (iOS 26), drawn from the bubble's bottom right corner, measured from a screenshot. */
const TAIL_PATH = "M0,-19 C0,-10.5 -2.4,-5.2 -9.6,-0.6 C-9.9,2.2 -9.1,4.6 -7.6,5.9 C-8.2,6.7 -9.6,6.6 -11,5.9 L-21,0 L-21,-19 Z";

function BubbleTail(props: { readonly mine: boolean; readonly color: string }) {
  return (
    <Svg
      width={24}
      height={26}
      viewBox="-22 -19 24 26"
      pointerEvents="none"
      style={{ position: "absolute", bottom: -7, ...(props.mine ? { right: -2 } : { left: -2, transform: [{ scaleX: -1 }] }) }}
    >
      <Path d={TAIL_PATH} fill={props.color} />
    </Svg>
  );
}

function RoomRow(props: {
  readonly item: RoomItem;
  readonly companion: CompanionEntry | null;
  readonly title: string;
  readonly environmentId: string;
  readonly body: BodyText;
  readonly colors: BubbleColors;
  readonly media: RoomMedia;
  /** Arrived while the room is open: it moves in instead of just being there. */
  readonly fresh: boolean;
  readonly threadKey: string;
  /** Sending the edit under way drops this row: the edited message or one after it. */
  readonly dropped: boolean;
  readonly reveal: SharedValue<number>;
  readonly busyProposal: string | null;
  readonly onProposal: (proposal: Proposal, action: "apply" | "more" | "decline" | "again") => void;
}) {
  const { item } = props;
  const slide = useRevealStyle(props.reveal);
  if (item.kind === "separator") return <TimeLine at={item.at} />;
  if (item.kind === "proposal")
    return (
      <Animated.View style={[{ marginTop: GAP_BEFORE_GROUP }, slide]}>
        <ProposalCard
          proposal={item.proposal}
          body={props.body}
          busy={props.busyProposal === item.proposal.id}
          onApply={() => props.onProposal(item.proposal, "apply")}
          onMore={() => props.onProposal(item.proposal, "more")}
          onDecline={() => props.onProposal(item.proposal, "decline")}
          onAskAgain={() => props.onProposal(item.proposal, "again")}
        />
        <RowTime at={item.at} />
      </Animated.View>
    );
  if (item.kind === "call")
    return (
      <Animated.View style={[{ marginTop: GAP_BEFORE_GROUP, opacity: item.call.status === "ringing" ? 0.7 : 1 }, slide]}>
        <CallCard call={item.call} title={props.title} art={props.companion?.art ?? null} environmentId={props.environmentId} />
        <RowTime at={item.at} />
      </Animated.View>
    );
  const bubble = <Bubble {...props} item={item} />;
  const dimmed = props.dropped ? <View style={{ opacity: 0.35 }}>{bubble}</View> : bubble;
  const mine = item.side === "me";
  return (
    <Animated.View style={[{ marginTop: item.groupStart ? GAP_BEFORE_GROUP : GAP_IN_GROUP }, slide]}>
      {/* The person's own sent words: a long press offers to edit (rewinding to here) or copy them. */}
      {mine && item.pending === null ? (
        // The menu hugs the bubble, so iOS lifts just the bubble.
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
      ) : (
        dimmed
      )}
      {item.part === 0 ? <RowTime at={item.at} /> : null}
    </Animated.View>
  );
}

/** A message's time, just past the room's right edge: the drag to the left brings it in. */
function RowTime(props: { readonly at: number }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, right: -TIME_REVEAL, width: TIME_REVEAL - 8, justifyContent: "center" }}>
      <Text className="text-right text-foreground-muted" style={{ fontSize: 11.5, lineHeight: 14 }} numberOfLines={1}>
        {timeFormat.format(props.at)}
      </Text>
    </View>
  );
}

function Bubble(props: {
  readonly item: Extract<RoomItem, { kind: "bubble" }>;
  readonly environmentId: string;
  readonly body: BodyText;
  readonly colors: BubbleColors;
  readonly media: RoomMedia;
  readonly fresh: boolean;
}) {
  const { item } = props;
  const mine = item.side === "me";
  // In points: a percentage would be of the long-press menu around the person's bubble, which
  // takes its size from the bubble.
  const { width } = useWindowDimensions();
  const fade = usePendingFade(item.pending !== null);
  const color = mine ? props.colors.sent : props.colors.received;
  return (
    <Animated.View
      entering={props.fresh ? (mine ? sentEntering : receivedEntering) : undefined}
      style={[
        {
          alignSelf: mine ? "flex-end" : "flex-start",
          maxWidth: Math.floor(width * BUBBLE_MAX_WIDTH),
          // A bubble grows from its tail, as in Messages.
          transformOrigin: mine ? "right bottom" : "left bottom",
        },
        fade,
      ]}
    >
      {item.groupEnd ? <BubbleTail mine={mine} color={color} /> : null}
      <View
        style={{
          gap: 8,
          backgroundColor: color,
          borderRadius: BUBBLE_RADIUS,
          paddingHorizontal: BUBBLE_PADDING_X,
          paddingVertical: BUBBLE_PADDING_Y,
        }}
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
          <Text selectable={!mine} style={[props.body, { color: mine ? SENT_FOREGROUND : props.colors.receivedText }]}>
            {item.text || "…"}
          </Text>
        ) : null}
        {item.files ? <BubbleFiles files={item.files} body={props.body} mine={mine} media={props.media} /> : null}
      </View>
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

/** Messages' send: a filled circle in the person's bubble color, an arrow up in white. */
function SendButton(props: { readonly color: string; readonly disabled: boolean; readonly onPress: () => void }) {
  return (
    <Animated.View entering={ZoomIn.springify().damping(ROOM_SPRING.damping).stiffness(ROOM_SPRING.stiffness)} exiting={ZoomOut.duration(120)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.send}
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        onPress={props.onPress}
        hitSlop={6}
        className="items-center justify-center active:opacity-70"
        style={{ width: 31, height: 31, borderRadius: 15.5, backgroundColor: props.color, opacity: props.disabled ? 0.45 : 1 }}
      >
        <SymbolView name="arrow.up" size={15} weight="bold" tintColor={SENT_FOREGROUND} />
      </Pressable>
    </Animated.View>
  );
}

/**
 * Messages' composer: a + circle, then one glass field whose right end is dictation, with send
 * beside it once the field holds something (dictating more onto a draft stays one tap away, as in
 * ChatGPT's). Its sides narrow when the keyboard comes up, as Messages' do. Dictation writes the
 * heard words into the field as they come; its strip opens under the words inside the field.
 */
function RoomComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onPasteImages: (uris: ReadonlyArray<string>) => Promise<unknown>;
  readonly onPasteText: (paste: ComposerTextPaste) => Promise<unknown>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  readonly ownerKey: string | null;
  readonly title: string;
  readonly body: BodyText;
  readonly sendColor: string;
  readonly onHeight: (height: number) => void;
  readonly threadKey: string;
  /** Bumped to bring the keyboard up on the field ("더 고쳐줘", the profile's drawing request). */
  readonly focusRequest: number;
  readonly placeholder: string;
}) {
  const insets = useSafeAreaInsets();
  // Text changes on every keystroke and dictation partial. Only the field needs them.
  const { text: draft, attachments } = useComposerDraft(props.ownerKey);
  // Where the person put the caret in this room; until then the end. A caret placed in an empty field
  // says nothing about a draft that arrives later (drafts load from storage after the first render),
  // and one past the draft's end belongs to a sent draft: both read as the end. A caret left at 0
  // put dictation in front of a restored draft.
  type Placed = { readonly ownerKey: string | null; readonly start: number; readonly end: number; readonly inEmpty: boolean };
  const [placed, setPlaced] = useState<Placed | null>(null);
  const setSelection = (next: { start: number; end: number }) =>
    setPlaced({ ownerKey: props.ownerKey, start: next.start, end: next.end, inEmpty: draftRef.current.length === 0 });
  const selection = placed !== null && placed.ownerKey === props.ownerKey && placed.end <= draft.length &&
    !(placed.inEmpty && draft.length > 0)
    ? { start: placed.start, end: placed.end }
    : { start: draft.length, end: draft.length };
  const [height, setHeight] = useState(insets.bottom + 56);
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
  useEffect(() => {
    if (props.focusRequest === 0) return;
    const end = draftRef.current.length;
    setSelection({ start: end, end });
    editorRef.current?.focus();
  }, [props.focusRequest]);
  const foreground = useUniwindTheme()["--color-foreground"];
  const hasText = draft.trim().length > 0 || attachments.length > 0;
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
  }, [phase, draft, props.onSend]);
  const strip = composerStripAttachments(attachments, () => undefined);
  // Above the home indicator as Messages sits; above the keyboard by the same 16 pt as its sides.
  const bottomPadding = Math.max(insets.bottom - 6, 12);
  const keyboard = useReanimatedKeyboardAnimation();
  const sides = useAnimatedStyle(() => {
    const side = interpolate(keyboard.progress.value, [0, 1], [COMPOSER_SIDE, COMPOSER_SIDE_TYPING]);
    return { paddingLeft: side, paddingRight: side };
  });
  const fieldInset = (COMPOSER_HEIGHT - props.body.lineHeight) / 2;
  return (
    // The screen's keyboard padding moves the list only: an absolute child is placed from the
    // padding box, under the keyboard. The composer rides the keyboard as the thread's does.
    <KeyboardStickyView
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      offset={{ closed: 0, opened: bottomPadding - COMPOSER_SIDE_TYPING }}
      onLayout={(event) => {
        setHeight(event.nativeEvent.layout.height);
        props.onHeight(event.nativeEvent.layout.height);
      }}
    >
      <EdgeFade edge="bottom" height={height + 18} solid={0.35} />
      <Animated.View style={[{ paddingBottom: bottomPadding, paddingTop: 8 }, sides]}>
        <RoomComposerError threadKey={props.threadKey} />
        <SentMessageEditBanner threadKey={props.threadKey} labels={ROOM_EDIT_LABELS} />
        {strip.length > 0 ? (
          <View className="mb-2 flex-row gap-2" style={{ paddingLeft: COMPOSER_HEIGHT + 12 }}>
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
        <View className="flex-row items-end" style={{ gap: 12 }}>
          <GlassSurface chrome="none" style={{ width: COMPOSER_HEIGHT, height: COMPOSER_HEIGHT, borderRadius: COMPOSER_HEIGHT / 2 }}>
            <View className="h-full w-full items-center justify-center">
              <ComposerAttachmentButton supportsFiles={props.supportsFiles} onPickMedia={props.onPickMedia} onPickFiles={props.onPickFiles} />
            </View>
          </GlassSurface>
          <GlassSurface chrome="none" style={{ flex: 1, minHeight: COMPOSER_HEIGHT, borderRadius: COMPOSER_HEIGHT / 2 }}>
            <View style={{ paddingLeft: 16, paddingRight: 4 }}>
              <RubatoComposerField
                ref={editorRef}
                dictating={dictation.isBusy}
                lineHeight={props.body.lineHeight}
                expand={{ sendLabel: copy.send, canSend: hasText && !dictation.blocksSubmission, onSend: props.onSend }}
                draftKey={props.ownerKey}
                environmentId={props.environmentId}
                multiline
                value={draft}
                selection={selection}
                onChangeText={props.onChange}
                onSelectionChange={setSelection}
                onPasteImages={(uris) => void props.onPasteImages(uris)}
                onPasteText={(paste) => void props.onPasteText(paste)}
                placeholder={props.placeholder}
                contentInsetVertical={fieldInset}
                textStyle={{ ...props.body, color: foreground }}
                trailing={
                  <View className="flex-row items-center" style={{ height: COMPOSER_HEIGHT, minWidth: 31, marginLeft: 6 }}>
                    {!dictating ? (
                      // The microphone's 44 pt target leans into the gap before send.
                      <View style={hasText ? { marginRight: -4 } : undefined}>
                        <ComposerDictationPrimaryAction
                          state={dictation.state}
                          presentation={presentation}
                          isAvailable={dictation.isAvailable}
                          onStart={dictation.start}
                          onConfirm={() => void dictation.stop()}
                          onCancel={dictation.cancel}
                        />
                      </View>
                    ) : null}
                    {hasText && !dictating ? (
                      <SendButton color={props.sendColor} disabled={dictation.blocksSubmission} onPress={props.onSend} />
                    ) : null}
                  </View>
                }
              />
            </View>
            {dictating ? (
              <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOut.duration(140)} style={{ paddingHorizontal: 4, paddingBottom: 2 }}>
                <RubatoDictationStrip
                  state={dictation.state}
                  presentation={presentation}
                  audioLevels={dictation.audioLevels}
                  elapsedSeconds={dictation.elapsedSeconds}
                  onCancel={dictation.cancel}
                  onStop={() => void dictation.stop()}
                  trailing={dictation.state.phase === "error" ? null : (
                    <View style={{ marginHorizontal: 6 }}>
                      <SendButton color={props.sendColor} disabled={dictation.state.phase !== "recording"} onPress={sendWhenDictated} />
                    </View>
                  )}
                />
              </Animated.View>
            ) : null}
          </GlassSurface>
        </View>
      </Animated.View>
    </KeyboardStickyView>
  );
}

/**
 * The room's list, registered with the screen as threads register theirs, with every scroll edge
 * effect off: left to find it on its own, UIKit read the inverted list from the wrong end and
 * blurred the whole room. The room draws its own edges (TopEdge, the composer's fade).
 */
const NO_EDGE_EFFECTS = { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" } as const;
const ROOM_EDIT_LABELS: SentMessageLabels = { edit: copy.edit, copy: copy.copyMessage, editing: copy.editing, cancel: copy.cancel };
const ROW_LAYOUT = LinearTransition.springify().damping(ROOM_SPRING.damping).stiffness(ROOM_SPRING.stiffness).mass(ROOM_SPRING.mass);
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
  /** What stands under the header besides it (a first conversation's chips). */
  readonly topInset: number;
}) {
  // A room starts no side chats; its follow-ups steer the companion's work (user item 6b6a88c5).
  const composer = useThreadComposerState({ followUpBehavior: "steer", startSideChat: async () => false });
  const { selectedEnvironmentRuntime } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const scaled = useScaledTextRole("body");
  // Messages' words: the body size, set closer than a thread's.
  const body = useMemo<BodyText>(() => ({ fontSize: scaled.fontSize, lineHeight: Math.round(scaled.fontSize * BUBBLE_LINE_RATIO) }), [scaled.fontSize]);
  const { media, modals } = useRoomMedia({
    environmentId: props.environmentId,
    threadId: props.threadId,
    workspaceRoot: selectedThreadCwd ?? null,
  });
  const supportsFiles = Boolean(selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments);
  const [composerHeight, setComposerHeight] = useState(80);
  const title = props.companion?.title ?? props.companionId;
  const focused = useIsFocused();
  const active = useAppActive();
  const visible = focused && active;
  const calls = useRoomCalls(props.environmentId, props.companionId, visible);
  const proposals = useProposals(props.environmentId, props.companionId, visible);
  const [focusRequest, setFocusRequest] = useState(0);
  const [placeholder, setPlaceholder] = useState<string>(copy.placeholder);
  const focusComposer = useCallback((text: string | null, hint: string = copy.placeholder) => {
    if (text !== null) composer.onChangeDraftMessage(text);
    setPlaceholder(hint);
    setFocusRequest((value) => value + 1);
  }, [composer]);
  // Another screen's request for the field (the profile's "ask it to draw"), taken once.
  const request = useRoomRequest(props.environmentId, props.companionId);
  useEffect(() => {
    if (request === null) return;
    takeRoomRequest(props.environmentId, props.companionId, request.id);
    focusComposer(request.text);
  }, [request, props.environmentId, props.companionId, focusComposer]);
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const onProposal = useCallback(
    (proposal: Proposal, action: "apply" | "more" | "decline" | "again") => {
      if (action === "more") {
        focusComposer(null, copy.morePlaceholder);
        return;
      }
      if (action === "again") {
        focusComposer(copy.askAgainText);
        return;
      }
      if (busyProposal !== null) return;
      setBusyProposal(proposal.id);
      proposalActions[action](props.environmentId, props.companionId, proposal.id)
        .then(
          () => {
            if (action !== "apply") return;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            if (proposal.kind === "avatar") forgetCompanionArt({ environmentId: props.environmentId, id: props.companionId });
          },
          (error: unknown) => {
            if (isClosedProposal(error)) return;
            if (isStaleProposal(error)) {
              Alert.alert(copy.stale, copy.staleDetail, [
                { text: copy.cancel, style: "cancel" },
                { text: copy.askAgain, onPress: () => focusComposer(copy.askAgainText) },
              ]);
              return;
            }
            Alert.alert(action === "apply" ? copy.applyFailed : copy.saveFailed, error instanceof Error ? error.message : String(error));
          },
        )
        .finally(() => setBusyProposal(null));
    },
    [busyProposal, focusComposer, props.environmentId, props.companionId],
  );
  // What the person sent shows the moment they send it, as a thread shows its outbox: a message
  // waits there until the Mac takes it, and a steer into the companion's work until that work
  // reaches it, and only then does the conversation hold it.
  const messages = useMemo<RoomMessageInput[]>(
    () =>
      appendPendingThreadMessages(composer.selectedThreadFeed, composer.selectedThreadFeed, composer.selectedThreadQueuedMessages)
        .flatMap((entry) =>
          entry.type === "message"
            ? [entry.pendingMessage ? { ...entry.message, pending: { attachments: entry.pendingMessage.attachments } } : entry.message]
            : [],
        ),
    [composer.selectedThreadFeed, composer.selectedThreadQueuedMessages],
  );
  const allItems = useMemo(() => roomItems(messages, calls, Date.now(), proposals), [messages, calls, proposals]);
  // A reply that arrives while the room is open comes in one bubble after another, as if typed, with
  // the typing bubble until its last bubble is in.
  const [clock, setClock] = useState(() => Date.now());
  const typed = useMemo(() => typedSoFar(allItems, clock), [allItems, clock]);
  const items = typed.shown;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the clock moves when the next typed bubble is due
  useEffect(() => {
    if (typed.next === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, typed.next - Date.now()));
    return () => clearTimeout(timer);
  }, [typed.next]);
  const personTurn = companionTyping(items, composer.activeThreadBusy);
  const writing = personTurn || typed.next !== null;
  // Thinking or working: the kind of work the companion's tool does right now, while the person's turn runs.
  const tool = useRoomLiveWork(props.environmentId, props.companionId, visible && personTurn);
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
  const accent = theme["--color-primary"];
  const colors = useMemo<BubbleColors>(
    () => ({ sent: sentBubbleColor(String(accent)), received: theme["--color-grouped-card"], receivedText: theme["--color-foreground"] }),
    [accent, theme],
  );
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
    setPlaceholder(copy.placeholder);
    void composer.onSendMessage();
  }, [composer, toEnd]);
  const reversed = useMemo(() => [...items].reverse(), [items]);
  // Dragging the room left brings each message's time in from the right, as in Messages; it springs
  // back on release. It lets go at the first move to the right and never starts at the left edge, so
  // the back swipe keeps its own (user b29122dd: with failOffsetX 12 the back swipe stopped working).
  const reveal = useSharedValue(0);
  const timeDrag = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: -32 })
        .activeOffsetX(-12)
        .failOffsetX(2)
        .failOffsetY([-10, 10])
        .onUpdate((event) => {
          "worklet";
          const pulled = Math.max(0, -event.translationX);
          reveal.set(pulled <= TIME_REVEAL ? pulled : TIME_REVEAL + (pulled - TIME_REVEAL) * 0.2);
        })
        .onFinalize(() => {
          "worklet";
          reveal.set(withSpring(0, ROOM_SPRING));
        }),
    [reveal],
  );
  const headerHeight = STATUS_TOP + HEADER_DEPTH + props.topInset;
  return (
    <>
      <GestureDetector gesture={timeDrag}>
        <View style={{ flex: 1 }}>
          {/* Inverted: the header component sits at the bottom, the footer at the top. */}
          <Animated.FlatList
            ref={listRef}
            inverted
            // The rows around a bubble that moves in slide to their new places instead of jumping.
            itemLayoutAnimation={ROW_LAYOUT}
            onScroll={onScroll}
            scrollEventThrottle={32}
            data={reversed}
            extraData={[dropped, busyProposal]}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <RoomRow
                item={item}
                companion={props.companion}
                title={title}
                environmentId={props.environmentId}
                body={body}
                colors={colors}
                media={media}
                fresh={seen.current !== null && !seen.current.has(item.id)}
                threadKey={threadKey}
                dropped={dropped.has(item.id)}
                reveal={reveal}
                busyProposal={busyProposal}
                onProposal={onProposal}
              />
            )}
            ListHeaderComponent={
              <View style={{ paddingBottom: composerHeight + 8 }}>
                {writing ? <CompanionTypingBubble tool={tool} bubbleColor={colors.received} dotColor={theme["--color-foreground-muted"]} penColor={theme["--color-foreground"]} /> : null}
              </View>
            }
            ListFooterComponent={<View style={{ height: headerHeight + 10 }} />}
            contentContainerStyle={{ paddingHorizontal: ROOM_SIDE }}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            renderScrollComponent={renderRoomScrollView}
            scrollIndicatorInsets={{ top: composerHeight, bottom: headerHeight }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
        </View>
      </GestureDetector>
      {awayFromEnd ? (
        <Animated.View
          entering={ZoomIn.springify().damping(ROOM_SPRING.damping).stiffness(ROOM_SPRING.stiffness)}
          exiting={ZoomOut.duration(160)}
          pointerEvents="box-none"
          style={{ position: "absolute", alignSelf: "center", bottom: composerHeight + 10 }}
        >
          <GlassSurface chrome="none" style={{ width: 40, height: 40, borderRadius: 20 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={copy.toLatest} onPressIn={toEnd} className="h-full w-full items-center justify-center">
              <SymbolView name={{ ios: "chevron.down", android: "keyboard_arrow_down" }} size={15} weight="semibold" tintColorClassName="accent-icon" />
            </Pressable>
          </GlassSurface>
        </Animated.View>
      ) : null}
      <RoomComposer
        environmentId={props.environmentId}
        supportsFiles={supportsFiles}
        onPickMedia={composer.onPickDraftMedia}
        onPickFiles={composer.onPickDraftFiles}
        onRemoveAttachment={composer.onRemoveDraftImage}
        onPasteImages={composer.onNativePasteImages}
        onPasteText={composer.onNativePasteText}
        onPressPreview={media.onPressPreview}
        onChange={composer.onChangeDraftMessage}
        onSend={send}
        ownerKey={composer.composerDraftKey ?? null}
        title={title}
        body={body}
        sendColor={colors.sent}
        onHeight={setComposerHeight}
        threadKey={threadKey}
        focusRequest={focusRequest}
        placeholder={placeholder}
      />
      {modals}
    </>
  );
}

export function CompanionRoomScreen(_props: StaticScreenProps<CompanionRoomParams>) {
  const route = useRoute<RouteProp<Record<string, CompanionRoomParams>>>();
  const navigation = useNavigation();
  const { companionId, environmentId, threadId } = route.params;
  const { companion, loaded } = useCompanion(companionId, environmentId);
  // A room opened by name (a call, a link) learns its Mac and thread once the list knows them.
  useEffect(() => {
    if (!companion?.threadId) return;
    if (companion.threadId === threadId && companion.environmentId === environmentId) return;
    navigation.setParams({ environmentId: companion.environmentId, threadId: companion.threadId } as never);
  }, [companion?.threadId, companion?.environmentId, threadId, environmentId, navigation]);
  const title = companion?.title ?? companionId;
  const openProfile = useCallback(() => {
    const env = companion?.environmentId ?? environmentId;
    if (!env) return;
    navigation.dispatch(CommonActions.navigate("CompanionProfile", { companionId, environmentId: env }));
  }, [navigation, companion?.environmentId, environmentId, companionId]);
  const onboarding = companion?.onboarding ?? null;
  const [chipsHeight, setChipsHeight] = useState(0);
  const topInset = onboarding ? chipsHeight : 0;
  // The stack's bar stays, transparent and without a title: its back button and swipe back are
  // iOS's own. The face and name are drawn over it (RoomHeader).
  const options = useMemo(
    () => ({
      // No title in the bar: the name stands in its pill under the face.
      title: "",
      unstable_navigationItemStyle: "navigator" as const,
      // UIKit's scroll edge reads the inverted list from the wrong end and blurs the whole room;
      // the room draws its own edge (TopEdge).
      scrollEdgeEffects: NO_EDGE_EFFECTS,
    }),
    [title],
  );
  const callable = companion?.callable ?? null;
  const call = useCallback(() => {
    if (!callable?.ready || !environmentId) {
      Alert.alert(copy.cannotCall, callable?.reason ?? undefined);
      return;
    }
    void callActions.dial(environmentId as EnvironmentId, companionId, title);
  }, [callable, environmentId, companionId, title]);
  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
      <NativeStackScreenOptions options={options} optionsVersion={[title]} />
      {environmentId && threadId ? (
        <RoomBody
          companion={companion}
          companionId={companionId}
          environmentId={environmentId as EnvironmentId}
          threadId={threadId as ThreadId}
          topInset={topInset}
        />
      ) : onboarding ? (
        // A new companion: the Mac is opening its first conversation, which takes a few seconds.
        <LoadingScreen message={copy.waking} />
      ) : loaded && companion && !companion.threadId ? (
        <View className="flex-1 justify-center">
          <EmptyState variant="plain" title={copy.roomMissing} detail={copy.roomMissingDetail} />
        </View>
      ) : (
        <LoadingScreen message={copy.roomLoading} />
      )}
      <RoomHeader companion={companion} title={title} onProfile={openProfile} below={topInset} />
      {onboarding ? (
        <View
          style={{ position: "absolute", top: STATUS_TOP + HEADER_DEPTH, left: 0, right: 0 }}
          onLayout={(event) => setChipsHeight(event.nativeEvent.layout.height)}
        >
          <OnboardingChips onboarding={onboarding} />
        </View>
      ) : null}
      <Toolbar placement="right">
        <Toolbar.Button
          accessibilityLabel={callable?.ready ? copy.call : copy.cannotCall}
          icon="phone.fill"
          onPress={call}
        />
      </Toolbar>
    </KeyboardAvoidingView>
  );
}
