// A companion's room (user 3ec923c9, in the style of Pickle): its face and name at the top, the
// conversation as bubbles with each call as a card, and a composer with dictation and a call button.
// The room is the companion's T3 thread; sending goes through the thread's own composer state, so a
// message queued while the companion works behaves as in any thread.
import { useNavigation, useRoute, type RouteProp, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, FlatList, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { CallCard } from "./CallCard";
import { callActions, callApi, useCallView, type CallRecord } from "./callStore";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanion, type CompanionEntry } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { companionIsWriting, roomItems, type RoomItem, type RoomMessageInput } from "./roomModel";

export type CompanionRoomParams = {
  readonly companionId: string;
  readonly environmentId?: string;
  readonly threadId?: string;
};

const ME_BUBBLE = "bg-[#7BE383]";
const COMPANION_BUBBLE = "bg-grouped-card";

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

function RoomHeader(props: { readonly companion: CompanionEntry | null; readonly title: string; readonly onBack: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="items-center bg-screen" style={{ paddingTop: insets.top + 6, paddingBottom: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.back}
        onPress={props.onBack}
        className="absolute left-4 h-11 w-11 items-center justify-center rounded-full border border-border bg-screen active:opacity-70"
        style={{ top: insets.top + 16, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } }}
      >
        <SymbolView name="chevron.left" size={18} className="text-foreground" />
      </Pressable>
      <CompanionAvatar art={props.companion?.art ?? null} title={props.title} size={64} ring />
      <View
        className="-mt-2 rounded-full border border-border bg-screen px-3 py-1"
        style={{ shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}
      >
        <Text className="font-t3-bold text-[15px] text-foreground">{props.title}</Text>
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
    <View accessibilityLabel={copy.writing} className={`mt-1 self-start rounded-[22px] px-4 py-3 ${COMPANION_BUBBLE}`}>
      <Animated.Text style={{ opacity: pulse, letterSpacing: 3 }} className="text-[18px] text-foreground-muted">
        •••
      </Animated.Text>
    </View>
  );
}

function RoomRow(props: { readonly item: RoomItem; readonly companion: CompanionEntry | null; readonly title: string }) {
  const { item } = props;
  if (item.kind === "separator")
    return <Text className="my-3 text-center text-[12px] text-foreground-muted">{separatorText(item.at)}</Text>;
  if (item.kind === "call")
    return (
      <View className={item.call.status === "ringing" ? "mt-2 opacity-70" : "mt-2"}>
        <CallCard call={item.call} title={props.title} art={props.companion?.art ?? null} />
      </View>
    );
  const mine = item.side === "me";
  return (
    <View
      className={`${mine ? "self-end" : "self-start"} rounded-[22px] px-4 py-3 ${mine ? ME_BUBBLE : COMPANION_BUBBLE}`}
      style={{
        maxWidth: "80%",
        marginTop: item.groupStart ? 10 : 3,
        ...(item.groupEnd ? (mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }) : {}),
      }}
    >
      <Text
        selectable
        className={mine ? "text-[16px] leading-[22px] text-[#0E2A14]" : "text-[16px] leading-[22px] text-foreground"}
      >
        {item.text || (item.streaming ? "…" : "")}
      </Text>
    </View>
  );
}

function RoomComposer(props: {
  readonly draft: string;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  readonly canCall: boolean;
  readonly onCall: () => void;
  readonly ownerKey: string | null;
  readonly title: string;
}) {
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState({ start: props.draft.length, end: props.draft.length });
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
  const listening = dictation.state.phase !== "idle" && dictation.state.phase !== "error";
  const hasText = props.draft.trim().length > 0;
  return (
    <View className="px-3" style={{ paddingBottom: Math.max(insets.bottom, 10) }}>
      <View
        className="flex-row items-end gap-1 rounded-[30px] border border-border bg-screen py-1.5 pl-4 pr-1.5"
        style={{ shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } }}
      >
        <TextInput
          value={props.draft}
          onChangeText={props.onChange}
          selection={selection}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          editable={!dictation.freezesEditor}
          placeholder={copy.placeholder}
          multiline
          className="min-h-[44px] flex-1 py-[11px] text-[16px] text-foreground"
          placeholderTextColorClassName="accent-foreground-muted"
          style={{ maxHeight: 140 }}
        />
        {hasText && !listening ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.send}
            onPress={props.onSend}
            disabled={dictation.blocksSubmission}
            className="h-11 w-11 items-center justify-center rounded-full bg-[#7BE383] active:opacity-70"
          >
            <SymbolView name="arrow.up" size={18} className="text-[#0E2A14]" />
          </Pressable>
        ) : dictation.isAvailable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.dictate}
            onPress={listening ? () => void dictation.stop() : dictation.start}
            className="h-11 w-11 items-center justify-center rounded-full active:opacity-60"
          >
            <SymbolView
              name={{ ios: listening ? "stop.circle.fill" : "mic", android: "smartphone" }}
              size={22}
              tintColor={listening ? "#E5484D" : undefined}
              className="text-foreground"
            />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.canCall ? copy.call : copy.cannotCall}
          onPress={props.onCall}
          className={props.canCall ? "h-11 w-11 items-center justify-center rounded-full bg-foreground active:opacity-70" : "h-11 w-11 items-center justify-center rounded-full bg-foreground opacity-30"}
        >
          <SymbolView name={{ ios: "phone.fill", android: "smartphone" }} size={18} className="text-screen" />
        </Pressable>
      </View>
    </View>
  );
}

/** The room once its thread is known: route params carry environmentId and threadId. */
function RoomBody(props: { readonly companion: CompanionEntry | null; readonly companionId: string; readonly environmentId: EnvironmentId }) {
  const composer = useThreadComposerState();
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
      <FlatList
        inverted
        data={reversed}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <RoomRow item={item} companion={props.companion} title={title} />}
        ListHeaderComponent={writing ? <WritingDots /> : undefined}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
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
      />
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
  const back = () => (navigation.canGoBack() ? navigation.goBack() : undefined);
  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
      <RoomHeader companion={companion} title={title} onBack={back} />
      {environmentId && threadId ? (
        <RoomBody companion={companion} companionId={companionId} environmentId={environmentId as EnvironmentId} />
      ) : loaded && companion && !companion.threadId ? (
        <View className="flex-1 justify-center">
          <EmptyState variant="plain" title={copy.roomMissing} detail={copy.roomMissingDetail} />
        </View>
      ) : (
        <LoadingScreen message={copy.roomLoading} />
      )}
    </KeyboardAvoidingView>
  );
}
