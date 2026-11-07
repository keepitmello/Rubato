// What Segno's chat room shows, worked out from the thread's timeline (RubatoSegnoChat.tsx draws it).
// The thread holds the person's messages and what Segno sent with reply or say (intent companion-segno
// rev 11), so every message is a bubble: the person's on the right, Segno's on the left. Messages from
// one side close together form a group whose last bubble carries the tail; a long gap or a new day
// gets a time line between bubbles instead of a time on every message (user f38c36a6).
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { isImageAttachment, type ChatAttachment, type ChatImageAttachment } from "../../types";
import type { TimelineMinimapItem } from "./timelineMinimapItems";

/** Messages from one side within this gap of each other belong to one group. */
export const GROUP_GAP_MS = 3 * 60_000;
/** A gap at least this long, or a new day, puts a time line between two bubbles. */
export const SEPARATOR_GAP_MS = 60 * 60_000;

export type SegnoChatSide = "me" | "segno";

export interface SegnoChatMessageInput {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming: boolean;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

export type SegnoChatItem =
  | { readonly kind: "separator"; readonly id: string; readonly at: number }
  | {
      readonly kind: "bubble";
      readonly id: string;
      readonly side: SegnoChatSide;
      readonly text: string;
      readonly at: number;
      readonly streaming: boolean;
      /** The person's pictures, drawn in the bubble (RubatoSegnoChat.tsx). */
      readonly images: ReadonlyArray<ChatImageAttachment>;
      /** Names of the other files the person sent. */
      readonly attachmentNames: readonly string[];
      /**
       * The person's files sent from the messenger, one markdown line each (said-echo.mjs
       * channelItem): drawn in the bubble as Segno's files are, a picture or video in place and
       * any other file as a link that opens it.
       */
      readonly files: string;
      /** The first bubble of its group: the group gets its full gap above. */
      readonly groupStart: boolean;
      /** The last bubble of its group: it carries the tail. */
      readonly groupEnd: boolean;
    };

/**
 * The person's words as the bubble shows them. T3 writes an attached picture into the message as a
 * context link (`![image.png](t3-context://…)`); the picture itself is drawn from the attachment, so
 * the link goes, and any other context link reads as its label.
 */
export function personText(text: string): string {
  return replaceComposerContextReferences(text, (reference) => (reference.image ? "" : reference.label)).trim();
}

/** A file line as the engine writes it (companion home.mjs filesMarkdown): `![name](</abs>)` or `[name](</abs>)`. */
const FILE_LINE = /^!?\[([^\]\n]*)\]\(<(\/[^>\n]+)>\)$/;

/** The person's words and their file lines, apart. */
export function splitFileLines(text: string): { words: string; files: string } {
  const blocks = text.split(/\n{2,}/);
  const files = blocks.map((block) => block.trim()).filter((block) => FILE_LINE.test(block));
  if (files.length === 0) return { words: text, files: "" };
  const words = blocks.filter((block) => !FILE_LINE.test(block.trim())).join("\n\n").trim();
  return { words, files: files.join("\n\n") };
}

/** A bubble's text for a one-line preview: each file line reads as its name. */
export function previewText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim().replace(FILE_LINE, (_line, name: string) => name))
    .filter(Boolean)
    .join("\n\n");
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** The bubbles and time lines, oldest first. Only the person's and Segno's messages count. */
export function segnoChatItems(messages: ReadonlyArray<SegnoChatMessageInput>): SegnoChatItem[] {
  const shown = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ message, at: Date.parse(message.createdAt) }))
    .filter(({ message, at }) => Number.isFinite(at) && (message.text.trim() !== "" || (message.attachments?.length ?? 0) > 0))
    .sort((a, b) => a.at - b.at);
  const items: SegnoChatItem[] = [];
  let previous: { side: SegnoChatSide; at: number } | null = null;
  for (let index = 0; index < shown.length; index += 1) {
    const { message, at } = shown[index]!;
    const side: SegnoChatSide = message.role === "user" ? "me" : "segno";
    const separated = previous === null || at - previous.at >= SEPARATOR_GAP_MS || !sameDay(previous.at, at);
    if (separated) items.push({ kind: "separator", id: `separator:${message.id}`, at });
    const next = shown[index + 1];
    const nextSide: SegnoChatSide | null = next ? (next.message.role === "user" ? "me" : "segno") : null;
    const nextJoins =
      next !== undefined &&
      nextSide === side &&
      next.at - at < GROUP_GAP_MS &&
      next.at - at < SEPARATOR_GAP_MS &&
      sameDay(at, next.at);
    const person = side === "me" ? splitFileLines(personText(message.text)) : null;
    items.push({
      kind: "bubble",
      id: message.id,
      side,
      text: person ? person.words : message.text,
      at,
      streaming: message.streaming,
      images: (message.attachments ?? []).filter(isImageAttachment),
      attachmentNames: (message.attachments ?? [])
        .filter((attachment) => !isImageAttachment(attachment))
        .map((attachment) => attachment.name ?? "")
        .filter(Boolean),
      files: person ? person.files : "",
      groupStart:
        separated || previous === null || previous.side !== side || at - previous.at >= GROUP_GAP_MS,
      groupEnd: !nextJoins,
    });
    previous = { side, at };
  }
  return items;
}

