// Where a companion room shows its calls (user 0d108939: a card like a messenger's call, opened to
// read what was said). The call worker sends what the person said into the conversation as
// `[voice] …` messages, which reach the thread as the person's bubbles, while the companion's spoken
// replies never do; inside a call's own time those bubbles move into the card. A Telegram voice
// message is tagged `[voice]` too, but it comes outside any call, so it stays a bubble.
import type { SegnoChatItem, SegnoChatMessageInput } from "./rubatoSegnoRoom";
import type { CallRecord } from "../../state/rubatoCall";

/** Slack around a call's own time for a message the conversation recorded a moment late. */
export const CALL_EDGE_MS = 5_000;
const VOICE_TAG = "[voice] ";

function callWindow(call: CallRecord, now: number): [number, number] | null {
  if (call.status !== "active" && call.status !== "ended") return null;
  return [(call.answeredAt ?? call.createdAt) - CALL_EDGE_MS, (call.endedAt ?? now) + CALL_EDGE_MS];
}

/** The room's messages without the person's call speech, which the call's card shows instead. */
export function withoutCallSpeech(
  messages: ReadonlyArray<SegnoChatMessageInput>,
  calls: ReadonlyArray<CallRecord>,
  now = Date.now(),
): SegnoChatMessageInput[] {
  const windows = calls.map((call) => callWindow(call, now)).filter((span): span is [number, number] => span !== null);
  if (windows.length === 0) return [...messages];
  return messages.filter((message) => {
    if (message.role !== "user" || !message.text.startsWith(VOICE_TAG)) return true;
    const at = Date.parse(message.createdAt);
    return !windows.some(([from, to]) => at >= from && at <= to);
  });
}

/** Each call stands before the first bubble that came after it started; later ones close the room. */
export function callPlacement(items: ReadonlyArray<SegnoChatItem>, calls: ReadonlyArray<CallRecord>) {
  const before = new Map<string, CallRecord[]>();
  const tail: CallRecord[] = [];
  const bubbles = items.filter((item): item is Extract<SegnoChatItem, { kind: "bubble" }> => item.kind === "bubble");
  for (const call of [...calls].sort((a, b) => a.createdAt - b.createdAt)) {
    const next = bubbles.find((bubble) => bubble.at > call.createdAt);
    if (next) before.set(next.id, [...(before.get(next.id) ?? []), call]);
    else tail.push(call);
  }
  return { before, tail };
}

/** The calls a room draws: those since its first drawn message, so earlier days keep theirs out. */
export function callsFrom(calls: ReadonlyArray<CallRecord>, from: number | null): CallRecord[] {
  return calls.filter((call) => from === null || call.createdAt >= from);
}

/** A call's length as m:ss (h:mm:ss past an hour). */
export function callLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** The card's headline, in English source text the interface translates. */
export function callHeadline(call: CallRecord, now = Date.now()): { title: string; length: string | null } {
  if (call.status === "missed") return { title: call.direction === "incoming" ? "Missed call" : "No answer", length: null };
  if (call.status === "declined") return { title: "Declined call", length: null };
  if (call.status === "ringing") return { title: "Calling…", length: null };
  const length = callLength((call.endedAt ?? now) - (call.answeredAt ?? call.createdAt));
  return { title: call.status === "active" ? "On a call" : "Voice call", length };
}

/** What a line of the transcript reads as: directions for the voice ([laughing], <whisper>) go. */
export function spokenText(text: string): string {
  // A direction still streaming in (no closing bracket yet) goes too.
  return text.replace(/\[[^\]]{1,80}\]\s*/g, "").replace(/\[[^\]]{0,80}$/, "").replace(/<\/?[a-z]{2,12}>?/g, "").replace(/^\[voice\]\s*/, "").trim();
}
