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
// bubble has a menu (right click, or a long press) with "Rewind from here": the conversation goes
// back to just before that message and the message returns to the composer. Files stay: the
// companion's home is its own record (diary, notes), committed as it goes.
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

import type { EnvironmentId, MessageId } from "@t3tools/contracts";

import { useAssetUrls } from "~/assets/assetUrls";
import { subscribeUiLanguage, uiLanguage } from "../../rubatoI18n";
import { selectMessageImageResources, type TimelineEntry } from "../../session-logic";
import type { ChatImageAttachment } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useRubatoCompanion } from "../../state/rubatoCompanion";
import { messageRewindTarget } from "./RubatoMessageEdit";
import { RubatoSegnoSpanLine, useSegnoSpanSummaries } from "./RubatoSegnoInner";
import {
  arrivals,
  segnoChatItems,
  segnoIsWriting,
  segnoSpans,
  separatorLabel,
  type SegnoChatItem,
  type SegnoChatMessageInput,
} from "./rubatoSegnoRoom";
import "./RubatoSegnoChat.css";

/** Closer to the end than this, the room follows new bubbles down. */
const FOLLOW_PX = 64;

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

/** The person's bubble's menu: copy, and rewind the conversation to just before this message. */
function BubbleMenu({ text, onRewind, onClose }: { text: string; onRewind: (() => void) | undefined; onClose: () => void }) {
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

function Bubble({
  item,
  enter,
  cwd,
  environmentId,
  onRewind,
}: {
  item: Extract<SegnoChatItem, { kind: "bubble" }>;
  enter: boolean;
  cwd: string | undefined;
  environmentId: EnvironmentId | undefined;
  /** The person's bubble only: rewinds the conversation to just before it. */
  onRewind?: (() => void) | undefined;
}) {
  const [menu, setMenu] = useState(false);
  const press = useRef<number | undefined>(undefined);
  const mine = item.side === "me";
  const endPress = () => {
    if (press.current !== undefined) window.clearTimeout(press.current);
    press.current = undefined;
  };
  const closeMenu = useCallback(() => setMenu(false), []);
  return (
    <div
      data-rubato-segno-row=""
      data-side={item.side}
      data-group-start={item.groupStart ? "" : undefined}
      data-group-end={item.groupEnd ? "" : undefined}
      data-enter={enter ? (item.side === "me" ? "send" : "arrive") : undefined}
      data-menu-open={menu ? "" : undefined}
    >
      <div
        data-rubato-segno-bubble=""
        data-thread-find-text=""
        {...(mine
          ? {
              onContextMenu: (event: ReactMouseEvent) => {
                event.preventDefault();
                setMenu(true);
              },
              onPointerDown: (event: ReactPointerEvent) => {
                if (event.pointerType !== "touch") return;
                endPress();
                press.current = window.setTimeout(() => setMenu(true), LONG_PRESS_MS);
              },
              onPointerUp: endPress,
              onPointerMove: endPress,
              onPointerCancel: endPress,
            }
          : {})}
      >
        {item.images.length > 0 && environmentId ? <Images images={item.images} environmentId={environmentId} /> : null}
        {item.side === "segno" ? (
          <ChatMarkdown text={item.text} cwd={cwd} isStreaming={item.streaming} lineBreaks />
        ) : item.text ? (
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
        ) : null}
        {item.attachmentNames.length > 0 ? (
          <div data-rubato-segno-attachments="">
            {item.attachmentNames.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        ) : null}
        {item.groupEnd ? <Tail /> : null}
      </div>
      {menu ? <BubbleMenu text={item.text} onRewind={onRewind} onClose={closeMenu} /> : null}
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
  historyControls?: SegnoHistoryControls | undefined;
  /** The companion's thread. */
  threadId?: string | undefined;
  /**
   * Rewinds the conversation to `turnCount` turns and puts `messageId` back in the composer, files
   * untouched (ChatView's revert, companion-edits.mjs).
   */
  onRewind?: ((turnCount: number, messageId: MessageId) => void) | undefined;
}) {
  const items = useMemo(() => segnoChatItems(messagesOf(props.entries)), [props.entries]);
  const writing = segnoIsWriting(items, props.working);
  const locale = useLocale();
  const companionId = useRubatoCompanion().companions.find((item) => item.threadId === props.threadId)?.id;
  const partial = props.historyControls?.hasMoreHistory === true;
  const spans = useMemo(() => segnoSpans(items, { writing: props.working, partial }), [items, props.working, partial]);
  const summaries = useSegnoSpanSummaries({
    environmentId: props.environmentId,
    companionId,
    boundaries: spans.boundaries,
    after: spans.after,
    working: props.working,
  });
  const { environmentId, threadId, onRewind } = props;
  const rewind = useCallback(
    async (messageId: string) => {
      if (!environmentId || !threadId || !onRewind) return;
      try {
        const target = await messageRewindTarget(environmentId, threadId, messageId as MessageId);
        onRewind(target.turnCount, messageId as MessageId);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not rewind",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [environmentId, threadId, onRewind],
  );
  const spanLine = (place: (typeof spans)["tail"] | undefined, key: string) =>
    place ? (
      <RubatoSegnoSpanLine
        key={key}
        place={place}
        summary={summaries[place.index]}
        companionId={companionId}
        environmentId={environmentId}
        locale={locale}
      />
    ) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Bubbles already there when the room's history first arrives stay still; later ones spring in.
  const seen = useRef<{ ids: Set<string>; latest: number } | null>(null);
  const animated = useRef(new Set<string>());
  useMemo(() => {
    const bubbles = items.filter((item) => item.kind === "bubble");
    if (seen.current === null) {
      if (bubbles.length > 0)
        seen.current = { ids: new Set(bubbles.map((item) => item.id)), latest: Math.max(...bubbles.map((item) => item.at)) };
      return;
    }
    for (const id of arrivals(bubbles, seen.current)) animated.current.add(id);
  }, [items]);

  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const opened = useRef(false);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_PX;
  }, []);
  // Loading earlier history keeps the bubble in view where it was.
  const heightBeforeLoad = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (heightBeforeLoad.current !== null) {
      element.scrollTop += element.scrollHeight - heightBeforeLoad.current;
      heightBeforeLoad.current = null;
      return;
    }
    if (!opened.current || atEnd.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: opened.current ? "smooth" : "instant" });
      atEnd.current = true;
    }
    opened.current = true;
  }, [items, writing, props.bottomInset]);

  const history = props.historyControls;
  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-rubato-segno-room=""
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
    >
      <div className="chat-content-lane flex flex-col pt-14" style={{ paddingBottom: props.bottomInset + 20 }}>
        {history?.hasMoreHistory ? (
          <button
            type="button"
            data-rubato-segno-earlier=""
            disabled={history.loading}
            onClick={() => {
              heightBeforeLoad.current = scroller.current?.scrollHeight ?? null;
              history.onLoadEarlier();
            }}
          >
            {history.loading ? "Loading…" : "Load earlier messages"}
          </button>
        ) : null}
        {items.map((item, index) => {
          if (item.kind === "separator") {
            // Work that led to no reply happened before the person's next message, so its line
            // stands above that message's time line.
            const next = items[index + 1];
            const quiet = next?.kind === "bubble" && next.side === "me" ? spans.before.get(next.id) : undefined;
            return [
              spanLine(quiet, `span:${next?.id}`),
              <div key={item.id} data-rubato-segno-time="">
                {separatorLabel(item.at, now, locale ?? navigator.language)}
              </div>,
            ];
          }
          const separated = items[index - 1]?.kind === "separator";
          const place = spans.before.get(item.id);
          return [
            item.side === "segno" || !separated ? spanLine(place, `span:${item.id}`) : null,
            <Bubble
              key={item.id}
              item={item}
              enter={animated.current.has(item.id)}
              cwd={props.cwd}
              environmentId={props.environmentId}
              onRewind={item.side === "me" && onRewind && threadId ? () => void rewind(item.id) : undefined}
            />,
          ];
        })}
        {writing ? <Writing /> : null}
        {spanLine(spans.tail, "span:tail")}
      </div>
    </div>
  );
}