/**
 * Segno is writing: its turn runs and it has not answered the person's last message yet. A turn the
 * person opened keeps its run until it settles, so once a reply is in, the dots go even if Segno
 * still works.
 */
export function segnoIsWriting(items: ReadonlyArray<SegnoChatItem>, working: boolean): boolean {
  if (!working) return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "bubble") return item.side === "me";
  }
  return false;
}

/** The time line's words: a time today, "yesterday" and a time, or a date and a time. */
export function separatorLabel(at: number, now: number, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  if (sameDay(at, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(at, yesterday.getTime())) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return `${word} ${time}`;
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(at);
  return `${date} ${time}`;
}

/**
 * The bubbles that arrived since the room last looked: new, and not older than the newest one it
 * knew, so earlier history loading in above stays still. Updates `known` as it goes.
 */
export function arrivals(
  bubbles: ReadonlyArray<{ readonly id: string; readonly at: number }>,
  known: { ids: Set<string>; latest: number },
): string[] {
  const fresh: string[] = [];
  for (const bubble of bubbles) {
    if (known.ids.has(bubble.id)) continue;
    known.ids.add(bubble.id);
    if (bubble.at >= known.latest) fresh.push(bubble.id);
  }
  for (const bubble of bubbles) known.latest = Math.max(known.latest, bubble.at);
  return fresh;
}

/**
 * The room's marks on the timeline at its left edge, the one an ordinary thread has (MessagesTimeline).
 * A mark is one turn of the conversation: the person's bubbles in a row, and what the companion said
 * before the person spoke again. The mark sits on the turn's first bubble; its preview shows the
 * person's words and the companion's answer.
 */
export function segnoTurnMarks(items: ReadonlyArray<SegnoChatItem>): TimelineMinimapItem[] {
  const marks: { id: string; rowIndex: number; asked: string[]; answered: string[] }[] = [];
  let previousSide: SegnoChatSide | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind !== "bubble") continue;
    const words =
      previewText(item.text).trim() ||
      [...item.images.map((image) => image.name ?? ""), ...item.attachmentNames, previewText(item.files)]
        .filter(Boolean)
        .join(", ");
    if (item.side === "me") {
      if (previousSide !== "me") marks.push({ id: item.id, rowIndex: index, asked: [], answered: [] });
      if (words) marks.at(-1)!.asked.push(words);
    } else if (marks.length > 0 && words) {
      marks.at(-1)!.answered.push(words);
    }
    previousSide = item.side;
  }
  return marks.map((mark) => ({
    id: mark.id,
    rowIndex: mark.rowIndex,
    userText: mark.asked.length > 0 ? mark.asked.join("\n") : null,
    assistantText: mark.answered.length > 0 ? mark.answered.join("\n") : null,
  }));
}

// ── What the companion did between bubbles (user f8828a9f) ─────────────────────────────────────
// The room shows only the person's messages and the companion's replies; the rest of its work —
// thinking, words to itself, tools, what woke it — folds into one line between the bubbles and
// opens in place (RubatoSegnoInner.tsx). The bridge reads it from the session file per span
// (companion/inner.mjs): span i ends at bubble i, and one more runs on after the last bubble.

