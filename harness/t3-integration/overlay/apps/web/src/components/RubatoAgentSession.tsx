/**
 * One child agent's conversation, opened from a row of the Agents panel, drawn by the same
 * timeline as the thread itself (rubatoAgentTimeline.ts), with the thread composer's look at
 * the bottom (RubatoPanelComposer.tsx) to stop it or tell it something. The conversation is
 * read from the agent's own session file (src/agents/transcript.mjs), so a finished agent of a
 * thread that is not running can still be read; stopping and messaging need the thread's
 * session to be running.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { ArrowLeft } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "~/components/ui/button";
import { useTheme } from "~/hooks/useTheme";
import { useClientSettings } from "~/hooks/useSettings";
import {
  messageAgent,
  readAgentTranscript,
  stopAgent,
  type AgentTarget,
  type AgentTranscriptItem,
} from "../state/rubatoAgents";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { RubatoPanelComposer } from "./RubatoPanelComposer";
import { agentTimeline } from "./rubatoAgentTimeline";

/** How often a working agent's conversation is read again. */
export const LIVE_REFRESH_MS = 2_500;

interface TranscriptState {
  /** The target this state was read for; another target starts from EMPTY. */
  readonly key: string;
  readonly items: ReadonlyArray<AgentTranscriptItem>;
  readonly version: string;
  readonly found: boolean;
  readonly controllable: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY: TranscriptState = {
  key: "",
  items: [],
  version: "",
  found: false,
  controllable: false,
  loaded: false,
  error: null,
};

/** Reads the transcript once, then every LIVE_REFRESH_MS while the agent works. */
export function useAgentTranscript(target: AgentTarget | null, live: boolean, revision: string) {
  const [state, setState] = useState<TranscriptState>(EMPTY);
  const key = target
    ? `${target.environmentId}|${target.threadId}|${target.cwd}|${target.taskId}`
    : "";
  const targetRef = useRef({ key, target });
  targetRef.current = { key, target };
  // The version last read, for the target it was read for.
  const heldRef = useRef({ key: "", version: "" });

  const refresh = useCallback(async () => {
    const { key: asked, target: current } = targetRef.current;
    if (!current) return;
    try {
      const held = heldRef.current.key === asked ? heldRef.current.version : undefined;
      const answer = await readAgentTranscript(current, held);
      if (targetRef.current.key !== asked) return;
      heldRef.current = { key: asked, version: answer.version };
      setState((previous) => ({
        key: asked,
        items: answer.unchanged && previous.key === asked ? previous.items : (answer.items ?? []),
        version: answer.version,
        found: answer.found,
        controllable: answer.controllable,
        loaded: true,
        error: null,
      }));
    } catch (error) {
      if (targetRef.current.key !== asked) return;
      setState((previous) => ({
        ...(previous.key === asked ? previous : EMPTY),
        key: asked,
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  useEffect(() => {
    if (!key) return;
    void refresh();
    if (!live) return;
    const id = setInterval(() => void refresh(), LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [key, live, revision, refresh]);

  return { ...(state.key === key ? state : EMPTY), refresh };
}

const NO_TURN_DIFFS: never[] = [];
const ignore = () => undefined;

/** Where there is no conversation to draw, why. */
function AgentSessionNotice({ children, error = false }: { children: string; error?: boolean }) {
  return (
    <p
      className={
        error
          ? "m-auto max-w-72 p-6 text-center text-sm text-destructive-foreground"
          : "m-auto max-w-72 p-6 text-center text-sm text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}

export function RubatoAgentSession({
  target,
  live,
  revision,
  header,
  onBack,
}: {
  /** Null when the thread has no directory to read from. */
  target: AgentTarget | null;
  /** The agent is working: the conversation follows it and Stop is offered. */
  live: boolean;
  /** Changes whenever the agent reports anything, so a settled agent is read once more. */
  revision: string;
  header: ReactNode;
  onBack: () => void;
}) {
  const transcript = useAgentTranscript(target, live, revision);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"stop" | "send" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const taskId = target?.taskId ?? "";
  const timeline = useMemo(
    () => agentTimeline(transcript.items, { taskId, live }),
    [transcript.items, taskId, live],
  );
  // Links resolve against the thread the agent works for; its scroll position is its own.
  const threadKey = target
    ? scopedThreadKey({
        environmentId: target.environmentId,
        threadId: ThreadId.make(target.threadId),
      })
    : "";

  const run = async (kind: "stop" | "send") => {
    if (!target || busy) return;
    const message = draft.trim();
    if (kind === "send" && !message) return;
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === "stop") await stopAgent(target);
      else {
        await messageAgent(target, message);
        setDraft("");
      }
      await transcript.refresh();
      if (kind === "send") void listRef.current?.scrollToEnd({ animated: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const canControl = target !== null && transcript.controllable;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-1 border-b border-border/60 px-1.5 py-1">
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Back to agents"
          onClick={onBack}
          className="shrink-0"
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">{header}</div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {!target ? (
          <AgentSessionNotice>This thread has no folder to read the agent from.</AgentSessionNotice>
        ) : !transcript.loaded ? (
          <AgentSessionNotice>Loading the conversation…</AgentSessionNotice>
        ) : transcript.error && transcript.items.length === 0 ? (
          <AgentSessionNotice error>{transcript.error}</AgentSessionNotice>
        ) : !transcript.found || transcript.items.length === 0 ? (
          <AgentSessionNotice>
            {live ? "Starting. Nothing recorded yet." : "This agent left no conversation to show."}
          </AgentSessionNotice>
        ) : (
          <MessagesTimeline
            listRef={listRef}
            timelineEntries={timeline.entries}
            latestTurn={timeline.latestTurn}
            runningTurnId={timeline.runningTurnId}
            isWorking={live}
            activeTurnStartedAt={timeline.activeTurnStartedAt}
            turnDiffSummaries={NO_TURN_DIFFS}
            routeThreadKey={threadKey}
            displayThreadKey={`${threadKey}:agent:${target.taskId}`}
            activeThreadEnvironmentId={target.environmentId}
            markdownCwd={target.cwd}
            workspaceRoot={target.cwd}
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
      {canControl ? (
        <RubatoPanelComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void run("send")}
          onStop={() => void run("stop")}
          placeholder={live ? "Tell this agent something…" : "Continue this agent…"}
          ariaLabel="Message to this agent"
          hint="The lead sees a note of what you send."
          error={actionError}
          running={live}
          sending={busy === "send"}
          canSend={busy === null}
        />
      ) : (
        <footer className="shrink-0 border-t border-border/60 px-3 py-2">
          {actionError ? (
            <p className="pb-1 text-xs text-destructive-foreground">{actionError}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {target
              ? "Stopping and messaging work while this thread's session is running."
              : "Stopping and messaging need the thread's folder."}
          </p>
        </footer>
      )}
    </div>
  );
}
