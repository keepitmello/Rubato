// The timeline rail at a conversation's left edge, in place of T3's TimelineMinimap (user 1d2f3875).
// An ordinary thread draws it (timeline-rail-edits.mjs) and so does a companion's room
// (RubatoSegnoChat.tsx).
//
// It keeps what T3's rail does for the hand: a mark per turn that widens under the pointer, the
// person's words and the answer in a preview, a held drag that scrubs, arrow keys, and the previous
// and next turn buttons above and below. What changes is how a long conversation fits. Marks keep
// their spacing and the rail scrolls past its height (rubatoTimelineRail.logic.ts), following the
// turn the reader is at; a new day starts with the day's name. A wheel over a rail that scrolls moves
// the rail; over one that fits it still moves the conversation.
//
// A room can hold turns it has not drawn yet (pendingIds): their marks are dimmer, and choosing one
// is the room's to answer by drawing back to that day first.
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { subscribeUiLanguage, uiLanguage } from "../../rubatoI18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveTimelineMinimapNavigationInteractive, TIMELINE_MINIMAP_MIN_ITEMS } from "./MessagesTimeline.logic";
import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";
import {
  RAIL_DAY_ROW_PX,
  RAIL_EDGE_FADE_PX,
  RAIL_MAX_HEIGHT_CSS,
  railContentHeight,
  railDayLabel,
  railFollowScrollTop,
  railPreviewWhen,
  railRows,
} from "./rubatoTimelineRail.logic";

/** Width the strip takes while its preview is open, so the pointer can reach the preview. */
const EXPANDED_WIDTH = "22rem";
/** Room the preview keeps from the rail's ends before it stops centering on its mark. */
const PREVIEW_EDGE_PX = 48;

export interface RubatoTimelineRailProps {
  readonly items: ReadonlyArray<TimelineMinimapItem>;
  /** When each item's turn was, in epoch ms, by index; days are named only when they are known. */
  readonly times?: ReadonlyArray<number | null> | undefined;
  /** Items whose turn the conversation has not drawn yet. */
  readonly pendingIds?: ReadonlySet<string> | undefined;
  readonly hasPersistentGutter: boolean;
  readonly hitStripWidth: number;
  readonly currentIndex: number | null;
  readonly stripMap: Map<string, HTMLSpanElement>;
  readonly onWheel: (event: WheelEvent) => void;
  readonly onSelect: (item: TimelineMinimapItem) => void;
}

function useRailLocale(): string | undefined {
  const language = useSyncExternalStore(subscribeUiLanguage, uiLanguage, uiLanguage);
  return language === "ko" ? "ko-KR" : undefined;
}

function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return;
    stop();
    onRelease();
  };
  const stop = () => {
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
  return stop;
}

function railIndexOf(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>("[data-rail-index]");
  if (!row) return null;
  const index = Number(row.dataset.railIndex);
  return Number.isInteger(index) ? index : null;
}

