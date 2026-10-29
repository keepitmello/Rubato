// What Segno's chat room shows, worked out from the thread's timeline (RubatoSegnoChat.tsx draws it).
// The thread holds the person's messages and what Segno sent with reply or say (intent companion-segno
// rev 11), so every message is a bubble: the person's on the right, Segno's on the left. Messages from
// one side close together form a group whose last bubble carries the tail; a long gap or a new day
// gets a time line between bubbles instead of a time on every message (user f38c36a6).
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { isImageAttachment, type ChatAttachment, type ChatImageAttachment } from "../../types";

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
    items.push({
      kind: "bubble",
      id: message.id,
      side,
      text: side === "me" ? personText(message.text) : message.text,
      at,
      streaming: message.streaming,
      images: (message.attachments ?? []).filter(isImageAttachment),
      attachmentNames: (message.attachments ?? [])
        .filter((attachment) => !isImageAttachment(attachment))
        .map((attachment) => attachment.name ?? "")
        .filter(Boolean),
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
