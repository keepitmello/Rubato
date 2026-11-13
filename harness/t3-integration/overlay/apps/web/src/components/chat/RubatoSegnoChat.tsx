// Segno's chat room (user f38c36a6): the thread drawn as a messenger, not as a work log. It stands
// where the ordinary timeline stands in Segno's thread (companion-edits.mjs, ChatView) and reads the
// same timeline. The person's bubbles sit on the right in the accent color, Segno's on the left in a
// soft glass tone; a group's last bubble carries the tail; time lines mark long gaps; three dots
// bounce in Segno's bubble while it writes an answer. A bubble that arrives while the room is open
// springs in: up from the composer for the person's, a short pop for Segno's. Motion stops for
// prefers-reduced-motion (RubatoSegnoChat.css).
//
// Between the bubbles, one quiet line holds what the companion did there — thinking, words to itself,
// tools, what woke it — and opens in place (RubatoSegnoInner.tsx, user f8828a9f). The person's own
// bubble shows a pencil on hover, as an ordinary thread does (RubatoMessageEdit.tsx, user 97580a28):
// the bubble becomes an editor, and sending rewinds to just before that message and sends the edit.
// Its menu (right click, or a long press) offers the same edit, and "Rewind from here": the
// conversation goes back to just before that message and the message returns to the composer.
// Files stay either way: the companion's home is its own record (diary, notes), committed as it goes.
//
// Two things the companion did stay out of that line, because the person needs them without opening
// it: a conversation it started or forked shows as a work card that follows that conversation live
// (RubatoWorkCard.tsx), and a record it committed to its home leaves one grey line with its own words
// for the change ("Memory changed · …"), read from the conversation's own segno_commit call — so the
// line is this conversation's change, not a file change seen from outside.
//
// The room has what an ordinary thread has for moving through a long conversation: the timeline at
// its left edge, one mark per turn with the person's words and the answer on hover (the same
// RubatoTimelineRail an ordinary thread draws), and "Scroll to end" over the composer once the reader
// has left the end; it counts the companion's messages that arrive meanwhile. The room draws its
// latest three days, each under its day's name that stays at the top while the day scrolls by, and
// draws the day before as the reader nears the top. Page keys move the room from the composer or
// from anywhere outside a field, a bubble shows its time on hover, and either side's bubble has a
// menu with Copy (user f7c42421).
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ThreadId, type EnvironmentId, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon } from "lucide-react";

import { useAssetUrls } from "~/assets/assetUrls";
import { subscribeUiLanguage, uiLanguage } from "../../rubatoI18n";
import { selectMessageImageResources, type TimelineEntry } from "../../session-logic";
import type { ChatImageAttachment, ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { useRubatoCompanion } from "../../state/rubatoCompanion";
import {
  editRubatoMessage,
  RubatoEditMessageButton,
  RubatoMessageEditor,
  useRubatoMessageEditing,
} from "./RubatoMessageEdit";
import { RubatoSegnoSpanLine, useSegnoSpanSummaries } from "./RubatoSegnoInner";
import { RubatoWorkCard } from "./RubatoWorkCard";
import { rubatoLaunchOfSegno } from "./rubatoWorkCardModel";
import type { SegnoSpanSummary } from "../../state/rubatoCompanion";
import { RubatoTimelineRail } from "./RubatoTimelineRail";
import { railDayTitle } from "./rubatoTimelineRail.logic";
import {
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHitStripWidth,
} from "./MessagesTimeline.logic";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import {
  arrivals,
  ROOM_RECENT_DAYS,
  segnoChatItems,
  segnoDays,
  segnoDaysThrough,
  segnoDrawStart,
  segnoIsWriting,
  segnoSpans,
  segnoTurnMarks,
  type SegnoChatItem,
  type SegnoChatMessageInput,
} from "./rubatoSegnoRoom";
import "./RubatoSegnoChat.css";
import { RubatoCallCard } from "./RubatoCallCard";
import { callPlacement, withoutCallSpeech } from "./rubatoCallRoom";
import { useRoomCalls } from "../../state/rubatoCall";

/** Closer to the end than this, the room follows new bubbles down. */
const FOLLOW_PX = 64;
/** How long the room's own smooth scroll to the end may take; its frames do not count as leaving. */
const GLIDE_MS = 1_000;
/** "Scroll to end" waits this long after the reader leaves the end, so passing frames do not flash it. */
const PILL_DELAY_MS = 150;
/** Room left above a turn the timeline jumps to, under the title bar (the lane's pt-14). */
const JUMP_TOP_PX = 64;
/** Closer to the top than this, the room draws the day before (or asks for earlier history). */
const EARLIER_PX = 200;

export interface SegnoHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly onLoadEarlier: () => void;
}

