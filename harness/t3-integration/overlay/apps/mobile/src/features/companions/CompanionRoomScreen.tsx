// A companion's room: its face and name at the top, the conversation as bubbles with each call as a
// card, and a composer with dictation and a call button (user 3ec923c9; Pickle is the reference for
// layout and finish, the look is iOS Liquid Glass in the user's theme, intent rubato-ios-app rev 2).
// The header and composer float on glass over the conversation, which fades under them.
// The room is the companion's T3 thread; sending goes through the thread's own composer state, so a
// message queued while the companion works behaves as in any thread.
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { BlurView } from "expo-blur";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, FlatList, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { ComposerSurface } from "../threads/ThreadComposer";
import { ComposerDictationPrimaryAction } from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import { BubbleMarkdown } from "./BubbleMarkdown";
import { CallCard } from "./CallCard";
import { callActions, callApi, useCallView, type CallRecord } from "./callStore";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion, type CompanionEntry } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { EdgeFade } from "./EdgeFade";
import { companionIsWriting, roomItems, type RoomItem, type RoomMessageInput } from "./roomModel";

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
 * The blurred band under the transparent bar, as threads get it from UIKit's scroll edge: the
 * conversation blurs out under the bar, then a short fade meets the screen color.
 */
function HeaderBand(props: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: props.height + 14 }}>
      <BlurView
        intensity={70}
        tint={themeAppearance === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: props.height }}
      />
      <View style={{ position: "absolute", top: props.height, left: 0, right: 0 }}>
        <EdgeFade edge="top" height={14} solid={0} />
      </View>
    </View>
  );
}

function WritingDots() {
  const pulse = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.3, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <View accessibilityLabel={copy.writing} className="mt-1.5 self-start rounded-[20px] bg-grouped-card px-4 py-2.5">
      <Animated.Text style={{ opacity: pulse, letterSpacing: 3 }} className="text-[18px] text-foreground-muted">
        •••
      </Animated.Text>
    </View>
  );
}

function RoomRow(props: {
  readonly item: RoomItem;
  readonly companion: CompanionEntry | null;
  readonly title: string;
  readonly environmentId: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
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
  const mine = item.side === "me";
  return (
    <View
      className={mine ? "self-end rounded-[20px] bg-user-bubble px-3.5 py-2.5" : "self-start rounded-[20px] bg-grouped-card px-3.5 py-2.5"}
      style={{
        maxWidth: "80%",
        marginTop: item.groupStart ? 10 : 2,
        ...(item.groupEnd ? (mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) : {}),
      }}
    >
      {mine || !item.text ? (
        <Text selectable className={mine ? "text-user-bubble-foreground" : "text-foreground"} style={props.body}>
          {item.text || (item.streaming ? "…" : "")}
        </Text>
      ) : (
        <BubbleMarkdown markdown={item.text} body={props.body} />
      )}
    </View>
  );
}

/**
 * The thread composer's shell (ComposerSurface, its 44 pt action slots and dictation control) with
 * the room's one difference: an empty field offers the call where a thread offers send.
 */
function RoomComposer(props: {
  readonly draft: string;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  readonly canCall: boolean;
  readonly onCall: () => void;
  readonly ownerKey: string | null;
  readonly title: string;
  readonly body: { readonly fontSize: number; readonly lineHeight: number };
  readonly onHeight: (height: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState({ start: props.draft.length, end: props.draft.length });
  const [height, setHeight] = useState(insets.bottom + 64);
  const draftRef = useRef(props.draft);
  draftRef.current = props.draft;
  const watchers = useRef(new Set<() => void>());
  useEffect(() => {
    for (const watcher of watchers.current) watcher();
  }, [props.draft]);
  const dictation = useVoiceInputController({
    ownerKey: props.ownerKey,
    label: props.title,
    readDraftMessage: () => draftRef.current,
    subscribeToDraftChanges: (onChange) => {
      watchers.current.add(onChange);
      return () => watchers.current.delete(onChange);
    },
    selection,
    onChangeDraftMessage: props.onChange,
    onChangeSelection: setSelection,
  });
  const presentation = resolveVoiceComposerPresentation(dictation.state, dictation.elapsedSeconds);
  const hasText = props.draft.trim().length > 0;
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      onLayout={(event) => {
        setHeight(event.nativeEvent.layout.height);
        props.onHeight(event.nativeEvent.layout.height);
      }}
    >
      <EdgeFade edge="bottom" height={height + 16} solid={0.3} />
      <View className="px-4" style={{ paddingBottom: Math.max(insets.bottom, 10), paddingTop: 6 }}>
        <ComposerSurface style={{ borderRadius: 27, overflow: "hidden", paddingVertical: 2 }}>
          <View className="flex-row items-center pl-4">
            <TextInput
              value={props.draft}
              onChangeText={props.onChange}
              selection={selection}
              onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
              editable={!dictation.freezesEditor}
              placeholder={copy.placeholder}
              multiline
              className="min-w-0 flex-1 text-foreground"
              placeholderTextColorClassName="accent-foreground-muted"
              style={{ ...props.body, minHeight: 36, maxHeight: 140, paddingTop: 8, paddingBottom: 8 }}
            />
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
        </ComposerSurface>
      </View>
    </View>
  );
}

/** The room once its thread is known: route params carry environmentId and threadId. */
function RoomBody(props: {
  readonly companion: CompanionEntry | null;
  readonly companionId: string;
  readonly environmentId: EnvironmentId;
  readonly headerHeight: number;
}) {
  const composer = useThreadComposerState();
  const body = useScaledTextRole("body");
  const [composerHeight, setComposerHeight] = useState(80);
  const title = props.companion?.title ?? props.companionId;
  const calls = useRoomCalls(props.environmentId, props.companionId);
  const messages = useMemo<RoomMessageInput[]>(
    () =>
      composer.selectedThreadFeed.flatMap((entry) =>
        entry.type === "message"
          ? [{ id: entry.message.id, role: entry.message.role, text: entry.message.text, createdAt: entry.message.createdAt, streaming: entry.message.streaming }]
          : [],
      ),
    [composer.selectedThreadFeed],
  );
  const items = useMemo(() => roomItems(messages, calls), [messages, calls]);
  const writing = companionIsWriting(items, composer.activeThreadBusy);
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
      <FlatList
        inverted
        data={reversed}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RoomRow item={item} companion={props.companion} title={title} environmentId={props.environmentId} body={body} />
        )}
        ListHeaderComponent={
          <View style={{ paddingBottom: composerHeight + 6 }}>{writing ? <WritingDots /> : null}</View>
        }
        ListFooterComponent={<View style={{ height: props.headerHeight + 8 }} />}
        contentContainerStyle={{ paddingHorizontal: 16 }}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        scrollIndicatorInsets={{ top: composerHeight, bottom: props.headerHeight }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
      <RoomComposer
        draft={composer.draftMessage}
        onChange={composer.onChangeDraftMessage}
        onSend={() => void composer.onSendMessage()}
        canCall={callable?.ready === true}
        onCall={call}
        ownerKey={composer.composerDraftKey ?? null}
        title={title}
        body={body}
        onHeight={setComposerHeight}
      />
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
