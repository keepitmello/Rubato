import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useMemo, useRef } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { useThreadListActions } from "../home/useThreadListActions";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { roomLeadEndStatus, roomWorkSessions, roomWorkThreads } from "./roomLeadsModel";
import { BUBBLE_PADDING_X, BUBBLE_RADIUS, ROOM_SIDE } from "./roomLayout";
import type { RoomLaunch } from "./roomModel";

function priority(thread: EnvironmentThreadShell): number {
  const status = resolveThreadListV2Status(thread);
  if (status === "approval" || status === "input" || status === "request") return 0;
  return status === "working" || thread.blockedOnThreadWait ? 1 : 2;
}

export function RoomLeadsSheet(props: {
  environmentId: EnvironmentId; launches: readonly RoomLaunch[]; close: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const selectDetail = useSelectWorkspaceDetail();
  const { settleThread } = useThreadListActions();
  const shells = useAtomValue(steadyNavigationThreadShellsAtom);
  const sessions = useMemo(() => roomWorkSessions(props.launches), [props.launches]);
  const rows = useMemo(() => roomWorkThreads(shells, props.environmentId, sessions, priority),
    [shells, props.environmentId, sessions]);
  const openedSwipe = useRef<SwipeableMethods | null>(null);

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={props.close}>
      <GestureHandlerRootView className="flex-1 bg-screen">
        <SheetHeader title={gt("Work")} onClose={props.close} presentation="inline" />
        <FlatList
          data={rows}
          keyExtractor={(thread) => thread.id}
          initialNumToRender={10}
          contentContainerStyle={{ paddingHorizontal: ROOM_SIDE, paddingTop: 8, paddingBottom: Math.max(20, insets.bottom) }}
          ListEmptyComponent={
            <View className="items-center px-6 py-12">
              <View className="mb-3 size-12 items-center justify-center" style={{ borderRadius: BUBBLE_RADIUS, backgroundColor: theme["--color-grouped-card"] }}>
                <SymbolView name="checkmark.circle" size={21} tintColorClassName="text-foreground-muted" />
              </View>
              <Text className="font-semibold text-foreground">{gt("No work to pick up")}</Text>
              <Text className="mt-1 text-center text-sm text-foreground-muted">{gt("Past work stays in your chat.")}</Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <WorkRow
              thread={item}
              first={index === 0} last={index === rows.length - 1}
              onSwipeOpen={(swipe) => {
                if (openedSwipe.current !== swipe) openedSwipe.current?.close();
                openedSwipe.current = swipe;
              }}
              onSettle={() => void settleThread(item)}
              onOpen={() => {
                props.close();
                selectDetail({ name: "Thread", params: { environmentId: props.environmentId, threadId: item.id } });
              }}
            />
          )}
        />
        <ThreadUndoNotice visible />
      </GestureHandlerRootView>
    </Modal>
  );
}

function WorkRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly first: boolean;
  readonly last: boolean;
  readonly onOpen: () => void;
  readonly onSettle: () => void;
  readonly onSwipeOpen: (swipe: SwipeableMethods) => void;
}) {
  const gt = useGT();
  const theme = useUniwindTheme();
  const { thread } = props;
  const swipeRef = useRef<SwipeableMethods>(null);
  const status = resolveThreadListV2Status(thread);
  const ended = roomLeadEndStatus(thread.latestRun?.status);
  const label =
    status === "approval" ? gt("Needs approval") : status === "input" || status === "request" ? gt("Needs input") :
    thread.runtime?.status === "starting" ? gt("Starting…") : status === "working" ? gt("Working") :
    thread.blockedOnThreadWait ? gt("Waiting") :
    status === "failed" || status === "limited" || ended === "failed" ? gt("Failed") :
    ended === "stopped" ? gt("Stopped") : gt("Idle work");
  const accent = priority(thread) < 2;
  const ink = accent ? theme["--color-primary"] : theme["--color-foreground-muted"];
  const actionLabel = gt("Settle");
  return (
    <View style={{
      overflow: "hidden",
      borderTopLeftRadius: props.first ? BUBBLE_RADIUS : 0, borderTopRightRadius: props.first ? BUBBLE_RADIUS : 0,
      borderBottomLeftRadius: props.last ? BUBBLE_RADIUS : 0, borderBottomRightRadius: props.last ? BUBBLE_RADIUS : 0,
    }}>
      <Swipeable
        ref={swipeRef}
        overshootLeft={false}
        renderLeftActions={(_progress, _drag, swipe) => (
          <Pressable className="min-w-24 justify-center bg-primary px-4" accessibilityRole="button"
            onPress={() => { swipe.close(); props.onSettle(); }}>
            <Text className="text-center font-semibold text-primary-foreground">{actionLabel}</Text>
          </Pressable>
        )}
        onSwipeableWillOpen={() => { if (swipeRef.current) props.onSwipeOpen(swipeRef.current); }}
      >
        <Pressable
          style={({ pressed }) => ({ backgroundColor: pressed ? theme["--color-card-alt"] : theme["--color-grouped-card"], paddingHorizontal: BUBBLE_PADDING_X })}
          className="min-h-16 flex-row items-center gap-3 py-3"
          accessibilityRole="button" accessibilityLabel={`${thread.title}, ${label}`}
          accessibilityActions={[{ name: "settle", label: actionLabel }]}
          onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "settle") props.onSettle(); }}
          onPress={props.onOpen}
        >
          <View className="size-7 items-center justify-center">
            <View className="size-2 rounded-full" style={{ backgroundColor: ink }} />
          </View>
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={2} className="font-semibold text-foreground">{thread.title}</Text>
            <Text className="text-sm" style={{ color: ink }}>{label}</Text>
          </View>
          <SymbolView name="chevron.right" size={12} tintColorClassName="text-foreground-muted" />
        </Pressable>
        {!props.last ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme["--color-grouped-card"] }}>
          <View style={{ marginLeft: BUBBLE_PADDING_X + 40, flex: 1, backgroundColor: theme["--color-border"] }} />
        </View> : null}
      </Swipeable>
    </View>
  );
}
