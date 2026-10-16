/**
 * The right panel's Side chat (rubatoSideChat.ts). It lists the thread's side chats and opens one
 * in place of the list, the way the Agents panel opens an agent; what is open survives a thread
 * switch and a hidden panel (rubatoPanelViews.ts). A side chat is the fork's own thread, drawn by
 * the same timeline as the thread beside it, with the thread composer's look at the bottom
 * (RubatoPanelComposer.tsx). It starts empty at the fork while the model has the whole copied
 * conversation, and keeps the model and modes of the thread it came from, which the copied prefix
 * was cached with, so it offers no picker.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as DateTime from "effect/DateTime";
import { ArrowLeft, MessagesSquare, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { useAtomValue } from "@effect/atom-react";
import { useThreadProjection, useThreadVisibleTurnItems } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { newMessageId } from "~/lib/utils";
import { setOpenedInPanel, useOpenedInPanel } from "../rubatoPanelViews";
import {
  deriveActiveWorkStartedAt,
  derivePhase,
  deriveTimelineEntriesFromVisibleTurnItems,
} from "../session-logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { RubatoPanelComposer } from "./RubatoPanelComposer";
import {
  createSideChat,
  deleteSideChat,
  deleteSideChatIfEmpty,
  listSideChats,
  type SideChatEntry,
} from "./rubatoSideChat";

const NO_TURN_DIFFS: never[] = [];
const NO_RUNS: never[] = [];
const NO_PROVIDERS: never[] = [];
const ignore = () => undefined;
const ignoreAsync = async () => undefined;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function RubatoSideChatPanel({
  environmentId,
  threadId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  /** The thread the side chats came from. */
  threadId: string;
  workspaceRoot: string | undefined;
}) {
  const owner = useMemo(() => scopeThreadRef(environmentId, ThreadId.make(threadId)), [environmentId, threadId]);
  const ownerKey = scopedThreadKey(owner);
  const opened = useOpenedInPanel("side-chat", ownerKey);
  const open = useCallback((id: string | null) => setOpenedInPanel("side-chat", ownerKey, id), [ownerKey]);
  if (opened) {
    const side = scopeThreadRef(environmentId, ThreadId.make(opened));
    return (
      <SideChatConversation
        key={opened}
        side={side}
        workspaceRoot={workspaceRoot}
        onBack={() => {
          deleteSideChatIfEmpty(side);
          open(null);
        }}
        onDeleted={() => open(null)}
      />
    );
  }
  return <SideChatList owner={owner} onOpen={open} />;
}

