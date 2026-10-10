/**
 * A side chat in the right panel (rubatoSideChat.ts): the fork's own thread, drawn by the same
 * timeline as the thread beside it, with a plain composer at the bottom. The thread starts empty
 * at the fork, while the model has the whole copied conversation. It keeps the model and modes
 * of the thread it came from, which is what the copied prefix was cached with, so the composer
 * offers no picker. Closing the tab deletes it.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { ArrowUp, Square } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThread } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { newMessageId } from "~/lib/utils";
import { deriveActiveWorkStartedAt, derivePhase, deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";
import type { ChatMessage } from "../types";
import { buildThreadTurnInterruptInput } from "./ChatView.logic";
import { MessagesTimeline } from "./chat/MessagesTimeline";

const NO_TURN_DIFFS: never[] = [];
const ignore = () => undefined;

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
  threadId: string;
  workspaceRoot: string | undefined;
}) {
  const ref = useMemo(() => scopeThreadRef(environmentId, ThreadId.make(threadId)), [environmentId, threadId]);
  const thread = useThread(ref);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"send" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadKey = scopedThreadKey(ref);

  const messages = thread?.messages;
  const activities = thread?.activities;
  const proposedPlans = thread?.proposedPlans;
  const entries = useMemo(
    () =>
      deriveTimelineEntries(
        (messages ?? []).map(({ attachments: _attachments, ...message }) => message as ChatMessage),
        proposedPlans ?? [],
        deriveWorkLogEntries(activities ?? []),
      ),
    [messages, activities, proposedPlans],
  );
  const session = thread?.session ?? null;
  const latestTurn = thread?.latestTurn ?? null;
  const working = derivePhase(session) === "running" || derivePhase(session) === "connecting" || busy === "send";
  const runningTurnId =
    (session?.status === "running" ? session.activeTurnId : null) ??
    (latestTurn?.state === "running" ? latestTurn.turnId : null);

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
          createdAt: new Date().toISOString(),
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
      await run(threadEnvironment.interruptTurn, { environmentId, input: buildThreadTurnInterruptInput(thread) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        {!thread ? (
          <p className="p-3 text-sm text-muted-foreground">Opening the side chat…</p>
        ) : entries.length === 0 && !working ? (
          <p className="p-3 text-sm text-muted-foreground">
            Ask anything about this thread. The side chat sees the whole conversation so far, and the
            thread will not see what you say here. Closing this tab deletes it.
          </p>
        ) : (
          <MessagesTimeline
            listRef={listRef}
            timelineEntries={entries}
            latestTurn={latestTurn}
            runningTurnId={runningTurnId}
            isWorking={working}
            activeTurnStartedAt={deriveActiveWorkStartedAt(latestTurn, session, null)}
            turnDiffSummaries={NO_TURN_DIFFS}
            routeThreadKey={threadKey}
            displayThreadKey={threadKey}
            activeThreadEnvironmentId={environmentId}
            markdownCwd={workspaceRoot}
            workspaceRoot={workspaceRoot}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
            supportsConversationRollback={false}
            isRevertingCheckpoint={false}
            onOpenTurnDiff={ignore}
            onRevertToTurnCount={ignore}
            onImageExpand={ignore}
            anchorMessageId={null}
            onAnchorReady={ignore}
            contentInsetEndAdjustment={0}
            liveFollowEnabled
            onIsAtEndChange={ignore}
            onManualNavigation={ignore}
          />
        )}
      </div>
      <footer className="space-y-1.5 border-t border-border/60 p-2">
        {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask in this side chat…"
          aria-label="Message to this side chat"
          rows={2}
          disabled={!thread}
          className="text-sm"
        />
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[.65rem] text-muted-foreground">
            Side chat · closing the tab deletes it
          </span>
          {working ? (
            <Button variant="destructive-outline" size="xs" disabled={busy === "stop"} onClick={() => void stop()}>
              <Square aria-hidden />
              {busy === "stop" ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button size="xs" disabled={!thread || busy !== null || draft.trim().length === 0} onClick={() => void send()}>
              <ArrowUp aria-hidden />
              Send
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
