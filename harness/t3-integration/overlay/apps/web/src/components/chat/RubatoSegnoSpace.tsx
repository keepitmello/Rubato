// Segno's space: its conversation on the left, Segno on the right (companion-edits.mjs wraps the
// chat of Segno's thread in this). The stage carries the task panel — the work Segno handed to
// leads, running or finished until the person closes it, and the replies to other people that wait
// for the person — and Segno's art.
// Everything reads the theme's own colors; the space is see-through to the window material where
// the app has one (RubatoSegnoSpace.css), and the chat, the composer and the panel stay opaque.
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon, ClockIcon, MessageSquareIcon, PlayIcon, SquareIcon, UnplugIcon, XIcon } from "lucide-react";
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { cn } from "../../lib/utils";
import {
  rubatoCompanion,
  useReadyEnvironmentId,
  useRubatoCompanion,
  type SegnoFinished,
  type SegnoHeldMessage,
  type SegnoLead,
  type SegnoPanel,
  type SegnoStageState,
} from "../../state/rubatoCompanion";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import "./RubatoSegnoSpace.css";

/** How often the panel looks again; the engine rewrites it within seconds of a change. */
const PANEL_POLL_MS = 3_000;

const EMPTY: SegnoPanel = { leads: [], finished: [], held: [] };
/** The last panel the server gave, so coming back to the space starts from it, not from nothing. */
const lastPanels = new Map<string, SegnoPanel>();
const CompanionSpace = createContext({ id: "segno", title: "Segno" });