export function RubatoTimelineRail({
  items,
  times,
  pendingIds,
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  stripMap,
  onWheel,
  onSelect,
}: RubatoTimelineRailProps) {
  const locale = useRailLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(() => railRows(items.map((_, index) => times?.[index] ?? null)), [items, times]);
  const contentHeight = railContentHeight(rows);
  const named = rows.some((row) => row.kind === "day");

  const strip = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const pointerInside = useRef(false);
  const focused = useRef(false);
  const [overflowing, setOverflowing] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [previewTop, setPreviewTop] = useState(0);
  const [stripHeight, setStripHeight] = useState(0);

  // Whether the rows run past the rail's height; only then does the rail scroll and fade at its ends.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const next = contentHeight > element.clientHeight + 1;
      setOverflowing((current) => (current === next ? current : next));
      setStripHeight(strip.current?.getBoundingClientRect().height ?? 0);
    };
    measure();
    return observeResize(element, measure);
  }, [contentHeight]);

  const wheelTargetRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const listener = (event: WheelEvent) => {
        const element = list.current;
        // A rail that scrolls takes the wheel itself; one that fits passes it to the conversation.
        if (element && element.scrollHeight > element.clientHeight + 1 && element.contains(event.target as Node)) return;
        onWheel(event);
      };
      node.addEventListener("wheel", listener, { passive: false });
      return () => node.removeEventListener("wheel", listener);
    },
    [onWheel],
  );

  // A held drag that started on the rail is a scrub; one that started anywhere else is a text
  // selection, and the rail lets the pointer through until the button is released.
  const pressedOnStrip = useRef(false);
  const [passThrough, setPassThrough] = useState(false);
  useEffect(() => {
    if (!passThrough) return;
    return onMouseButtonsReleased(() => setPassThrough(false));
  }, [passThrough]);

  const resolvedActiveIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = useMemo(
    () => resolveTimelineMinimapPreview(resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null)),
    [items, resolvedActiveIndex],
  );
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length ? currentIndex : null;
  const previousItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null);
  const navigationInteractive = resolveTimelineMinimapNavigationInteractive(hitStripWidth) && !passThrough;

  const markElement = useCallback(
    (index: number) => list.current?.querySelector<HTMLElement>(`[data-rail-index="${index}"]`) ?? null,
    [],
  );
  const placePreview = useCallback(
    (index: number | null) => {
      const box = strip.current?.getBoundingClientRect();
      const mark = index === null ? null : markElement(index)?.getBoundingClientRect();
      if (!box || !mark) return;
      setPreviewTop(mark.top + mark.height / 2 - box.top);
      setStripHeight(box.height);
    },
    [markElement],
  );
  useLayoutEffect(() => placePreview(resolvedActiveIndex), [placePreview, resolvedActiveIndex]);

  const showIndex = useCallback(
    (index: number) => {
      markElement(index)?.scrollIntoView({ block: "nearest" });
      setActiveIndex(index);
    },
    [markElement],
  );
  const moveActiveIndex = useCallback(
    (delta: number) => {
      const base = resolvedActiveIndex ?? resolvedCurrentIndex ?? items.length - 1;
      showIndex(Math.max(0, Math.min(items.length - 1, base + delta)));
    },
    [items.length, resolvedActiveIndex, resolvedCurrentIndex, showIndex],
  );

  // The rail follows the turn the reader is at, unless the reader is on the rail.
  const settled = useRef(false);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !overflowing || pointerInside.current || focused.current) return;
    const first = !settled.current;
    settled.current = true;
    const mark = resolvedCurrentIndex === null ? null : markElement(resolvedCurrentIndex);
    if (!mark) {
      if (first) element.scrollTop = element.scrollHeight;
      return;
    }
    const listBox = element.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();
    const target = railFollowScrollTop({
      markTop: markBox.top - listBox.top + element.scrollTop,
      markHeight: markBox.height,
      scrollTop: element.scrollTop,
      viewHeight: element.clientHeight,
      contentHeight: element.scrollHeight,
    });
    if (target === null) return;
    const far = first || Math.abs(target - element.scrollTop) > element.clientHeight;
    element.scrollTo({ top: target, behavior: far ? "instant" : "smooth" });
  }, [markElement, overflowing, resolvedCurrentIndex]);

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) return null;

  const pendingActive = activeItem !== null && pendingIds?.has(activeItem.id) === true;
  const activeAt = resolvedActiveIndex === null ? null : (times?.[resolvedActiveIndex] ?? null);
  const previewTranslate =
    previewTop < PREVIEW_EDGE_PX ? "-1.5rem" : previewTop > stripHeight - PREVIEW_EDGE_PX ? "calc(-100% + 1.5rem)" : "-50%";
  const fade = `linear-gradient(to bottom, transparent 0, #000 ${RAIL_EDGE_FADE_PX}px, #000 calc(100% - ${RAIL_EDGE_FADE_PX}px), transparent 100%)`;

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-rubato-timeline-rail=""
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          ref={strip}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStrip.current) return;
            pressedOnStrip.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStrip.current = false;
            });
          }}
          onMouseMove={(event) => {
            if (event.buttons !== 0 && !pressedOnStrip.current) setPassThrough(true);
          }}
          onMouseEnter={() => {
            pointerInside.current = true;
          }}
          onMouseLeave={() => {
            pointerInside.current = false;
            setActiveIndex(null);
          }}
          style={{ width: activeItem !== null ? EXPANDED_WIDTH : hitStripWidth }}
        >
          <RailNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <div
            ref={list}
            data-rubato-timeline-rail-list=""
            className="overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onScroll={() => placePreview(resolvedActiveIndex)}
            style={{
              maxHeight: RAIL_MAX_HEIGHT_CSS,
              width: Math.max(hitStripWidth, 24),
              paddingBlock: overflowing ? RAIL_EDGE_FADE_PX : 0,
              maskImage: overflowing ? fade : undefined,
              WebkitMaskImage: overflowing ? fade : undefined,
            }}
          >
            <button
              aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
              className="relative block w-full cursor-pointer bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              style={{ height: contentHeight }}
              type="button"
              onBlur={() => {
                focused.current = false;
                setActiveIndex(null);
              }}
              onFocus={() => {
                focused.current = true;
                setActiveIndex((current) => current ?? resolvedCurrentIndex ?? items.length - 1);
              }}
              onClick={(event) => {
                const index = railIndexOf(event.target);
                const selected = index === null ? null : (items[index] ?? null);
                if (selected) onSelect(selected);
                event.currentTarget.blur();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveActiveIndex(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveActiveIndex(-1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  showIndex(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  showIndex(items.length - 1);
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (activeItem) onSelect(activeItem);
                }
              }}
              onMouseMove={(event: MouseEvent<HTMLButtonElement>) => {
                if (event.buttons !== 0 && !pressedOnStrip.current) return;
                const index = railIndexOf(event.target);
                if (index !== null) setActiveIndex(index);
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {named ? null : <span className="absolute top-0 left-3 h-full w-px bg-border/15" aria-hidden="true" />}
              {rows.map((row) => {
                if (row.kind === "day") {
                  return (
                    <span
                      key={`day:${row.key}`}
                      aria-hidden="true"
                      data-rubato-rail-day=""
                      className="pointer-events-none flex items-end overflow-hidden pb-1.25 text-3xs leading-none font-medium whitespace-nowrap text-muted-foreground/75 tabular-nums"
                      style={{ height: RAIL_DAY_ROW_PX }}
                    >
                      {railDayLabel(row.at, now, locale)}
                    </span>
                  );
                }
                const item = items[row.index]!;
                const distance = resolvedActiveIndex === null ? null : Math.abs(row.index - resolvedActiveIndex);
                const pending = pendingIds?.has(item.id) === true;
                return (
                  <span key={item.id} data-rail-index={row.index} className="relative block h-2">
                    {/* Transform and opacity only: in-view state flips on every scroll tick. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "group/strip pointer-events-none absolute top-1/2 left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150",
                        distance === 0
                          ? "bg-muted-foreground/75"
                          : pending
                            ? "bg-muted-foreground/15"
                            : "bg-muted-foreground/35",
                        distance === 0 || row.index === resolvedCurrentIndex
                          ? "scale-x-100"
                          : distance === 1
                            ? "scale-x-[0.667]"
                            : distance === 2
                              ? "scale-x-[0.417]"
                              : "scale-x-[0.333]",
                      )}
                      data-in-view="false"
                      data-minimap-strip
                      data-pending={pending ? "true" : undefined}
                      ref={(node) => {
                        if (node) stripMap.set(item.id, node);
                        else stripMap.delete(item.id);
                      }}
                    >
                      <span className="absolute inset-0 rounded-full bg-foreground/90 opacity-0 transition-opacity duration-150 group-data-[in-view=true]/strip:opacity-100" />
                    </span>
                  </span>
                );
              })}
            </button>
          </div>
          {activeItem ? (
            <span
              className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{ top: previewTop, transform: `translateY(${previewTranslate})` }}
            >
              <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                {activeAt !== null ? (
                  <span className="mb-1 block text-xs leading-4 text-muted-foreground tabular-nums">
                    {railPreviewWhen(activeAt, now, locale)}
                  </span>
                ) : null}
                <span
                  translate="no"
                  className="block max-w-full overflow-hidden text-sm leading-5 font-medium text-ellipsis whitespace-nowrap"
                >
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    translate="no"
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-sm leading-5 text-muted-foreground"
                    style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3 }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
                {pendingActive ? (
                  <span className="mt-1.5 block text-xs leading-4 text-muted-foreground/80">
                    Click to load that day and go there
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
          <RailNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function RailNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
              interactive ? "pointer-events-auto" : "pointer-events-none",
              previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            )}
          />
        }
      >
        <Button aria-label={label} disabled={disabled} onClick={onClick} size="icon-micro" type="button" variant="ghost-muted">
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
