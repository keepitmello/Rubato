import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Modal, Pressable, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useAppActive } from "../../lib/appState";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { useThreadListActions } from "../home/useThreadListActions";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { useRoomLaunches } from "./roomLaunches";
import { roomLeadEndStatus, roomLeadRows } from "./roomLeadsModel";
import type { RoomLaunch } from "./roomModel";
import { postRubato } from "./rubatoHttp";

export function RoomLeadsSheet(props: {
  environmentId: EnvironmentId; companionId: string; roomThreadId: string; close: () => void;
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const selectDetail = useSelectWorkspaceDetail();
  const { settleThread, unsettleThread } = useThreadListActions();
  const shells = useAtomValue(steadyNavigationThreadShellsAtom);
  const active = useAppActive();
  const launches = useRoomLaunches(props.environmentId, props.companionId, props.roomThreadId, active, false);
  const rows = useMemo(() => roomLeadRows(launches), [launches]);
  const index = useMemo(() => {
    const byId = new Map<string, EnvironmentThreadShell>();
    const bySession = new Map<string, EnvironmentThreadShell>();
    for (const thread of shells) {
      if (thread.environmentId !== props.environmentId) continue;
      byId.set(thread.id, thread);
      if (thread.id.startsWith("import:")) bySession.set(thread.id.slice(thread.id.lastIndexOf(":") + 1), thread);
    }
    return { byId, bySession };
  }, [shells, props.environmentId]);
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={props.close}>
      <GestureHandlerRootView className="flex-1 bg-screen">
        <SheetHeader title={gt("Lead threads")} onClose={props.close} presentation="inline" />
        <FlatList
          data={rows}
          keyExtractor={(launch) => launch.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(18, insets.bottom) }}
          ListEmptyComponent={<Text className="px-2 py-8 text-center text-foreground-muted">{gt("No lead threads yet")}</Text>}
          renderItem={({ item }) => (
            <LeadRow
              launch={item} environmentId={props.environmentId} index={index}
              onToggleSettled={(thread) => thread.settledOverride === "settled" ? unsettleThread(thread) : settleThread(thread)}
              onOpen={(threadId) => {
                props.close();
                selectDetail({ name: "Thread", params: { environmentId: props.environmentId, threadId } });
              }}
            />
          )}
        />
        <ThreadUndoNotice visible />
      </GestureHandlerRootView>
    </Modal>
  );
}

function LeadRow(props: {
  readonly launch: RoomLaunch;
  readonly environmentId: EnvironmentId;
  readonly index: { byId: ReadonlyMap<string, EnvironmentThreadShell>; bySession: ReadonlyMap<string, EnvironmentThreadShell> };
  readonly onToggleSettled: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onOpen: (threadId: string) => void;
}) {
  const gt = useGT();
  const { launch, environmentId, index } = props;
  const [resolved, setResolved] = useState<{ sessionId: string; threadId: string } | null>(null);
  const imported = launch.sessionId ? index.bySession.get(launch.sessionId) : undefined;
  const resolvedId = resolved?.sessionId === launch.sessionId ? resolved?.threadId : undefined;
  const thread = imported ?? (resolvedId ? index.byId.get(resolvedId) : undefined);
  useEffect(() => {
    if (imported || resolvedId || !launch.sessionId) return;
    const sessionId = launch.sessionId;
    const controller = new AbortController();
    void postRubato<{ threadId: string | null }>(
      environmentId, "/rubato/companion", "thread", { sessionId }, { signal: controller.signal, timeoutMs: 4_000 },
    ).then(({ threadId }) => {
      if (threadId && !controller.signal.aborted) setResolved({ sessionId, threadId });
    }).catch(() => {});
    return () => controller.abort();
  }, [environmentId, imported, launch.sessionId, resolvedId]);
  const settled = thread?.settledOverride === "settled";
  const status = thread ? resolveThreadListV2Status(thread) : null;
  const ended = roomLeadEndStatus(thread?.latestRun?.status);
  const label =
    status === "approval" ? gt("Needs approval") : status === "input" || status === "request" ? gt("Needs input") :
    status === "working" ? gt("Working") : status === "failed" || status === "limited" || ended === "failed" ? gt("Failed") :
    ended === "stopped" ? gt("Stopped") : ended === "completed" ? gt("Completed") :
    !thread ? gt("Starting…") : gt("Waiting");
  const actionLabel = settled ? gt("Unsettle") : gt("Settle");
  const title = thread?.title ?? launch.title ?? gt("Lead thread");
  async function open() {
    if (thread || resolvedId) {
      props.onOpen(thread?.id ?? resolvedId!);
      return;
    }
    if (!launch.sessionId) return;
    try {
      const { threadId } = await postRubato<{ threadId: string | null }>(
        environmentId, "/rubato/companion", "thread", { sessionId: launch.sessionId },
      );
      if (threadId) props.onOpen(threadId);
      else Alert.alert(gt("Thread isn’t ready yet"), gt("Try opening it again in a moment."));
    } catch {
      Alert.alert(gt("Couldn’t open the thread"));
    }
  }
  const toggle = () => { if (thread) void props.onToggleSettled(thread); };
  return (
    <View className="mb-2 overflow-hidden rounded-2xl border border-border">
      <Swipeable
        enabled={thread !== undefined && thread.archivedAt === null}
        overshootLeft={false}
        renderLeftActions={thread && thread.archivedAt === null ? (_progress, _drag, swipe) => (
          <Pressable className="min-w-24 justify-center bg-accent px-4" accessibilityRole="button"
            onPress={() => { swipe.close(); toggle(); }}>
            <Text className="text-center font-semibold text-accent-foreground">{actionLabel}</Text>
          </Pressable>
        ) : undefined}
      >
        <Pressable
          className="min-h-16 flex-row items-center gap-3 bg-card px-4 py-3"
          accessibilityRole="button" accessibilityLabel={`${title}, ${label}`}
          disabled={!launch.sessionId}
          accessibilityActions={thread && thread.archivedAt === null ? [{ name: "settle", label: actionLabel }] : undefined}
          onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "settle") toggle(); }}
          onPress={() => void open()}
        >
          <View className={`size-2 rounded-full ${status === "working" ? "bg-accent" : "bg-foreground-muted"}`} />
          <View className="flex-1">
            <Text numberOfLines={2} className="font-semibold text-foreground">{title}</Text>
            <Text className="text-sm text-foreground-muted">{settled ? `${label} · ${gt("Settled")}` : label}</Text>
          </View>
          <SymbolView name="chevron.right" size={12} tintColorClassName="text-foreground-muted" />
        </Pressable>
      </Swipeable>
    </View>
  );
}
