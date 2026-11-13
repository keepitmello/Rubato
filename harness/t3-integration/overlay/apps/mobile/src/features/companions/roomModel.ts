// What a companion's room shows, worked out from its thread and its calls (CompanionRoomScreen draws
// it). The thread holds the person's messages and what the companion sent with reply or say, so
// every message is a bubble: the person's on the right, the companion's on the left. Messages from
// one side close together form a group whose last bubble carries the tail; a long gap or a new day
// gets a time line instead of a time on every bubble. Each call is one card, placed where it
// started (user 0d108939: a card like a messenger's call, opened to read what was said). The desktop
// room draws the same thing (t3-integration overlay apps/web rubatoSegnoRoom.ts, rubatoCallRoom.ts).
import type { CallRecord } from "./callStore";

/** Messages from one side within this gap of each other belong to one group. */
export const GROUP_GAP_MS = 3 * 60_000;
/** A gap at least this long, or a new day, puts a time line between two bubbles. */
export const SEPARATOR_GAP_MS = 60 * 60_000;
/** Slack around a call's own time for a message the conversation recorded a moment late. */
export const CALL_EDGE_MS = 5_000;
const VOICE_TAG = "[voice] ";

export interface RoomMessageInput {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming: boolean;
}

export type RoomSide = "me" | "companion";

export type RoomItem =
  | { readonly kind: "separator"; readonly id: string; readonly at: number }
  | {
      readonly kind: "bubble";
      readonly id: string;
      readonly side: RoomSide;
      readonly text: string;
      readonly at: number;
      readonly streaming: boolean;
      readonly groupStart: boolean;
      readonly groupEnd: boolean;
    }
  | { readonly kind: "call"; readonly id: string; readonly at: number; readonly call: CallRecord };

/**
 * The person's words as a bubble shows them. T3 writes an attached picture into the message as a
 * context link (`![image.png](t3-context://…)`) and the call worker tags call speech `[voice] `.
 */
export function personText(text: string): string {
  return text
    .replace(/!\[[^\]\n]*\]\(t3-context:[^)\n]*\)/g, "")
    .replace(/\[([^\]\n]*)\]\(t3-context:[^)\n]*\)/g, "$1")
    .replace(/^\[voice\]\s*/, "")
    .trim();
}

function callWindow(call: CallRecord, now: number): [number, number] | null {
  if (call.status !== "active" && call.status !== "ended") return null;
  return [(call.answeredAt ?? call.createdAt) - CALL_EDGE_MS, (call.endedAt ?? now) + CALL_EDGE_MS];
}

/**
 * The room's messages without the person's call speech: the call worker sends what the person said
 * into the conversation as `[voice] …`, and inside a call's own time the card shows it instead. A
 * voice message from the messenger is tagged too, but comes outside any call and stays a bubble.
 */
export function withoutCallSpeech(
  messages: ReadonlyArray<RoomMessageInput>,
  calls: ReadonlyArray<CallRecord>,
  now = Date.now(),
): RoomMessageInput[] {
  const windows = calls.map((call) => callWindow(call, now)).filter((span): span is [number, number] => span !== null);
  if (windows.length === 0) return [...messages];
  return messages.filter((message) => {
    if (message.role !== "user" || !message.text.startsWith(VOICE_TAG)) return true;
    const at = Date.parse(message.createdAt);
    return !windows.some(([from, to]) => at >= from && at <= to);
  });
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Bubbles, call cards and time lines, oldest first. */
export function roomItems(
  messages: ReadonlyArray<RoomMessageInput>,
  calls: ReadonlyArray<CallRecord>,
  now = Date.now(),
): RoomItem[] {
  type Entry =
    | { kind: "message"; at: number; side: RoomSide; message: RoomMessageInput; text: string }
    | { kind: "call"; at: number; call: CallRecord };
  const entries: Entry[] = [
    ...withoutCallSpeech(messages, calls, now)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => {
        const side: RoomSide = message.role === "user" ? "me" : "companion";
        return { kind: "message" as const, at: Date.parse(message.createdAt), side, message,
          text: side === "me" ? personText(message.text) : message.text.trim() };
      })
      .filter((entry) => Number.isFinite(entry.at) && (entry.text !== "" || entry.message.streaming)),
    ...calls.map((call) => ({ kind: "call" as const, at: call.createdAt, call })),
  ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "call" ? 1 : -1));

  const items: RoomItem[] = [];
  let previous: { at: number; side: RoomSide | "call" } | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const separated = previous === null || entry.at - previous.at >= SEPARATOR_GAP_MS || !sameDay(previous.at, entry.at);
    if (separated) items.push({ kind: "separator", id: `separator:${entry.kind === "call" ? entry.call.id : entry.message.id}`, at: entry.at });
    if (entry.kind === "call") {
      items.push({ kind: "call", id: `call:${entry.call.id}`, at: entry.at, call: entry.call });
      previous = { at: entry.at, side: "call" };
      continue;
    }
    const next = entries[index + 1];
    const nextJoins =
      next !== undefined &&
      next.kind === "message" &&
      next.side === entry.side &&
      next.at - entry.at < GROUP_GAP_MS &&
      sameDay(entry.at, next.at);
    items.push({
      kind: "bubble",
      id: entry.message.id,
      side: entry.side,
      text: entry.text,
      at: entry.at,
      streaming: entry.message.streaming,
      groupStart: separated || previous === null || previous.side !== entry.side || entry.at - previous.at >= GROUP_GAP_MS,
      groupEnd: !nextJoins,
    });
    previous = { at: entry.at, side: entry.side };
  }
  return items;
}

/** The companion is writing: its turn runs and it has not answered the person's last message yet. */
export function companionIsWriting(items: ReadonlyArray<RoomItem>, working: boolean): boolean {
  if (!working) return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "bubble") return item.side === "me";
    if (item.kind === "call") return false;
  }
  return false;
}

/** A call's length as m:ss (h:mm:ss past an hour). */
export function callLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export type CallHeadlineKey = "missedCall" | "noAnswer" | "declinedCall" | "calling" | "onCall" | "voiceCall";

/** The card's headline: which words, and how long the call ran when it ran. */
export function callHeadline(call: CallRecord, now = Date.now()): { key: CallHeadlineKey; length: string | null } {
  if (call.status === "missed") return { key: call.direction === "incoming" ? "missedCall" : "noAnswer", length: null };
  if (call.status === "declined") return { key: "declinedCall", length: null };
  if (call.status === "ringing") return { key: "calling", length: null };
  const length = callLength((call.endedAt ?? now) - (call.answeredAt ?? call.createdAt));
  return { key: call.status === "active" ? "onCall" : "voiceCall", length };
}

/** What a line of the transcript reads as: directions for the voice ([laughing], <whisper>) go. */
export function spokenText(text: string): string {
  return text
    .replace(/\[[^\]]{1,80}\]\s*/g, "")
    .replace(/\[[^\]]{0,80}$/, "")
    .replace(/<\/?[a-z]{2,12}>?/g, "")
    .replace(/^\[voice\]\s*/, "")
    .trim();
}

/** A one-line preview of the room's latest bubble or call, for the companion list. */
export function roomPreview(
  items: ReadonlyArray<RoomItem>,
): { text: string; at: number; side: RoomSide | null; callKey: CallHeadlineKey | null } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "bubble" && item.text)
      return { text: item.text.replace(/\s+/g, " ").trim(), at: item.at, side: item.side, callKey: null };
    if (item.kind === "call") return { text: "", at: item.at, side: null, callKey: callHeadline(item.call).key };
  }
  return null;
}
