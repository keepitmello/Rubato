// The companions, like a messenger's chat list (user 3ec923c9, in the style of Pickle): each row is
// a companion's room with its face, name, the latest message and when it came.
import { CommonActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, type ComponentProps } from "react";
import { FlatList, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { buildThreadFeed } from "../../lib/threadActivity";
import { useThreadDetail, useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { CompanionAvatar } from "./CompanionAvatar";
import { useCompanions, type CompanionEntry } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { roomItems, roomPreview, type RoomMessageInput } from "./roomModel";

const timeFormat = new Intl.DateTimeFormat(phoneLocale(), { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(phoneLocale(), { month: "short", day: "numeric" });

/** When the latest message came, as a chat list says it: a time today, a date before. */
export function listTime(at: number, now = Date.now()): string {
  return new Date(at).toDateString() === new Date(now).toDateString() ? timeFormat.format(at) : dayFormat.format(at);
}

/** A thread's messages as the room reads them. */
export function feedMessages(items: Parameters<typeof buildThreadFeed>[0]): RoomMessageInput[] {
  return buildThreadFeed(items).flatMap((entry) =>
    entry.type === "message"
      ? [{ id: entry.message.id, role: entry.message.role, text: entry.message.text, createdAt: entry.message.createdAt, streaming: entry.message.streaming }]
      : [],
  );
}

function CompanionRow(props: { readonly companion: CompanionEntry; readonly onOpen: () => void }) {
  const { companion } = props;
  const target = {
    environmentId: companion.environmentId,
    threadId: (companion.threadId ?? null) as ThreadId | null,
  };
  // Subscribes to the room's thread so the preview stays current.
  useThreadDetail(target);
  const visible = useThreadVisibleTurnItems(target);
  const preview = useMemo(() => roomPreview(roomItems(feedMessages(visible), [])), [visible]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      className="flex-row items-center gap-3.5 px-5 py-3 active:bg-grouped-card"
    >
      <CompanionAvatar art={companion.art} title={companion.title} size={56} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-baseline justify-between gap-2">
          <Text numberOfLines={1} className="flex-shrink font-t3-bold text-[17px] text-foreground">
            {companion.title}
          </Text>
          {preview ? <Text className="text-[13px] text-foreground-muted">{listTime(preview.at)}</Text> : null}
        </View>
        <Text numberOfLines={2} className="mt-0.5 text-[15px] leading-[20px] text-foreground-muted">
          {preview ? (preview.callKey ? `📞 ${copy[preview.callKey]}` : preview.text) : companion.threadId ? "" : copy.roomMissing}
        </Text>
      </View>
    </Pressable>
  );
}

function renderCompanionScrollView(props: ComponentProps<typeof ScrollView>) {
  return (
    <NativeScrollViewMarker style={{ flex: 1 }}>
      <ScrollView {...props} className="bg-screen" />
    </NativeScrollViewMarker>
  );
}

export function CompanionListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { companions, loaded, error, paired, refresh } = useCompanions();
  const open = (companion: CompanionEntry) =>
    navigation.dispatch(
      CommonActions.navigate("CompanionRoom", {
        companionId: companion.id,
        environmentId: companion.environmentId as EnvironmentId,
        ...(companion.threadId ? { threadId: companion.threadId } : {}),
      }),
    );
  return (
    <View className="flex-1 bg-screen">
      <FlatList
        data={companions}
        keyExtractor={(item) => `${item.environmentId}:${item.id}`}
        // Under the shared glass bar like the threads list: the inset clears the bar and the
        // native scroll edge (NativeScrollViewMarker) draws the bar's material as content passes under it.
        renderScrollComponent={Platform.OS === "ios" ? renderCompanionScrollView : undefined}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
        contentOffset={Platform.OS === "ios" ? { x: 0, y: -insets.top } : undefined}
        scrollIndicatorInsets={Platform.OS === "ios" ? { top: insets.top } : undefined}
        contentContainerStyle={{ paddingTop: Platform.OS === "ios" ? 8 : insets.top + 8, paddingBottom: insets.bottom + 96, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} />}
        renderItem={({ item }) => <CompanionRow companion={item} onOpen={() => open(item)} />}
        ItemSeparatorComponent={() => <View className="h-[0.5px] bg-border" style={{ marginLeft: 90 }} />}
        ListEmptyComponent={
          <View className="flex-1 justify-center pb-24">
            {!paired ? (
              <EmptyState variant="plain" title={copy.notConnected} detail={copy.notConnectedDetail} />
            ) : loaded ? (
              <EmptyState variant="plain" title={copy.noCompanions} detail={copy.noCompanionsDetail} />
            ) : error ? (
              <EmptyState variant="plain" title={copy.notConnected} detail={error} />
            ) : null}
          </View>
        }
      />
    </View>
  );
}