/** `known` is false until the server has answered once; Segno's face waits for it. */
function usePanel(environmentId: ReturnType<typeof useReadyEnvironmentId>, companionId: string) {
  const key = `${environmentId}:${companionId}`;
  const [panel, setPanel] = useState<SegnoPanel | null>(() => lastPanels.get(key) ?? null);
  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const next = await rubatoCompanion.panel(environmentId, companionId);
      lastPanels.set(key, next);
      setPanel(next);
    } catch {
      // A server without the route shows nothing.
    }
  }, [environmentId, companionId, key]);
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
const artCaches = new Map<string, Map<SegnoStageState, string>>();
function useSegnoArt(
  environmentId: ReturnType<typeof useReadyEnvironmentId>,
  state: SegnoStageState | null,
  companionId: string,
) {
  const key = `${environmentId}:${companionId}`;
  if (!artCaches.has(key)) artCaches.set(key, new Map());
  const artCache = artCaches.get(key)!;
  const [loaded, setLoaded] = useState(() => ({ key, art: new Map(artCache) }));
  useEffect(() => {
    if (state === null || artCache.has(state) || environmentId === null) return;
    let live = true;
    void rubatoCompanion
      .art(environmentId, state, companionId)
      .then(({ art }) => {
        artCache.set(state, art.url);
        if (live) setLoaded({ key, art: new Map(artCache) });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [environmentId, state, companionId, artCache, key]);
  // A reused room must drop the other companion's loaded images in this render,
  // not after an effect or a failed request for its own absent artwork.
  return loaded.key === key ? loaded.art : new Map(artCache);
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
/** How long ago, in the unit a person would say it; null under a minute. */
export function elapsed(fromMs: number, nowMs: number): { n: number; unit: "min" | "hr" | "day" } | null {
  const minutes = Math.floor(Math.max(0, nowMs - fromMs) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return { n: minutes, unit: "min" };
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? { n: hours, unit: "hr" } : { n: Math.floor(hours / 24), unit: "day" };
}

// Each status is one phrase with its time in it, so Korean can put the time first ("12분째 작업
// 중", "4분 전 완료"); rubatoI18n.ko.json holds one template per phrase and unit.
const WORKING = { now: "Just started", min: "Working for {0} min", hr: "Working for {0} hr", day: "Working for {0} days" };
const ENDED: Record<SegnoFinished["outcome"], { now: string; min: string; hr: string; day: string }> = {
  completed: { now: "Done just now", min: "Done {0} min ago", hr: "Done {0} hr ago", day: "Done {0} days ago" },
  failed: { now: "Failed just now", min: "Failed {0} min ago", hr: "Failed {0} hr ago", day: "Failed {0} days ago" },
  stopped: { now: "Stopped just now", min: "Stopped {0} min ago", hr: "Stopped {0} hr ago", day: "Stopped {0} days ago" },
  lost: { now: "Cut off just now", min: "Cut off {0} min ago", hr: "Cut off {0} hr ago", day: "Cut off {0} days ago" },
};
const phrase = (words: { now: string; min: string; hr: string; day: string }, fromMs: number, nowMs: number) => {
  const span = elapsed(fromMs, nowMs);
  return span === null ? words.now : words[span.unit].replace("{0}", String(span.n));
};

/** What a lead is doing, as the row says it. */
export function leadStatus(lead: SegnoLead, nowMs: number): string {
  if (lead.state === "asked") return "Waiting for your answer";
  if (lead.state === "queued") return "Not started yet";
  return lead.since === null ? "Working" : phrase(WORKING, lead.since, nowMs);
}

/** How handed work ended and when, as the row says it. */
export function endingStatus(item: SegnoFinished, nowMs: number): string {
  return phrase(ENDED[item.outcome] ?? ENDED.completed, item.at, nowMs);
}

/** Leads that wait for the person first, then the running ones, then the ones not started. */
export function leadsInOrder(leads: readonly SegnoLead[]): SegnoLead[] {
  const rank = { asked: 0, running: 1, queued: 2 } as const;
  return [...leads].sort((a, b) => rank[a.state] - rank[b.state]);
}

/** The key one ending of handed work is closed by (the same conversation can finish again later). */
export const endingKey = (item: Pick<SegnoFinished, "sessionId" | "at">) => `${item.sessionId}@${item.at}`;

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

export function RubatoSegnoSpace({ children, companionId = "segno" }: { children: ReactNode; companionId?: string }) {
  useThreadListFoldedHere();
  const environmentId = useReadyEnvironmentId();
  const choice = useRubatoCompanion().companions.find(item => item.id === companionId);
  const identity = { id: companionId, title: choice?.title ?? "Segno" };
  const { panel, known, refresh } = usePanel(environmentId, companionId);
  const now = useNow();
  const state = known ? stageStateOf(panel, new Date(now)) : null;
  const art = useSegnoArt(environmentId, state, companionId);
  const space = useRef<HTMLDivElement>(null);
  const stageWidth = useStageWidth(space);
  const compact = stageWidth > 0 && stageWidth < STAGE_FULL_PX;
  return (
    <CompanionSpace.Provider value={identity}>
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
          aria-label={identity.title}
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
    </CompanionSpace.Provider>
  );
}

/**
 * The panel folded for a narrow window: a button with how many things are under way; pressing it
 * opens the full panel over the stage's corner until pressed again.
 */
function CompactTaskPanel(props: {
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
  panel: SegnoPanel;
  onChanged: () => void;
}) {
  const identity = useContext(CompanionSpace);
  const [open, setOpen] = useState(false);
  const count = props.panel.leads.length + props.panel.held.length;
  if (count === 0 && props.panel.finished.length === 0) return null;
  const waiting =
    props.panel.held.length > 0 || props.panel.leads.some((lead) => lead.state === "asked");
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${identity.title}'s tasks`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "ms-auto flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-card-foreground text-xs shadow-sm",
          "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {waiting ? (
          <CircleAlertIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
        ) : count > 0 ? (
          <PlayIcon aria-hidden="true" className="size-3.5 text-primary" />
        ) : (
          <CheckIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        )}
        <span className="tabular-nums">{count > 0 ? count : props.panel.finished.length}</span>
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

/**
 * What Segno holds for the person, in two parts: what is under way (replies waiting for approval,
 * leads that asked, running or not started yet) and what finished, which stays until the person
 * closes it. Each row says what the work is, in which folder, and what it is doing since when.
 */
function SegnoTaskPanel({
  environmentId,
  panel,
  onChanged,
}: {
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
  panel: SegnoPanel;
  onChanged: () => void;
}) {
  const identity = useContext(CompanionSpace);
  const now = useNow();
  // Closed rows leave at once; the server's answer follows.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const finished = useMemo(
    () => panel.finished.filter((item) => !closed.has(endingKey(item))),
    [panel.finished, closed],
  );
  const leads = useMemo(() => leadsInOrder(panel.leads), [panel.leads]);
  const dismiss = useCallback(
    async (items: readonly SegnoFinished[]) => {
      if (environmentId === null || items.length === 0) return;
      setClosed((current) => new Set([...current, ...items.map(endingKey)]));
      try {
        await rubatoCompanion.dismiss(environmentId, items, identity.id);
      } catch {
        // The server kept them: they come back on the next look.
        setClosed((current) => {
          const next = new Set(current);
          for (const item of items) next.delete(endingKey(item));
          return next;
        });
      }
      onChanged();
    },
    [environmentId, onChanged, identity.id],
  );
  const underway = leads.length + panel.held.length;
  if (underway === 0 && finished.length === 0) return null;
  return (
    <section
      data-rubato-segno-panel=""
      className="mb-3 flex max-h-[min(52vh,32rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <header className="px-3.5 pt-2.5 pb-1 font-medium text-sm">{identity.title}'s tasks</header>
      <div className="flex min-h-0 flex-col overflow-y-auto pb-1">
        {underway > 0 ? (
          <>
            <SectionLabel label="In progress" count={underway} />
            <ul data-rubato-segno-section="underway" className="flex flex-col">
              {panel.held.map((message) => (
                <HeldRow key={message.id} message={message} environmentId={environmentId} onChanged={onChanged} />
              ))}
              {leads.map((lead) => (
                <LeadRow key={lead.sessionId} lead={lead} now={now} environmentId={environmentId} />
              ))}
            </ul>
          </>
        ) : null}
        {finished.length > 0 ? (
          <>
            <SectionLabel label="Finished work" count={finished.length}>
              {finished.length > 1 ? (
                <button
                  type="button"
                  onClick={() => void dismiss(finished)}
                  className="cursor-pointer rounded px-1 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Close all
                </button>
              ) : null}
            </SectionLabel>
            <ul data-rubato-segno-section="finished" className="flex flex-col">
              {finished.map((item) => (
                <FinishedRow
                  key={endingKey(item)}
                  item={item}
                  now={now}
                  environmentId={environmentId}
                  onClose={() => void dismiss([item])}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}

function SectionLabel({ label, count, children }: { label: string; count: number; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 pt-2 pb-1 text-muted-foreground text-xs">
      <span className="flex items-center gap-1.5">
        <span>{label}</span>
        <span className="tabular-nums" translate="no">
          {count}
        </span>
      </span>
      {children}
    </div>
  );
}

type RowTone = "running" | "asked" | "queued" | "held" | "done" | "failed" | "stopped";

function RowIcon({ tone, children }: { tone: RowTone; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
        tone === "running" && "bg-primary/15 text-primary",
        (tone === "asked" || tone === "held") && "bg-warning/15 text-warning-foreground",
        (tone === "queued" || tone === "stopped") && "bg-muted text-muted-foreground",
        tone === "done" && "bg-success/15 text-success-foreground",
        tone === "failed" && "bg-destructive/10 text-destructive-foreground",
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
      className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 px-3.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/**
 * The title is the lead's own words and stays as written; each detail is its own text, so the
 * Korean dictionary (rubatoI18n) finds the words.
 */
function RowText({ title, detail }: { title: string | null; detail: readonly string[] }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      {title === null ? (
        <span className="truncate font-medium text-sm">Untitled</span>
      ) : (
        <span className="truncate font-medium text-sm" translate="no" title={title}>
          {title}
        </span>
      )}
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
  return (
    <li data-rubato-segno-row={lead.state} className="rubato-segno-row flex transition-colors hover:bg-accent/60">
      <RowButton onClick={() => void open(lead.sessionId)}>
        <RowIcon tone={lead.state}>
          {lead.state === "asked" ? <CircleAlertIcon /> : lead.state === "queued" ? <ClockIcon /> : <PlayIcon />}
        </RowIcon>
        <RowText title={lead.title} detail={parts(projectOf(lead.cwd), leadStatus(lead, now))} />
      </RowButton>
    </li>
  );
}

function FinishedRow({
  item,
  now,
  environmentId,
  onClose,
}: {
  item: SegnoFinished;
  now: number;
  environmentId: ReturnType<typeof useReadyEnvironmentId>;
  onClose: () => void;
}) {
  const open = useOpenLead(environmentId);
  const tone: RowTone = item.outcome === "completed" ? "done" : item.outcome === "failed" ? "failed" : "stopped";
  return (
    <li data-rubato-segno-row="finished" className="rubato-segno-row rubato-segno-finished group flex items-start transition-colors hover:bg-accent/60">
      <RowButton onClick={() => void open(item.sessionId)}>
        <RowIcon tone={tone}>
          {tone === "done" ? <CheckIcon /> : tone === "failed" ? <XIcon /> : item.outcome === "lost" ? <UnplugIcon /> : <SquareIcon />}
        </RowIcon>
        <RowText title={item.title} detail={parts(projectOf(item.cwd), endingStatus(item, now))} />
      </RowButton>
      {/* Closing takes the row off this panel only; the conversation stays where it is. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={cn(
          "me-2 mt-2 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground [&_svg]:size-3.5",
          "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      >
        <XIcon />
      </button>
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
  const identity = useContext(CompanionSpace);
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
      await rubatoCompanion.decideTelegram(environmentId, message.id, decision, edited, identity.id);
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
