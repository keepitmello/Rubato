// Segno's space: its conversation on the left, Segno on the right (companion-edits.mjs wraps the
// chat of Segno's thread in this). The stage carries the task panel — what Segno follows, the
// replies to other people that wait for the person, what recently finished — and Segno's art.
// Everything reads the theme's own colors; the space is see-through to the window material where
// the app has one (RubatoSegnoSpace.css), and the chat, the composer and the panel stay opaque.
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon, MessageSquareIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  rubatoCompanion,
  useReadyEnvironmentId,
  type SegnoFinished,
  type SegnoHeldMessage,
  type SegnoLead,
  type SegnoPanel,
} from "../../state/rubatoCompanion";
import { Button } from "../ui/button";
import "./RubatoSegnoSpace.css";

/** How often the panel looks again; the engine rewrites it within seconds of a change. */
const PANEL_POLL_MS = 3_000;
/** A finished item stays this long, then leaves. */
const FINISHED_SHOWN_MS = 20 * 60_000;

const EMPTY: SegnoPanel = { leads: [], finished: [], held: [] };

function usePanel(environmentId: ReturnType<typeof useReadyEnvironmentId>) {
  const [panel, setPanel] = useState<SegnoPanel>(EMPTY);
  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    try {
      setPanel(await rubatoCompanion.panel(environmentId));
    } catch {
      // A server without the route shows nothing.
    }
  }, [environmentId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), PANEL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { panel, refresh };
}