function SideChatList({ owner, onOpen }: { owner: ScopedThreadRef; onOpen: (id: string) => void }) {
  const [entries, setEntries] = useState<ReadonlyArray<SideChatEntry> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    listSideChats(owner)
      .then((found) => {
        setEntries(found);
        setError(null);
      })
      .catch((cause) => setError(message(cause)));
  }, [owner]);
  useEffect(() => refresh(), [refresh]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onOpen((await createSideChat(owner)).threadId);
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
    }
  };
  const remove = async (entry: SideChatEntry) => {
    setEntries((current) => current?.filter((item) => item.threadId !== entry.threadId) ?? null);
    await deleteSideChat(scopeThreadRef(owner.environmentId, ThreadId.make(entry.threadId))).catch((cause) =>
      setError(message(cause)),
    );
    refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 p-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Side chats see this thread up to when they opened. The thread does not see them.
        </span>
        <Button size="xs" disabled={busy} onClick={() => void start()}>
          <Plus aria-hidden />
          {busy ? "Opening…" : "New side chat"}
        </Button>
      </div>
      {error ? <p className="px-3 pt-2 text-xs text-destructive-foreground">{error}</p> : null}
      {entries === null ? (
        error ? null : <p className="p-3 text-sm text-muted-foreground">Loading side chats…</p>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <MessagesSquare aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">No side chats yet</p>
          <p className="max-w-60 text-xs text-muted-foreground">
            Ask something on the side without adding to this thread. The side chat knows the whole
            conversation so far.
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 p-1.5">
            {entries.map((entry) => (
              <SideChatRow
                key={entry.threadId}
                side={scopeThreadRef(owner.environmentId, ThreadId.make(entry.threadId))}
                createdAt={entry.createdAt}
                onOpen={() => onOpen(entry.threadId)}
                onDelete={() => void remove(entry)}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function SideChatRow({
  side,
  createdAt,
  onOpen,
  onDelete,
}: {
  side: ScopedThreadRef;
  createdAt: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const projection = useThreadProjection(side)?.projection ?? null;
  const first = projection?.messages.find((item) => item.role === "user")?.text.trim();
  const lastAt = projection?.messages.at(-1)?.updatedAt;
  const last = lastAt ? DateTime.formatIso(lastAt) : createdAt;
  const working = useMemo(
    () => projection !== null && derivePhase(deriveThreadRuntime(projection)) === "running",
    [projection],
  );
  return (
    <li className="group flex items-center gap-1 rounded-(--control-radius) hover:bg-accent">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-1.5 text-left">
        <span className={first ? "w-full truncate text-sm" : "w-full truncate text-sm text-muted-foreground"}>
          {first || "Nothing asked yet"}
        </span>
        <span className="text-[.7rem] text-muted-foreground">
          {working ? <span className="text-info-foreground">● working · </span> : null}
          {formatRelativeTimeLabel(last)}
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete side chat"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onDelete}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  );
}

function SideChatConversation({
  side,
  workspaceRoot,
  onBack,
  onDeleted,
}: {
  side: ScopedThreadRef;
  workspaceRoot: string | undefined;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const ref = side;
  const environmentId = side.environmentId;
  const detail = useThreadProjection(ref);
  const projection = detail?.projection ?? null;
  const thread = projection?.thread ?? null;
  const visibleTurnItems = useThreadVisibleTurnItems(ref);
  const providers = useAtomValue(environmentServerConfigsAtom).get(environmentId)?.providers ?? NO_PROVIDERS;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"send" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadKey = scopedThreadKey(ref);

  const entries = useMemo(
    () =>
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems,
        optimisticMessages: [],
        ...(projection === null
          ? {}
          : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
      }),
    [visibleTurnItems, projection],
  );
  const activityRun = useMemo(() => (projection ? deriveThreadActivityRun(projection) : null), [projection]);
  const runtime = useMemo(() => (projection ? deriveThreadRuntime(projection) : null), [projection]);
  const phase = derivePhase(runtime);
  const working = phase === "running" || phase === "connecting" || busy === "send";
  const runningRunId = runtime?.activeRunId ?? null;

  const send = async () => {
    const text = draft.trim();
    if (!thread || !text || busy || working) return;
    setBusy("send");
    setError(null);
    try {
      await run(threadEnvironment.startTurn, {
        environmentId,
        input: {
          threadId: thread.id,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          dispatchMode: "start",
        },
      });
      setDraft("");
      void listRef.current?.scrollToEnd({ animated: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!thread || busy === "stop") return;
    setBusy("stop");
    setError(null);
    try {
      await run(threadEnvironment.interruptTurn, {
        environmentId,
        input: { threadId: thread.id, ...(runningRunId ? { runId: runningRunId } : {}) },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await deleteSideChat(side);
      onDeleted();
    } catch (cause) {
      setError(message(cause));
    }
  };
  const first = projection?.messages.find((item) => item.role === "user")?.text.trim();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-1.5 py-1">
        <Button variant="ghost-muted" size="icon-sm" aria-label="Back to side chats" onClick={onBack} className="shrink-0">
          <ArrowLeft aria-hidden />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{first || "New side chat"}</span>
        <Button
          variant="ghost-destructive"
          size="icon-sm"
          aria-label="Delete side chat"
          onClick={() => void remove()}
          className="shrink-0"
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!thread ? (
          <p className="m-auto p-6 text-sm text-muted-foreground">Opening the side chat…</p>
        ) : entries.length === 0 && !working ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <MessagesSquare aria-hidden className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">Ask on the side</p>
            <p className="max-w-64 text-xs text-muted-foreground">
              This side chat sees the whole conversation so far. The thread will not see what you
              say here.
            </p>
          </div>
        ) : (
          <MessagesTimeline
            listRef={listRef}
            timelineEntries={entries}
            latestRun={activityRun}
            runningRunId={runningRunId}
            isWorking={working}
            activeTurnInProgress={working}
            activeTurnStartedAt={deriveActiveWorkStartedAt(activityRun, runtime, null)}
            turnDiffSummaries={NO_TURN_DIFFS}
            routeThreadKey={threadKey}
            displayThreadKey={threadKey}
            activeThreadEnvironmentId={environmentId}
            markdownCwd={workspaceRoot}
            workspaceRoot={workspaceRoot}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
            providerStatuses={providers}
            runs={projection?.runs ?? NO_RUNS}
            supportsConversationRollback={false}
            isRevertingCheckpoint={false}
            onOpenTurnDiff={ignore}
            onOpenThread={ignore}
            onForkFromRun={ignoreAsync}
            onRollbackCheckpoint={ignore}
            onRevertToTurnCount={ignore}
            onImageExpand={ignore}
            anchorMessageId={null}
            onAnchorReady={ignore}
            onAnchorSizeChanged={ignore}
            contentInsetEndAdjustment={0}
            liveFollowEnabled
            onIsAtEndChange={ignore}
            onManualNavigation={ignore}
          />
        )}
      </div>
      <RubatoPanelComposer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        onStop={() => void stop()}
        placeholder="Ask in this side chat…"
        ariaLabel="Message to this side chat"
        hint="Same model as the thread"
        error={error}
        running={working}
        sending={busy === "send"}
        canSend={!working && busy === null}
        disabled={!thread}
      />
    </div>
  );
}
