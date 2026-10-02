/**
 * One child agent's conversation, opened from a row of the Agents panel: the brief it was
 * given, its words, its reasoning (folded), every tool call with its result (folded), and
 * at the bottom the controls to stop it or tell it something. The conversation is read
 * from the agent's own session file (src/agents/transcript.mjs), so a finished agent of a
 * thread that is not running can still be read; stopping and messaging need the thread's
 * session to be running.
 */
import { ArrowLeft, ArrowUp, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import {
  messageAgent,
  readAgentTranscript,
  stopAgent,
  type AgentTarget,
  type AgentTranscriptItem,
} from "../state/rubatoAgents";
import ChatMarkdown from "./ChatMarkdown";

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

function firstLine(text: string): string {
  const line = text.split("\n").find((value) => value.trim().length > 0) ?? "";
  return line.trim();
}

/** "read · src/app.ts": the tool and the first line of what it was given. */
export function toolSummary(item: Extract<AgentTranscriptItem, { kind: "tool" }>): string {
  let detail = "";
  try {
    const args = JSON.parse(item.input) as Record<string, unknown>;
    const first = [
      "path",
      "file_path",
      "command",
      "pattern",
      "query",
      "url",
      "agentId",
      "description",
    ]
      .map((name) => args[name])
      .find((value) => typeof value === "string" && value.trim().length > 0);
    detail = typeof first === "string" ? firstLine(first) : "";
  } catch {
    detail = firstLine(item.input);
  }
  return detail ? `${item.name} · ${detail}` : item.name;
}

function Folded({
  summary,
  tone = "muted",
  children,
}: {
  summary: ReactNode;
  tone?: "muted" | "error";
  children: ReactNode;
}) {
  return (
    <details className="group min-w-0 rounded-md border border-border/40 bg-card/20">
      <summary
        className={cn(
          "cursor-pointer list-none truncate px-2 py-1 font-mono text-[.7rem] hover:bg-accent/40",
          tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
        {summary}
      </summary>
      <div className="space-y-1.5 border-t border-border/40 p-2">{children}</div>
    </details>
  );
}

function Pre({ children, tone = "muted" }: { children: string; tone?: "muted" | "error" }) {
  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[.7rem] [overflow-wrap:anywhere]",
        tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </pre>
  );
}

function TranscriptItemView({ item, first }: { item: AgentTranscriptItem; first: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <section className="rounded-md border border-border/60 bg-muted/40 p-2">
          <p className="mb-1 font-mono text-[.65rem] text-muted-foreground">
            {first ? "Brief" : "Message"}
          </p>
          <p className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{item.text}</p>
        </section>
      );
    case "assistant":
      return (
        <ChatMarkdown
          text={item.text}
          cwd={undefined}
          className="min-w-0 text-xs [overflow-wrap:anywhere] [&_pre]:max-w-full"
        />
      );
    case "thinking":
      return (
        <Folded summary="Thinking">
          <p className="whitespace-pre-wrap text-[.7rem] text-muted-foreground [overflow-wrap:anywhere]">
            {item.text}
          </p>
        </Folded>
      );
    case "tool":
      return (
        <Folded summary={toolSummary(item)} tone={item.isError ? "error" : "muted"}>
          {item.input ? <Pre>{item.input}</Pre> : null}
          {item.output !== undefined ? (
            <div className="border-t border-border/40 pt-1.5">
              <Pre tone={item.isError ? "error" : "muted"}>{item.output || "(no output)"}</Pre>
            </div>
          ) : (
            <p className="font-mono text-[.65rem] text-muted-foreground/70">Running…</p>
          )}
        </Folded>
      );
    case "compaction":
      return (
        <Folded summary="Context compacted">
          <p className="whitespace-pre-wrap text-[.7rem] text-muted-foreground [overflow-wrap:anywhere]">
            {item.text}
          </p>
        </Folded>
      );
    case "error":
      return <p className="whitespace-pre-wrap text-xs text-destructive-foreground">{item.text}</p>;
  }
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Follow the end while the reader is at the end; leave them where they are otherwise.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [transcript.items]);

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
        pinnedRef.current = true;
      }
      await transcript.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void run("send");
  };

  const firstUser = transcript.items.findIndex((item) => item.kind === "user");
  const canControl = target !== null && transcript.controllable;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-1 border-b border-border/60 p-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to agents"
          onClick={onBack}
          className="shrink-0"
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">{header}</div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="flex flex-col gap-2 p-2.5">
          {!target ? (
            <p className="text-xs text-muted-foreground">
              This thread has no folder to read the agent from.
            </p>
          ) : !transcript.loaded ? (
            <p className="text-xs text-muted-foreground">Loading the conversation…</p>
          ) : transcript.error && transcript.items.length === 0 ? (
            <p className="text-xs text-destructive-foreground">{transcript.error}</p>
          ) : !transcript.found ? (
            <p className="text-xs text-muted-foreground">
              {live
                ? "Starting. Nothing recorded yet."
                : "This agent left no conversation to show."}
            </p>
          ) : (
            transcript.items.map((item, index) => (
              <TranscriptItemView key={index} item={item} first={index === firstUser} />
            ))
          )}
        </div>
      </div>
      <footer className="space-y-1.5 border-t border-border/60 p-2">
        {actionError ? <p className="text-xs text-destructive-foreground">{actionError}</p> : null}
        {canControl ? (
          <>
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={live ? "Tell this agent something…" : "Continue this agent…"}
              aria-label="Message to this agent"
              rows={2}
              className="text-xs"
            />
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[.65rem] text-muted-foreground">
                The lead sees a note of what you send.
              </span>
              {live ? (
                <Button
                  variant="destructive-outline"
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => void run("stop")}
                >
                  <Square aria-hidden />
                  {busy === "stop" ? "Stopping…" : "Stop"}
                </Button>
              ) : null}
              <Button
                size="xs"
                disabled={busy !== null || draft.trim().length === 0}
                onClick={() => void run("send")}
              >
                <ArrowUp aria-hidden />
                {busy === "send" ? "Sending…" : "Send"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[.65rem] text-muted-foreground">
            {target
              ? "Stopping and messaging work while this thread's session is running."
              : "Stopping and messaging need the thread's folder."}
          </p>
        )}
      </footer>
    </div>
  );
}
