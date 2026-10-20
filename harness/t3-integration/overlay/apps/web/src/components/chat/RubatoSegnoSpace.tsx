// Segno's space: its conversation on the left, Segno on the right (companion-edits.mjs wraps the
// chat of Segno's thread in this). The stage carries the task panel — what Segno follows, the
// replies to other people that wait for the person, what recently finished — and Segno's art.
// Everything reads the theme's own colors; the space is see-through to the window material where
// the app has one (RubatoSegnoSpace.css), and the chat, the composer and the panel stay opaque.
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon, InboxIcon, MessageSquareIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { cn } from "../../lib/utils";
import {
  rubatoCompanion,
  useReadyEnvironmentId,
  type SegnoFinished,
  type SegnoHeldMessage,
  type SegnoInboxItem,
  type SegnoLead,
  type SegnoPanel,
  type SegnoStageState,
} from "../../state/rubatoCompanion";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import "./RubatoSegnoSpace.css";

/** How often the panel looks again; the engine rewrites it within seconds of a change. */
const PANEL_POLL_MS = 3_000;
/** A finished item stays this long, then leaves. */
const FINISHED_SHOWN_MS = 20 * 60_000;

const EMPTY: SegnoPanel = { leads: [], finished: [], held: [] };
/** The last panel the server gave, so coming back to the space starts from it, not from nothing. */
let lastPanel: SegnoPanel | null = null;

/** `known` is false until the server has answered once; Segno's face waits for it. */
function usePanel(environmentId: ReturnType<typeof useReadyEnvironmentId>) {
  const [panel, setPanel] = useState<SegnoPanel | null>(lastPanel);
  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    try {
      lastPanel = await rubatoCompanion.panel(environmentId);
      setPanel(lastPanel);
    } catch {
      // A server without the route shows nothing.
    }
  }, [environmentId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), PANEL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { panel: panel ?? EMPTY, known: panel !== null, refresh };
}

/** The quiet hours: with nothing running, Segno sleeps between these local hours. */
export const NIGHT_HOURS = { from: 1, to: 7 } as const;

/**
 * Segno's expression from what it follows: something waits for the person (a held reply, a lead
 * that asked), a lead runs, the quiet hours with nothing running, or resting.
 */
export function stageStateOf(panel: SegnoPanel, now: Date): SegnoStageState {
  if (panel.held.length > 0 || panel.leads.some((lead) => lead.state === "asked")) return "waiting";
  if (panel.leads.some((lead) => lead.state === "running")) return "working";
  const hour = now.getHours();
  if (hour >= NIGHT_HOURS.from && hour < NIGHT_HOURS.to) return "night";
  return "idle";
}