function messagesOf(entries: ReadonlyArray<TimelineEntry>): SegnoChatMessageInput[] {
  const messages: SegnoChatMessageInput[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    messages.push({
      id: entry.message.id,
      role: entry.message.role,
      text: entry.message.text,
      createdAt: entry.message.createdAt,
      streaming: entry.message.streaming,
      attachments: entry.message.attachments,
    });
  }
  return messages;
}

function useLocale(): string | undefined {
  const language = useSyncExternalStore(subscribeUiLanguage, uiLanguage, uiLanguage);
  return language === "ko" ? "ko-KR" : undefined;
}

/** The tail at a group's last bubble, drawn in the bubble's own color (--rubato-bubble). */
function Tail() {
  return (
    <svg data-rubato-segno-tail="" viewBox="0 0 12 16" aria-hidden="true">
      <path d="M0 0 L0 16 C3 16 9 16.5 12 15 C8 13.5 6 10 6 4 L6 0 Z" />
    </svg>
  );
}

/** The person's pictures, drawn the way the ordinary thread draws them (MessagesTimeline). */
function Images({ images, environmentId }: { images: ReadonlyArray<ChatImageAttachment>; environmentId: EnvironmentId }) {
  const resources = useMemo(() => selectMessageImageResources(images), [images]);
  const urls = useAssetUrls(environmentId, resources);
  const urlById = new Map(resources.flatMap((resource, index) => (urls[index] ? [[resource.attachmentId, urls[index]!] as const] : [])));
  return (
    <div data-rubato-segno-images="">
      {images.map((image) => {
        const src = urlById.get(image.id) ?? image.previewUrl;
        return src ? (
          <a key={image.id} href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={image.name ?? ""} />
          </a>
        ) : (
          <span key={image.id} data-rubato-segno-image-pending="">{image.name}</span>
        );
      })}
    </div>
  );
}

/** How long a finger rests on a bubble before its menu opens. */
const LONG_PRESS_MS = 500;

/** A bubble's menu: copy, and on the person's bubble edit it or rewind the conversation to just before it. */
function BubbleMenu({
  text,
  onEdit,
  onRewind,
  onClose,
}: {
  text: string;
  onEdit: (() => void) | undefined;
  onRewind: (() => void) | undefined;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={menu} role="menu" data-rubato-segno-menu="">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          onClose();
        }}
      >
        Copy
      </button>
      {onEdit ? (
        <button
          type="button"
          role="menuitem"
          data-rubato-segno-edit-item=""
          onClick={() => {
            onClose();
            onEdit();
          }}
        >
          Edit message
        </button>
      ) : null}
      {onRewind ? (
        <button
          type="button"
          role="menuitem"
          data-rubato-segno-rewind=""
          onClick={() => {
            onClose();
            onRewind();
          }}
        >
          <span>Rewind from here</span>
          <small>This message and everything after it leave the conversation. Diary and record files stay.</small>
        </button>
      ) : null}
    </div>
  );
}

/** The hover time beside a bubble: the clock, with the full date on a longer hover. */
function BubbleTime({ at, locale }: { at: number; locale: string | undefined }) {
  const date = new Date(at);
  return (
    <time
      data-rubato-segno-at=""
      dateTime={date.toISOString()}
      title={new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(date)}
    >
      {new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)}
    </time>
  );
}

/** Text selected inside this element: the browser's own menu copies it, so ours stays away. */
function selectsWithin(element: Element): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== "" && element.contains(selection.anchorNode);
}