/** Where a span's line goes and what it covers. */
export interface SegnoSpanPlace {
  /** The span's index in the bridge's answer. */
  readonly index: number;
  /** The span starts after this time (ms); null: from the conversation's start. */
  readonly after: number | null;
  /** The span ends at this time, inclusive; null: it runs on now. */
  readonly until: number | null;
  /**
   * `attached`: the work behind a reply, above its bubble. `quiet`: work that led to no reply,
   * as a line of its own. `live`: what the companion does right now, under its writing dots.
   */
  readonly placement: "attached" | "quiet" | "live";
}

export interface SegnoSpans {
  /** The bubble times the bridge splits at, oldest first. */
  readonly boundaries: readonly number[];
  /** Where the first span starts; set while earlier history is not loaded, so it is not read whole. */
  readonly after: number | undefined;
  /** The span that ends at each bubble, by bubble id. */
  readonly before: ReadonlyMap<string, SegnoSpanPlace>;
  /** The span after the last bubble. */
  readonly tail: SegnoSpanPlace;
}

export function segnoSpans(items: ReadonlyArray<SegnoChatItem>, options: { writing: boolean; partial: boolean }): SegnoSpans {
  const bubbles = items.filter((item): item is Extract<SegnoChatItem, { kind: "bubble" }> => item.kind === "bubble");
  const after = options.partial && bubbles.length > 0 ? bubbles[0]!.at : undefined;
  const before = new Map<string, SegnoSpanPlace>();
  bubbles.forEach((bubble, index) => {
    before.set(bubble.id, {
      index,
      after: index === 0 ? (after ?? null) : bubbles[index - 1]!.at,
      until: bubble.at,
      placement: bubble.side === "segno" ? "attached" : "quiet",
    });
  });
  return {
    boundaries: bubbles.map((bubble) => bubble.at),
    after,
    before,
    tail: {
      index: bubbles.length,
      after: bubbles.at(-1)?.at ?? after ?? null,
      until: null,
      placement: options.writing ? "live" : "quiet",
    },
  };
}

/** How long a span ran, in the room's language: "41s", "3m", "1h 20m". */
export function spanDuration(ms: number, locale: string | undefined): string {
  const unit = (value: number, name: "second" | "minute" | "hour") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(rest, "minute")}`;
}

/**
 * What woke the companion, by its kind (keeper.mjs notify `what`, the scheduler, a voice call), as the
 * folded line and the opened span name it. Each kind has its own name: only a heartbeat is called one
 * (user ffaeed47).
 */
export const WAKE_LABELS: Readonly<Record<string, string>> = {
  heartbeat: "Heartbeat",
  greeting: "Greeting",
  // A fresh session, one after compaction, or the same one after the engine restarted.
  wake: "Started again",
  recall: "Recalling",
  sleep: "Going to sleep",
  inbox: "Work room",
  "persona-review": "Persona review",
  schedule: "Scheduled task",
  call: "Voice call",
};
/** A kind this room does not know yet. */
export const OTHER_WAKE = "Other";

/** The wakes of a span, one name and count per kind, in the order they first came. */
export function wakeCounts(summary: {
  readonly wakes: number;
  readonly wakeKinds?: Readonly<Record<string, number>> | undefined;
}): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  let named = 0;
  for (const [kind, count] of Object.entries(summary.wakeKinds ?? {})) {
    if (count <= 0) continue;
    const label = WAKE_LABELS[kind] ?? OTHER_WAKE;
    counts.set(label, (counts.get(label) ?? 0) + count);
    named += count;
  }
  // A bridge older than the kinds says only how many.
  if (summary.wakes > named) counts.set(OTHER_WAKE, (counts.get(OTHER_WAKE) ?? 0) + summary.wakes - named);
  return [...counts].map(([label, count]) => ({ label, count }));
}

/** The counts a span's line shows besides its wakes, each its own phrase so the interface translates it. */
export function spanCounts(summary: {
  readonly thinking: number;
  readonly text: number;
  readonly tools: number;
  readonly messages: number;
}): string[] {
  const words: string[] = [];
  const thoughts = summary.thinking + summary.text;
  if (summary.messages > 0) words.push(summary.messages === 1 ? "1 message" : `${summary.messages} messages`);
  if (thoughts > 0) words.push(thoughts === 1 ? "1 thought" : `${thoughts} thoughts`);
  if (summary.tools > 0) words.push(summary.tools === 1 ? "1 tool" : `${summary.tools} tools`);
  return words;
}