// Each expression loads once per app session, when it is first needed.
const artCache = new Map<SegnoStageState, string>();
function useSegnoArt(
  environmentId: ReturnType<typeof useReadyEnvironmentId>,
  state: SegnoStageState | null,
) {
  const [loaded, setLoaded] = useState<ReadonlyMap<SegnoStageState, string>>(() => new Map(artCache));
  useEffect(() => {
    if (state === null || artCache.has(state) || environmentId === null) return;
    let live = true;
    void rubatoCompanion
      .art(environmentId, state)
      .then(({ art }) => {
        artCache.set(state, art.url);
        if (live) setLoaded(new Map(artCache));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [environmentId, state]);
  return loaded;
}

/**
 * The expressions stacked in one place; only the current one shows. A change of state cross-fades
 * once (RubatoSegnoSpace.css); nothing moves in between. Until the new picture has loaded, the one
 * before stays; before the first state is known, none shows. Segno stands in the bottom-right corner
 * at most 44rem tall: a companion beside the chat, not a figure the size of the window.
 */
function SegnoArt({
  art,
  state,
}: {
  art: ReadonlyMap<SegnoStageState, string>;
  state: SegnoStageState | null;
}) {
  const lastShown = useRef<SegnoStageState | null>(null);
  const shown = state !== null && art.has(state) ? state : lastShown.current;
  useEffect(() => {
    if (state !== null && art.has(state)) lastShown.current = state;
  }, [art, state]);
  return (
    <>
      {[...art].map(([key, url]) => (
        <img
          key={key}
          src={url}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-rubato-segno-art={key}
          data-shown={key === shown ? "" : undefined}
          className="rubato-segno-art pointer-events-none absolute right-0 bottom-0 h-full max-h-[44rem] max-w-full select-none object-contain object-right-bottom"
        />
      ))}
    </>
  );
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

/** The stage holds the full task panel from this width; narrower, it holds a compact one. */
const STAGE_FULL_PX = 200;
/** Narrower than this, the stage steps aside entirely and the chat keeps the whole space. */
const STAGE_PEEK_PX = 64;
/** Room kept between the chat's column and the stage, and off the window's right edge. */
const STAGE_GAP_PX = 16;
const STAGE_EDGE_PX = 8;

/**
 * How wide the stage can be: the room right of the chat's column. The chat keeps exactly the width
 * an ordinary thread has at this window size and chat-width setting (chat-width-edits.mjs) and sits
 * at the left of the space (RubatoSegnoSpace.css), so the stage gets all the room an ordinary
 * thread leaves on both sides of its column; the chat never narrows for Segno.
 */
function useStageWidth(space: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const root = space.current;
    if (!root) return;
    let lane: Element | null = null;
    const sizes = new ResizeObserver(() => measure());
    const measure = () => {
      if (!lane || !lane.isConnected) {
        lane = root.querySelector(".chat-content-lane");
        if (lane) sizes.observe(lane);
      }
      const outer = root.getBoundingClientRect();
      const inner = lane?.getBoundingClientRect();
      const free = inner ? outer.right - STAGE_EDGE_PX - (inner.right + STAGE_GAP_PX) : 0;
      setWidth(free >= STAGE_PEEK_PX ? Math.floor(free) : 0);
    };
    sizes.observe(root);
    // The column appears once the thread loads; look again when the chat's children change.
    const mutations = new MutationObserver(() => {
      if (!lane || !lane.isConnected) measure();
    });
    mutations.observe(root, { childList: true, subtree: true });
    measure();
    return () => {
      sizes.disconnect();
      mutations.disconnect();
    };
  }, [space]);
  return width;
}

/**
 * Segno's space starts with the thread list folded, so the stage gets that room; the rail stays and
 * the sidebar toggle still opens the list here. Leaving for any other route puts the list back as
 * it was when the person came in, so their choice for ordinary routes is never overwritten.
 */
export function useThreadListFoldedHere() {
  const { isMobile, open, setOpen } = useSidebar();
  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };
  useEffect(() => {
    if (isMobile) return;
    const before = latest.current.open;
    if (before) void latest.current.setOpen(false);
    return () => {
      if (latest.current.open !== before) void latest.current.setOpen(before);
    };
  }, [isMobile]);
}

/**
 * Opens the thread list once Segno's space is gone (user 412eb407). Leaving puts the list back as
 * it was before the space folded it (useThreadListFoldedHere), so opening it any earlier would be
 * undone; call the returned function, then leave.
 */
export function useOpenListAfterSegno(inSegno: boolean): () => void {
  const { setOpen } = useSidebar();
  const pending = useRef(false);
  useEffect(() => {
    if (inSegno || !pending.current) return;
    pending.current = false;
    void setOpen(true);
  }, [inSegno, setOpen]);
  return useCallback(() => {
    pending.current = true;
  }, []);
}

export function RubatoSegnoSpace({ children }: { children: ReactNode }) {
  useThreadListFoldedHere();
  const environmentId = useReadyEnvironmentId();
  const { panel, known, refresh } = usePanel(environmentId);
  const now = useNow();
  const state = known ? stageStateOf(panel, new Date(now)) : null;
  const art = useSegnoArt(environmentId, state);
  const space = useRef<HTMLDivElement>(null);
  const stageWidth = useStageWidth(space);
  const compact = stageWidth > 0 && stageWidth < STAGE_FULL_PX;
  return (
    <div ref={space} data-rubato-segno-space="" className="relative flex min-h-0 min-w-0 flex-1">
      {/* The chat is the ordinary chat at its ordinary width. */}
      <div data-rubato-segno-chat="" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
      {/* The stage stands in the room right of the chat's column, over the same surface: the panel
          on top (below the title bar controls, at most 30rem wide against the edge), Segno in the
          bottom-right corner of the height the panel leaves. With little room the panel folds into
          a button and Segno peeks from the corner; with none, the stage steps aside. */}
      {stageWidth > 0 ? (
        <aside
          data-rubato-segno-stage={compact ? "compact" : "full"}
          aria-label="Segno"
          style={{ width: stageWidth, right: STAGE_EDGE_PX }}
          className="pointer-events-none absolute top-[3.25rem] bottom-0 flex min-h-0 flex-col"
        >
          <div className="pointer-events-auto relative ms-auto min-h-0 w-full max-w-[30rem] shrink-0">
            {compact ? (
              <CompactTaskPanel
                environmentId={environmentId}
                panel={panel}
                onChanged={() => void refresh()}
              />
            ) : (
              <SegnoTaskPanel
                environmentId={environmentId}
                panel={panel}
                onChanged={() => void refresh()}
              />
            )}
          </div>
          <div className="relative min-h-0 flex-1" data-rubato-segno-state={state ?? undefined}>
            <SegnoArt art={art} state={state} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}

/**
 * The panel folded for a narrow window: a button with how many things Segno holds; pressing it
 * opens the full panel over the stage's corner until pressed again.
 */
function CompactTaskPanel(props: {
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
  panel: SegnoPanel;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count =
    props.panel.leads.length + props.panel.held.length + (props.panel.inbox?.length ?? 0);
  if (count === 0 && props.panel.finished.length === 0) return null;
  const waiting =
    props.panel.held.length > 0 || props.panel.leads.some((lead) => lead.state === "asked");
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Segno's tasks"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "ms-auto flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-card-foreground text-xs shadow-sm",
          "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {waiting ? (
          <CircleAlertIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
        ) : (
          <PlayIcon aria-hidden="true" className="size-3.5 text-primary" />
        )}
        <span className="tabular-nums">{count}</span>
      </button>
      {open ? (
        <div data-rubato-segno-panel-popover="" className="absolute top-9 right-0 z-30 w-80">
          <SegnoTaskPanel
            environmentId={props.environmentId}
            panel={props.panel}
            onChanged={props.onChanged}
          />
        </div>
      ) : null}
    </>
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
  const inbox = panel.inbox ?? [];
  const count = panel.leads.length + panel.held.length + inbox.length;
  if (count === 0 && finished.length === 0) return null;
  return (
    <section
      data-rubato-segno-panel=""
      className="mb-3 flex max-h-[min(52vh,32rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <header className="flex items-center justify-between px-3.5 pt-2.5 pb-1.5 text-muted-foreground text-xs">
        <span>Segno's tasks</span>
        {count > 0 ? <span className="tabular-nums">{count}</span> : null}
      </header>
      <ul className="flex min-h-0 flex-col overflow-y-auto">
        {panel.leads.map((lead) => (
          <LeadRow key={lead.sessionId} lead={lead} now={now} environmentId={environmentId} />
        ))}
        {panel.held.map((message) => (
          <HeldRow key={message.id} message={message} environmentId={environmentId} onChanged={onChanged} />
        ))}
        {inbox.map((item) => (
          <InboxRow key={item.id} item={item} now={now} />
        ))}
        {finished.map((item) => (
          <FinishedRow key={`${item.sessionId}:${item.at}`} item={item} now={now} environmentId={environmentId} />
        ))}
      </ul>
    </section>
  );
}

function RowIcon({ tone, children }: { tone: "running" | "asked" | "held" | "done" | "stopped" | "inbox"; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
        tone === "running" && "bg-primary/15 text-primary",
        (tone === "asked" || tone === "held") && "bg-warning/15 text-warning-foreground",
        (tone === "done" || tone === "inbox") && "bg-muted text-muted-foreground",
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

const SOURCE_LABELS: Record<string, string> = { telegram: "Telegram" };

/** An inbox item no lead took yet: what came in, from where and whom. */
function InboxRow({ item, now }: { item: SegnoInboxItem; now: number }) {
  const created = Date.parse(item.createdAt);
  return (
    <li data-rubato-segno-row="inbox" className="rubato-segno-row border-border border-t first:border-t-0">
      <div className="flex items-start gap-2.5 px-3.5 py-2">
        <RowIcon tone="inbox">
          <InboxIcon />
        </RowIcon>
        <RowText
          title={item.title}
          detail={parts(SOURCE_LABELS[item.source] ?? item.source, item.reporter, Number.isFinite(created) ? compactSince(created, now) : null)}
        />
      </div>
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
