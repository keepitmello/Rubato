// The companions, like a messenger's chat list (user 3ec923c9, in the style of Pickle): each row is
// a companion's room with its face, name, the latest message and when it came. Under them, always,
// "새 컴패니언" makes one on the Mac and opens its first conversation (intent companion-manage).
import { CommonActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, FlatList, Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { buildThreadFeed } from "../../lib/threadActivity";
import { useEnvironments } from "../../state/environments";
import { CompanionAvatar } from "./CompanionAvatar";
import { createCompanion, useCompanions, type CompanionEntry } from "./companionsStore";
import { copy, phoneLocale } from "./copy";
import { roomItems, roomPreview, type RoomMessageInput } from "./roomModel";
import { useRoomThread, useRoomTurnItems } from "./roomThread";

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
  useRoomThread(target);
  const visible = useRoomTurnItems(target);
  const preview = useMemo(() => roomPreview(roomItems(feedMessages(visible), [])), [visible]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      className="flex-row items-center gap-3.5 px-5 py-3 active:bg-grouped-card"
    >
      <CompanionAvatar art={companion.art} title={companion.macTitle === null ? "?" : companion.title} size={56} />
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

/** The dashed row under the list (the accepted mockup's first phone). */
function NewCompanionRow(props: { readonly creating: boolean; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.newCompanion}
      disabled={props.creating}
      onPress={props.onPress}
      className="mx-5 mt-4 flex-row items-center justify-center gap-2 rounded-[16px] border border-dashed border-border py-4 active:opacity-70"
    >
      {props.creating ? <ActivityIndicator /> : null}
      <Text className="font-t3-bold text-[16px] text-primary-text">
        {props.creating ? copy.creating : `＋ ${copy.newCompanion}`}
      </Text>
    </Pressable>
  );
}

/** Which Mac a new companion lives on: the only one, or the one the person picks. */
function pickMac(macs: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>): Promise<EnvironmentId | null> {
  if (macs.length <= 1) return Promise.resolve(macs[0]?.environmentId ?? null);
  return new Promise((resolve) => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: copy.pickMac, options: [...macs.map((mac) => mac.label), copy.cancel], cancelButtonIndex: macs.length },
        (index) => resolve(macs[index]?.environmentId ?? null),
      );
      return;
    }
    Alert.alert(copy.pickMac, undefined, [
      ...macs.map((mac) => ({ text: mac.label, onPress: () => resolve(mac.environmentId) })),
      { text: copy.cancel, style: "cancel" as const, onPress: () => resolve(null) },
    ]);
  });
}

export function CompanionListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { companions, loaded, error, paired, refresh } = useCompanions();
  const { environments } = useEnvironments();
  const [creating, setCreating] = useState(false);
  const create = async () => {
    const environmentId = await pickMac(environments.map((item) => ({ environmentId: item.environmentId, label: item.label })));
    if (environmentId === null) return;
    setCreating(true);
    await createCompanion(environmentId).then(
      ({ id }) => navigation.dispatch(CommonActions.navigate("CompanionRoom", { companionId: id, environmentId })),
      (cause: unknown) => Alert.alert(copy.createFailed, cause instanceof Error ? cause.message : String(cause)),
    );
    setCreating(false);
  };
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
        // Below the shared bar: the safe-area top here already includes the bar's height.
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 96, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} />}
        renderItem={({ item }) => <CompanionRow companion={item} onOpen={() => open(item)} />}
        ItemSeparatorComponent={() => <View className="h-[0.5px] bg-border" style={{ marginLeft: 90 }} />}
        ListFooterComponent={paired ? <NewCompanionRow creating={creating} onPress={() => void create()} /> : undefined}
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