// Loaded once per app session; the server answers a new version when the file is swapped.
let artCache: string | null = null;
function useSegnoArt(environmentId: ReturnType<typeof useReadyEnvironmentId>) {
  const [art, setArt] = useState<string | null>(artCache);
  useEffect(() => {
    if (artCache !== null || environmentId === null) return;
    let live = true;
    void rubatoCompanion
      .art(environmentId)
      .then(({ art: loaded }) => {
        artCache = loaded.url;
        if (live) setArt(loaded.url);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [environmentId]);
  return art;
}

/** Elapsed time the way the sidebar writes it: now, 12m, 3h, 2d. */
export function compactSince(fromMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - fromMs) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const projectOf = (cwd: string | null) => (cwd ? (cwd.split("/").filter(Boolean).at(-1) ?? cwd) : null);
const parts = (...values: Array<string | null | undefined>) => values.filter((value): value is string => Boolean(value));

function useNow(stepMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

export function RubatoSegnoSpace({ children }: { children: ReactNode }) {
  const environmentId = useReadyEnvironmentId();
  const { panel, refresh } = usePanel(environmentId);
  const art = useSegnoArt(environmentId);
  return (
    <div data-rubato-segno-space="" className="relative flex min-h-0 min-w-0 flex-1">
      <div data-rubato-segno-chat="" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
      <aside data-rubato-segno-stage="" aria-label="Segno" className="relative hidden min-h-0 shrink-0 lg:block">
        {art ? (
          <img
            src={art}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute right-0 bottom-0 max-h-[78%] max-w-full select-none object-contain object-bottom"
          />
        ) : null}
        <SegnoTaskPanel
          environmentId={environmentId}
          panel={panel}
          onChanged={() => void refresh()}
        />
      </aside>
    </div>
  );
}

function SegnoTaskPanel({
  environmentId,
  panel,
  onChanged,
}: {
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
  panel: SegnoPanel;
  onChanged: () => void;
}) {
  const now = useNow();
  const finished = useMemo(
    () => panel.finished.filter((item) => now - item.at < FINISHED_SHOWN_MS),
    [panel.finished, now],
  );
  const count = panel.leads.length + panel.held.length;
  if (count === 0 && finished.length === 0) return null;
  return (
    <section
      data-rubato-segno-panel=""
      // Below the workspace's title bar controls, which sit over the stage's top right.
      className="absolute inset-x-3 top-[3.25rem] z-10 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <header className="flex items-center justify-between px-3.5 pt-2.5 pb-1.5 text-muted-foreground text-xs">
        <span>Segno's tasks</span>
        {count > 0 ? <span className="tabular-nums">{count}</span> : null}
      </header>
      <ul className="flex flex-col">
        {panel.leads.map((lead) => (
          <LeadRow key={lead.sessionId} lead={lead} now={now} environmentId={environmentId} />
        ))}
        {panel.held.map((message) => (
          <HeldRow key={message.id} message={message} environmentId={environmentId} onChanged={onChanged} />
        ))}
        {finished.map((item) => (
          <FinishedRow key={`${item.sessionId}:${item.at}`} item={item} now={now} environmentId={environmentId} />
        ))}
      </ul>
    </section>
  );
}

function RowIcon({ tone, children }: { tone: "running" | "asked" | "held" | "done" | "stopped"; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
        tone === "running" && "bg-primary/15 text-primary",
        (tone === "asked" || tone === "held") && "bg-warning/15 text-warning-foreground",
        tone === "done" && "bg-muted text-muted-foreground",
        tone === "stopped" && "bg-destructive/10 text-destructive-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Opens the T3 thread that shows a lead's conversation. */
function useOpenLead(environmentId: ReturnType<typeof useReadyEnvironmentId>) {
  const navigate = useNavigate();
  return useCallback(
    async (sessionId: string) => {
      if (environmentId === null) return;
      const { threadId } = await rubatoCompanion.thread(environmentId, sessionId).catch(() => ({ threadId: null }));
      if (threadId === null) return;
      await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    },
    [environmentId, navigate],
  );
}

function RowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** Each detail is its own text, so the Korean dictionary (rubatoI18n) finds the words. */
function RowText({ title, detail }: { title: string; detail: readonly string[] }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium text-sm">{title}</span>
      {detail.length > 0 ? (
        <span className="truncate text-muted-foreground text-xs">
          {detail.map((part, index) => (
            <span key={index}>
              {index > 0 ? " · " : null}
              <span>{part}</span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function LeadRow({
  lead,
  now,
  environmentId,
}: {
  lead: SegnoLead;
  now: number;
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
}) {
  const open = useOpenLead(environmentId);
  const asked = lead.state === "asked";
  return (
    <li data-rubato-segno-row={lead.state} className="rubato-segno-row border-border border-t first:border-t-0">
      <RowButton onClick={() => void open(lead.sessionId)}>
        <RowIcon tone={asked ? "asked" : "running"}>{asked ? <CircleAlertIcon /> : <PlayIcon />}</RowIcon>
        <RowText
          title={lead.title ?? "Untitled"}
          detail={parts(projectOf(lead.cwd), asked ? "Asked you" : lead.since ? compactSince(lead.since, now) : null)}
        />
      </RowButton>
    </li>
  );
}

function FinishedRow({
  item,
  now,
  environmentId,
}: {
  item: SegnoFinished;
  now: number;
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
}) {
  const open = useOpenLead(environmentId);
  const done = item.outcome === "completed";
  return (
    <li data-rubato-segno-row="finished" className="rubato-segno-row rubato-segno-finished border-border border-t first:border-t-0">
      <RowButton onClick={() => void open(item.sessionId)}>
        <RowIcon tone={done ? "done" : "stopped"}>{done ? <CheckIcon /> : <XIcon />}</RowIcon>
        <RowText
          title={item.title ?? "Untitled"}
          detail={parts(projectOf(item.cwd), done ? "Finished" : item.outcome === "failed" ? "Failed" : "Stopped", compactSince(item.at, now))}
        />
      </RowButton>
    </li>
  );
}

function HeldRow({
  message,
  environmentId,
  onChanged,
}: {
  message: SegnoHeldMessage;
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setText(message.text);
  }, [editing, message.text]);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  const decide = async (decision: "approve" | "reject") => {
    if (environmentId === null || busy) return;
    setBusy(true);
    try {
      const edited = decision === "approve" && editing && text.trim() !== message.text.trim() ? text : undefined;
      await rubatoCompanion.decideTelegram(environmentId, message.id, decision, edited);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-rubato-segno-row="held" className="rubato-segno-row border-border border-t px-3.5 py-2 first:border-t-0">
      <div className="flex items-start gap-2.5">
        <RowIcon tone="held">
          <MessageSquareIcon />
        </RowIcon>
        <RowText title="Reply waiting for approval" detail={parts(message.to?.name ?? message.to?.chatId)} />
      </div>
      <div className="mt-2 ms-8.5 flex flex-col gap-2">
        {editing ? (
          <textarea
            ref={area}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
            aria-label="Reply"
            className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : (
          <p className="whitespace-pre-wrap rounded-lg border border-border bg-background px-2.5 py-2 text-sm leading-relaxed">
            {message.text}
          </p>
        )}
        <div className="flex gap-1.5">
          <Button size="xs" disabled={busy || !text.trim()} onClick={() => void decide("approve")}>
            Send
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void decide("reject")}>
            Don't send
          </Button>
        </div>
      </div>
    </li>
  );
}