/** What editing the person's bubble needs: ChatView's edit host is keyed by the thread. */
interface BubbleEdit {
  threadKey: string;
  message: ChatMessage;
  /** A turn runs: the editor keeps its draft and waits to send. */
  busy: boolean;
}

function Bubble({
  item,
  enter,
  mark,
  locale,
  cwd,
  environmentId,
  threadRef,
  onRewind,
  edit,
}: {
  item: Extract<SegnoChatItem, { kind: "bubble" }>;
  enter: boolean;
  /** The bubble starts a turn: the timeline at the left edge has a mark for it. */
  mark: boolean;
  locale: string | undefined;
  cwd: string | undefined;
  environmentId: EnvironmentId | undefined;
  /**
   * The companion's thread: ChatMarkdown loads a file named by an absolute path through it, so a
   * picture or a video the companion sent draws in place and any other file opens in the side panel,
   * as in an ordinary thread.
   */
  threadRef: ScopedThreadRef | undefined;
  /** The person's bubble only: rewinds the conversation to just before it. */
  onRewind?: (() => void) | undefined;
  /** The person's bubble only: edits it in place. */
  edit?: BubbleEdit | undefined;
}) {
  const [menu, setMenu] = useState(false);
  const press = useRef<number | undefined>(undefined);
  const endPress = () => {
    if (press.current !== undefined) window.clearTimeout(press.current);
    press.current = undefined;
  };
  const closeMenu = useCallback(() => setMenu(false), []);
  const editing = useRubatoMessageEditing(edit?.threadKey ?? "", item.id as MessageId);
  if (editing && edit) {
    return (
      <div data-rubato-segno-row="" data-side={item.side} data-group-start="" data-group-end="" data-editing="">
        <div data-rubato-segno-editor="">
          <RubatoMessageEditor threadKey={edit.threadKey} message={edit.message} busy={edit.busy} />
        </div>
      </div>
    );
  }
  return (
    <div
      data-rubato-segno-row=""
      data-rubato-segno-mark={mark ? item.id : undefined}
      data-side={item.side}
      data-group-start={item.groupStart ? "" : undefined}
      data-group-end={item.groupEnd ? "" : undefined}
      data-enter={enter ? (item.side === "me" ? "send" : "arrive") : undefined}
      data-menu-open={menu ? "" : undefined}
    >
      <div
        data-rubato-segno-bubble=""
        data-thread-find-text=""
        onContextMenu={(event: ReactMouseEvent) => {
          if (selectsWithin(event.currentTarget)) return;
          event.preventDefault();
          setMenu(true);
        }}
        onPointerDown={(event: ReactPointerEvent) => {
          if (event.pointerType !== "touch") return;
          endPress();
          press.current = window.setTimeout(() => setMenu(true), LONG_PRESS_MS);
        }}
        onPointerUp={endPress}
        onPointerMove={endPress}
        onPointerCancel={endPress}
      >
        {item.images.length > 0 && environmentId ? <Images images={item.images} environmentId={environmentId} /> : null}
        {item.side === "segno" ? (
          <ChatMarkdown text={item.text} cwd={cwd} threadRef={threadRef} isStreaming={item.streaming} lineBreaks />
        ) : item.text ? (
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
        ) : null}
        {item.files ? <ChatMarkdown text={item.files} cwd={cwd} threadRef={threadRef} isStreaming={false} /> : null}
        {item.attachmentNames.length > 0 ? (
          <div data-rubato-segno-attachments="">
            {item.attachmentNames.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        ) : null}
        {item.groupEnd ? <Tail /> : null}
      </div>
      <BubbleTime at={item.at} locale={locale} />
      {edit ? (
        <span data-rubato-segno-edit="">
          {/* Opens while the companion works too: the editor keeps the draft and waits to send. */}
          <RubatoEditMessageButton threadKey={edit.threadKey} messageId={edit.message.id} busy={false} />
        </span>
      ) : null}
      {menu ? (
        <BubbleMenu
          text={item.text}
          onEdit={edit ? () => editRubatoMessage(edit.threadKey, edit.message.id) : undefined}
          onRewind={onRewind}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}

function Writing() {
  return (
    <div data-rubato-segno-row="" data-side="segno" data-group-start="" data-group-end="" data-enter="arrive">
      <div data-rubato-segno-bubble="" data-rubato-segno-writing="" role="status" aria-label="Segno is writing">
        <span />
        <span />
        <span />
        <Tail />
      </div>
    </div>
  );
}

export function RubatoSegnoChat(props: {
  entries: ReadonlyArray<TimelineEntry>;
  working: boolean;
  cwd: string | undefined;
  /** Where the thread's attachments are served from. */
  environmentId?: EnvironmentId | undefined;
  /** Room kept under the last bubble for the composer that floats over the room. */
  bottomInset: number;
  /** Where "Scroll to end" floats: just above the composer (ChatView measures it). */
  scrollToEndClearance?: number | undefined;
  historyControls?: SegnoHistoryControls | undefined;
  /** The companion's thread. */
  threadId?: string | undefined;
  /** ChatView's key for the thread, which its message edit host answers to (RubatoMessageEdit.tsx). */
  threadKey?: string | undefined;
  /**
   * Rewinds the conversation to just before `messageId` and puts it back in the composer, files
   * untouched (ChatView's revert, which a companion room takes through RubatoCompanionRewind.ts).
   */
  onRewind?: ((messageId: MessageId) => void) | undefined;
}) {
  const companionChoice = useRubatoCompanion().companions.find((item) => item.threadId === props.threadId);
  const companionId = companionChoice?.id;
  // A call's card replaces the person's call speech the thread kept (rubatoCallRoom.ts).
  const calls = useRoomCalls(props.environmentId ?? null, companionId);
  const items = useMemo(() => segnoChatItems(withoutCallSpeech(messagesOf(props.entries), calls)), [props.entries, calls]);
  const placement = useMemo(() => callPlacement(items, calls), [items, calls]);
  const messageById = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const entry of props.entries) if (entry.kind === "message") byId.set(entry.message.id, entry.message);
    return byId;
  }, [props.entries]);
  const writing = segnoIsWriting(items, props.working);
  const locale = useLocale();
  const partial = props.historyControls?.hasMoreHistory === true;
  const spans = useMemo(() => segnoSpans(items, { writing: props.working, partial }), [items, props.working, partial]);
  const summaries = useSegnoSpanSummaries({
    environmentId: props.environmentId,
    companionId,
    boundaries: spans.boundaries,
    after: spans.after,
    working: props.working,
  });
  const { environmentId, threadId, threadKey, onRewind } = props;
  const editOf = (id: string): BubbleEdit | undefined => {
    const message = threadKey ? messageById.get(id) : undefined;
    return message && threadKey && message.role === "user" ? { threadKey, message, busy: props.working } : undefined;
  };
  const threadRef = useMemo(
    () => (environmentId && threadId ? scopeThreadRef(environmentId, ThreadId.make(threadId)) : undefined),
    [environmentId, threadId],
  );
  const rewind = useCallback((messageId: string) => onRewind?.(messageId as MessageId), [onRewind]);
  // The work behind a reply stands above its bubble; what came of it (cards, memory changes) below.
  const spanOutcome = (place: (typeof spans)["tail"] | undefined, key: string) =>
    place ? <SegnoSpanOutcome key={`${key}:outcome`} summary={summaries[place.index]} environmentId={environmentId} locale={locale} /> : null;
  const spanLine = (place: (typeof spans)["tail"] | undefined, key: string) =>
    place ? [
      <RubatoSegnoSpanLine
        key={key}
        place={place}
        summary={summaries[place.index]}
        companionId={companionId}
        environmentId={environmentId}
        locale={locale}
      />,
      place.placement === "attached" ? null : spanOutcome(place, key),
    ] : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Bubbles already there when the room's history first arrives stay still; later ones spring in.
  const seen = useRef<{ ids: Set<string>; latest: number } | null>(null);
  const animated = useRef(new Set<string>());
  // Bubbles that arrived since the last render, read once by the effect that follows them.
  const fresh = useRef<string[]>([]);
  useMemo(() => {
    const bubbles = items.filter((item) => item.kind === "bubble");
    if (seen.current === null) {
      if (bubbles.length > 0)
        seen.current = { ids: new Set(bubbles.map((item) => item.id)), latest: Math.max(...bubbles.map((item) => item.at)) };
      return;
    }
    for (const id of arrivals(bubbles, seen.current)) {
      animated.current.add(id);
      fresh.current.push(id);
    }
  }, [items]);

  const marks = useMemo(() => segnoTurnMarks(items), [items]);
  const markIds = useMemo(() => new Set(marks.map((mark) => mark.id)), [marks]);
  const scroller = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const opened = useRef(false);
  // Until this time the room's own smooth scroll to the end is under way. A reader's gesture ends it.
  const glideUntil = useRef(0);
  const pillTimer = useRef<number | undefined>(undefined);
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  // The companion's messages that arrived while the reader was away from the end.
  const [unread, setUnread] = useState(0);
  const [stripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [currentMark, setCurrentMark] = useState<number | null>(null);
  const [gutter, setGutter] = useState({ persistent: false, hitStripWidth: 0 });

  // The room draws its latest days (user 1d2f3875). Near the top it draws one more day; once every
  // loaded day is drawn it asks the thread for earlier history. The timeline at the left edge keeps
  // a mark for every loaded turn, the undrawn ones dimmer; choosing one draws back to its day.
  const [drawnDays, setDrawnDays] = useState(ROOM_RECENT_DAYS);
  const drawStart = useMemo(() => segnoDrawStart(items, drawnDays), [items, drawnDays]);
  const days = useMemo(() => segnoDays(items, drawStart), [items, drawStart]);
  const markTimes = useMemo(() => marks.map((mark) => items[mark.rowIndex]?.at ?? null), [marks, items]);
  const undrawnMarks = useMemo(
    () => new Set(marks.filter((mark) => mark.rowIndex < drawStart).map((mark) => mark.id)),
    [marks, drawStart],
  );
  const history = props.historyControls;
  // What the reader looks at before more is drawn above it, so it stays where it was on screen.
  const anchorBeforeDraw = useRef<{ row: HTMLElement; top: number } | null>(null);
  const awaitingHistory = useRef(false);
  // A mark on a day not drawn yet: the room draws back to it, then goes there.
  const pendingJump = useRef<string | null>(null);
  const holdReadingPosition = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll<HTMLElement>("[data-rubato-segno-row]")) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) {
        anchorBeforeDraw.current = { row, top: box.top - top };
        return;
      }
    }
  }, []);
  const drawEarlier = useCallback(() => {
    if (anchorBeforeDraw.current !== null || pendingJump.current !== null) return;
    if (drawStart > 0) {
      holdReadingPosition();
      setDrawnDays((count) => count + 1);
    } else if (history?.hasMoreHistory && !history.loading) {
      holdReadingPosition();
      awaitingHistory.current = true;
      history.onLoadEarlier();
    }
  }, [drawStart, history, holdReadingPosition]);
  const drawEarlierRef = useRef(drawEarlier);
  useLayoutEffect(() => {
    drawEarlierRef.current = drawEarlier;
  }, [drawEarlier]);
  // History that failed to arrive leaves nothing to hold.
  const historyLoading = history?.loading === true;
  useEffect(() => {
    if (historyLoading || !awaitingHistory.current) return;
    awaitingHistory.current = false;
    anchorBeforeDraw.current = null;
  }, [historyLoading]);

  // Which turns are in view, and which one the reader is at, the way the ordinary timeline works it out.
  const placeMarks = useCallback(() => {
    const element = scroller.current;
    if (!element || marks.length === 0) return;
    const box = element.getBoundingClientRect();
    const rows = new Map<string, HTMLElement>();
    for (const row of element.querySelectorAll<HTMLElement>("[data-rubato-segno-mark]"))
      rows.set(row.dataset.rubatoSegnoMark!, row);
    const scrollTop = element.scrollTop;
    const scrollBottom = scrollTop + element.clientHeight;
    const itemBounds = marks.map((mark) => {
      const rect = rows.get(mark.id)?.getBoundingClientRect();
      return rect ? { top: rect.top - box.top + scrollTop, height: rect.height } : { top: null, height: null };
    });
    for (const [index, mark] of marks.entries()) {
      const strip = stripMap.get(mark.id);
      const bounds = itemBounds[index]!;
      const inView =
        bounds.top !== null && bounds.top < scrollBottom && bounds.top + Math.max(1, bounds.height ?? 1) > scrollTop;
      const next = inView ? "true" : "false";
      if (strip && strip.dataset.inView !== next) strip.dataset.inView = next;
    }
    const next = resolveTimelineMinimapCurrentIndex({ scrollTop, scrollBottom, itemBounds });
    setCurrentMark((current) => (current === next ? current : next));
  }, [marks, stripMap]);
  const markFrame = useRef<number | null>(null);
  const schedulePlaceMarks = useCallback(() => {
    if (markFrame.current !== null) return;
    markFrame.current = requestAnimationFrame(() => {
      markFrame.current = null;
      placeMarks();
    });
  }, [placeMarks]);
  useEffect(() => {
    schedulePlaceMarks();
    return () => {
      if (markFrame.current !== null) cancelAnimationFrame(markFrame.current);
      markFrame.current = null;
    };
  }, [schedulePlaceMarks]);
  // The marks stay in the side gutter and never cover the bubbles; with no gutter they go inert.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      const viewportWidth = element.getBoundingClientRect().width;
      const contentWidth = lane.current?.getBoundingClientRect().width ?? viewportWidth;
      const persistent = resolveTimelineMinimapHasPersistentGutter(viewportWidth, contentWidth);
      const hitStripWidth = resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth);
      setGutter((current) =>
        current.persistent === persistent && current.hitStripWidth === hitStripWidth ? current : { persistent, hitStripWidth },
      );
      schedulePlaceMarks();
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (lane.current) observer.observe(lane.current);
    return () => observer.disconnect();
  }, [schedulePlaceMarks]);

  const settlePill = useCallback(() => {
    if (atEnd.current) {
      window.clearTimeout(pillTimer.current);
      pillTimer.current = undefined;
      setAwayFromEnd(false);
      setUnread(0);
    } else if (pillTimer.current === undefined) {
      pillTimer.current = window.setTimeout(() => {
        pillTimer.current = undefined;
        setAwayFromEnd(!atEnd.current);
      }, PILL_DELAY_MS);
    }
  }, []);
  useEffect(() => () => window.clearTimeout(pillTimer.current), []);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_PX;
    if (near) glideUntil.current = 0;
    atEnd.current = near || performance.now() < glideUntil.current;
    settlePill();
    schedulePlaceMarks();
    if (opened.current && element.scrollTop < EARLIER_PX && element.scrollHeight > element.clientHeight)
      drawEarlierRef.current();
  }, [settlePill, schedulePlaceMarks]);
  const readerMoves = useCallback(() => {
    glideUntil.current = 0;
  }, []);
  const glideToEnd = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    glideUntil.current = performance.now() + GLIDE_MS;
    atEnd.current = true;
    settlePill();
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [settlePill]);
  // What just arrived: the person's own message brings the room to the end, as sending does in any
  // messenger; the companion's, while the reader is up the conversation, counts on the pill.
  useEffect(() => {
    const arrived = fresh.current;
    fresh.current = [];
    if (arrived.length === 0) return;
    const sides = new Map(items.flatMap((item) => (item.kind === "bubble" ? [[item.id, item.side] as const] : [])));
    if (arrived.some((id) => sides.get(id) === "me")) glideToEnd();
    else if (!atEnd.current) setUnread((count) => count + arrived.filter((id) => sides.get(id) === "segno").length);
  }, [items, glideToEnd]);
  // Page keys move the room when no field has them: PageUp/PageDown, the arrows, Home and End.
  const bottomInset = props.bottomInset;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const element = scroller.current;
      if (!element || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const free =
        target === document.body ||
        target === document.documentElement ||
        (target instanceof Element &&
          element.contains(target) &&
          target.closest("input, textarea, select, button, summary, a, [contenteditable]") === null);
      if (!free || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const page = Math.max(40, element.clientHeight - bottomInset - 80);
      const by = (delta: number, behavior: ScrollBehavior) => {
        glideUntil.current = 0;
        element.scrollBy({ top: delta, behavior });
      };
      switch (event.key) {
        case "PageUp":
          by(-page, "smooth");
          break;
        case "PageDown":
          by(page, "smooth");
          break;
        case "ArrowUp":
          by(-40, "auto");
          break;
        case "ArrowDown":
          by(40, "auto");
          break;
        case "Home":
          glideUntil.current = 0;
          element.scrollTo({ top: 0, behavior: "smooth" });
          break;
        case "End":
          glideToEnd();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bottomInset, glideToEnd]);
  const jumpToMark = useCallback((id: string) => {
    const mark = marks.find((each) => each.id === id);
    if (mark && mark.rowIndex < drawStart) {
      pendingJump.current = id;
      anchorBeforeDraw.current = null;
      setDrawnDays(segnoDaysThrough(items, mark.rowIndex));
      return;
    }
    const element = scroller.current;
    const row = element?.querySelector<HTMLElement>(`[data-rubato-segno-mark="${CSS.escape(id)}"]`);
    if (!element || !row) return;
    glideUntil.current = 0;
    const top = row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    element.scrollTo({ top: Math.max(0, top - JUMP_TOP_PX), behavior: "smooth" });
  }, [marks, drawStart, items]);
  const forwardWheel = useCallback((event: WheelEvent) => {
    if (scroller.current) forwardWheelToTimeline(event, scroller.current);
  }, []);

  // Drawing earlier days keeps the bubble in view where it was.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (pendingJump.current !== null) {
      const row = element.querySelector<HTMLElement>(`[data-rubato-segno-mark="${CSS.escape(pendingJump.current)}"]`);
      pendingJump.current = null;
      if (row) {
        glideUntil.current = 0;
        atEnd.current = false;
        const top = row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
        element.scrollTo({ top: Math.max(0, top - JUMP_TOP_PX), behavior: "instant" });
      }
      return;
    }
    const anchor = anchorBeforeDraw.current;
    if (anchor !== null) {
      anchorBeforeDraw.current = null;
      if (anchor.row.isConnected) {
        element.scrollTop += anchor.row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.top;
      }
      // Earlier history may land on days not drawn yet; still at the top, the room draws on.
      if (element.scrollTop < EARLIER_PX && element.scrollHeight > element.clientHeight)
        requestAnimationFrame(() => drawEarlierRef.current());
      return;
    }
    if (!opened.current || atEnd.current) {
      if (opened.current) glideToEnd();
      else element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      atEnd.current = true;
    }
    opened.current = true;
  }, [items, writing, props.bottomInset, glideToEnd, drawStart]);

  return (
    <div data-rubato-segno-room="" className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scroller}
      onScroll={onScroll}
      onWheel={readerMoves}
      onTouchStart={readerMoves}
      onPointerDown={readerMoves}
      onKeyDown={readerMoves}
      data-rubato-segno-scroller=""
      className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
    >
      <div ref={lane} className="chat-content-lane flex flex-col pt-14" style={{ paddingBottom: props.bottomInset + 20 }}>
        {drawStart > 0 || history?.hasMoreHistory ? (
          <button type="button" data-rubato-segno-earlier="" disabled={history?.loading === true} onClick={drawEarlier}>
            {history?.loading ? "Loading…" : "Load earlier messages"}
          </button>
        ) : null}
        {days.map((day) => (
          <section key={day.key} data-rubato-segno-day="">
            <div data-rubato-segno-day-name="">
              <span className="surface-glass">{railDayTitle(day.at, now, locale)}</span>
            </div>
            {items.slice(day.from, day.to).map((item, offset) => {
          const index = day.from + offset;
          if (item.kind === "separator") {
            // Work that led to no reply happened before the person's next message, so its line
            // stands above that message's time line.
            const next = items[index + 1];
            const quiet = next?.kind === "bubble" && next.side === "me" ? spans.before.get(next.id) : undefined;
            return [
              spanLine(quiet, `span:${next?.id}`),
              <div key={item.id} data-rubato-segno-time="">
                {clockAt(item.at, locale)}
              </div>,
            ];
          }
          const separated = items[index - 1]?.kind === "separator";
          const place = spans.before.get(item.id);
          return [
            ...(placement.before.get(item.id) ?? []).map((call) => (
              <RubatoCallCard key={call.id} call={call} title={companionChoice?.title ?? call.companion} locale={locale} />
            )),
            item.side === "segno" || !separated ? spanLine(place, `span:${item.id}`) : null,
            <Bubble
              key={item.id}
              item={item}
              enter={animated.current.has(item.id)}
              mark={markIds.has(item.id)}
              locale={locale}
              cwd={props.cwd}
              environmentId={props.environmentId}
              threadRef={threadRef}
              onRewind={item.side === "me" && onRewind && threadId ? () => rewind(item.id) : undefined}
              edit={item.side === "me" ? editOf(item.id) : undefined}
            />,
            place?.placement === "attached" ? spanOutcome(place, `span:${item.id}`) : null,
          ];
            })}
          </section>
        ))}
        {writing ? <Writing /> : null}
        {spanLine(spans.tail, "span:tail")}
        {placement.tail.map((call) => (
          <RubatoCallCard key={call.id} call={call} title={companionChoice?.title ?? call.companion} locale={locale} />
        ))}
      </div>
    </div>
    <RubatoTimelineRail
      items={marks}
      times={markTimes}
      pendingIds={undrawnMarks}
      hasPersistentGutter={gutter.persistent}
      hitStripWidth={gutter.hitStripWidth}
      currentIndex={currentMark}
      stripMap={stripMap}
      onWheel={forwardWheel}
      onSelect={(mark) => jumpToMark(mark.id)}
    />
    {awayFromEnd ? (
      <div
        className="chat-scroll-to-bottom pointer-events-none absolute inset-x-0 z-30 flex justify-center py-1.5"
        style={{ bottom: (props.scrollToEndClearance ?? props.bottomInset) + 4 }}
      >
        <Button
          aria-label="Scroll to end"
          onPointerDown={(event) => event.preventDefault()}
          onClick={glideToEnd}
          className="pointer-events-auto"
          size="xs"
          variant="glass"
        >
          <ChevronDownIcon className="size-3.5" />
          {unread === 0 ? "Scroll to end" : unread === 1 ? "1 new message" : `${unread} new messages`}
        </Button>
      </div>
    ) : null}
    </div>
  );
}

function clockAt(at: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}

/**
 * What came of one span that the person should see without opening its line: the conversations the
 * companion launched, as work cards, and each record it committed, as one grey line.
 */
function SegnoSpanOutcome({
  summary,
  environmentId,
  locale,
}: {
  summary: SegnoSpanSummary | null | undefined;
  environmentId: EnvironmentId | undefined;
  locale: string | undefined;
}) {
  const launches = summary?.launches ?? [];
  const commits = summary?.commits ?? [];
  if (launches.length === 0 && commits.length === 0) return null;
  return (
    <>
      {launches.map((launch) => (
        <div key={`launch:${launch.id}`} data-rubato-segno-work="">
          <RubatoWorkCard launch={rubatoLaunchOfSegno(launch)} environmentId={environmentId ?? null} />
        </div>
      ))}
      {commits.map((commit) => (
        <p key={`commit:${commit.id}`} data-rubato-segno-memory-change="" title={commit.files.join("\n")}>
          <span>Memory changed</span>
          {commit.message ? (
            <>
              {" · "}
              <span translate="no">“{commit.message}”</span>
            </>
          ) : null}
          {" · "}
          <span>{clockAt(commit.at, locale)}</span>
        </p>
      ))}
    </>
  );
}
