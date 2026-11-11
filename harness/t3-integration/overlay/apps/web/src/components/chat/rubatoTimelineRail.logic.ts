// What the timeline rail at a conversation's left edge shows (RubatoTimelineRail.tsx draws it).
//
// T3's rail squeezed every turn into one column the height of the screen, so a long conversation
// became a barcode: 500 turns in 700px is a mark every 1.4px, and the pointer could not pick one
// (user 1d2f3875). Here every mark keeps its own spacing and the rail scrolls once it runs past its
// height, the way Codex's thread rail does. A conversation that spans days breaks the rail at each
// new day with the day's name, so the reader finds "yesterday" without hovering.
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

/** Height of one mark's row on the rail. */
export const RAIL_MARK_SPACING_PX = 8;
/** Height of the line that names a new day. */
export const RAIL_DAY_ROW_PX = 22;
/** The rail never grows past this; beyond it the rail scrolls. */
export const RAIL_MAX_HEIGHT_CSS = "min(calc(100vh - 18rem), 40rem)";
/** How far the scrolling rail fades out at its ends. */
export const RAIL_EDGE_FADE_PX = 24;

export type RailRow =
  | { readonly kind: "day"; readonly key: string; readonly at: number }
  | { readonly kind: "mark"; readonly index: number };

function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function sameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b);
}

/**
 * The rail's rows, oldest first: one per mark, and a day line before the first mark of each day.
 * A conversation within one day gets no day lines. A mark without a time stays in the day before it.
 */
export function railRows(times: ReadonlyArray<number | null | undefined>): RailRow[] {
  const days = new Set<string>();
  for (const at of times) if (typeof at === "number" && Number.isFinite(at)) days.add(dayKey(at));
  const named = days.size > 1;
  const rows: RailRow[] = [];
  let current: string | null = null;
  for (let index = 0; index < times.length; index += 1) {
    const at = times[index];
    if (named && typeof at === "number" && Number.isFinite(at)) {
      const key = dayKey(at);
      if (key !== current) {
        current = key;
        rows.push({ kind: "day", key, at });
      }
    }
    rows.push({ kind: "mark", index });
  }
  return rows;
}

/** The rail's full height before it is capped: what the rows take. */
export function railContentHeight(rows: ReadonlyArray<RailRow>): number {
  let height = 0;
  for (const row of rows) height += row.kind === "day" ? RAIL_DAY_ROW_PX : RAIL_MARK_SPACING_PX;
  return height;
}

function relativeDay(at: number, now: number, locale: string | undefined): string | null {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const offset = sameDay(at, now) ? 0 : sameDay(at, yesterday.getTime()) ? -1 : null;
  if (offset === null) return null;
  const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(offset, "day");
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
}

/** The day line's name: today, yesterday, or month/day (with the year once it is another year). */
export function railDayLabel(at: number, now: number, locale: string | undefined): string {
  const relative = relativeDay(at, now, locale);
  if (relative !== null) return relative;
  const date = new Date(at);
  const short = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? short : `${date.getFullYear()}/${short}`;
}

/** A day's full name: "Today · Wednesday, November 11", or the date alone further back. */
export function railDayTitle(at: number, now: number, locale: string | undefined): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(at);
  const relative = relativeDay(at, now, locale);
  return relative === null ? date : `${relative} · ${date}`;
}

/** When a turn was, for the preview: its day and its time. */
export function railPreviewWhen(at: number, now: number, locale: string | undefined): string {
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  return `${railDayTitle(at, now, locale)} ${time}`;
}

/**
 * Where the scrolling rail should go so the reader's turn stays in sight: nowhere while the mark sits
 * in the middle band, otherwise centered on it. Clamped to what the rail can scroll.
 */
export function railFollowScrollTop(input: {
  readonly markTop: number;
  readonly markHeight: number;
  readonly scrollTop: number;
  readonly viewHeight: number;
  readonly contentHeight: number;
}): number | null {
  const { markTop, markHeight, scrollTop, viewHeight, contentHeight } = input;
  if (viewHeight <= 0 || contentHeight <= viewHeight) return null;
  const center = markTop + markHeight / 2 - scrollTop;
  if (center >= viewHeight * 0.3 && center <= viewHeight * 0.7) return null;
  const target = Math.round(markTop + markHeight / 2 - viewHeight / 2);
  return Math.max(0, Math.min(contentHeight - viewHeight, target));
}

/** An ordinary thread's marks are its user messages; each mark's time is its message's. */
export function rubatoTimelineItemTimes(
  rows: ReadonlyArray<MessagesTimelineRow>,
  items: ReadonlyArray<TimelineMinimapItem>,
): Array<number | null> {
  return items.map((item) => {
    const row = rows[item.rowIndex];
    if (row?.kind !== "message") return null;
    const at = Date.parse(row.message.createdAt);
    return Number.isFinite(at) ? at : null;
  });
}
