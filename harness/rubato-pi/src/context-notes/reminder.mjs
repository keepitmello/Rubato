import { createHash } from "node:crypto";
import { NUDGE_ENTRY, REMINDER_ENTRY } from "./protocol.mjs";

export const REMINDER_TEXT = "<context_window_reminder>This window is nearing its input budget. Save current goals, decisions, progress, failed approaches, next steps and original window/item references with the notes tools, then call new_context. The next window will not include this conversation. Do not start another large task before saving your state. Use get_context_remaining for a current estimate.</context_window_reminder>";

// Periodic, advisory note refresh. Placed exactly like the reminder: after the message
// that was last when it was recorded, in every later request of the same window, with
// fixed text. It never moves, never changes and never touches an earlier message.
export const NUDGE_TEXT = "<context_notes_nudge>A substantial amount of work has accumulated since your working notes were last saved. If material state changed (goal, user requirements, decisions, progress, failed approaches and why, next steps, hard-to-recover IDs, commands or errors, window/item references), update your notes with the notes tools now, then continue. If nothing material changed, just continue. This is not a request to stop or to start a new context.</context_notes_nudge>";

export function findNudges(branch, windowId) {
  const nudges = branch.filter((e) => e.type === "custom" && e.customType === NUDGE_ENTRY && e.data?.windowId === windowId);
  for (const entry of nudges) {
    const data = entry.data;
    if (typeof data.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.fingerprint) ||
        !Number.isSafeInteger(data.occurrence) || data.occurrence < 0 || data.text !== NUDGE_TEXT) {
      throw new Error("저장된 노트 갱신 안내 기록이 잘못됐어요.");
    }
  }
  return nudges;
}

export function messageFingerprint(message) {
  // Restrict to stable model-message fields; never persist message content here.
  return createHash("sha256").update(JSON.stringify([message?.role, message?.timestamp,
    message?.toolCallId, message?.toolName, message?.content])).digest("hex");
}

export function findReminder(branch, windowId) {
  const reminders = branch.filter((e) => e.type === "custom" && e.customType === REMINDER_ENTRY && e.data?.windowId === windowId);
  if (reminders.length > 1) throw new Error("같은 문맥 창에 중복된 안내 기록이 있어요.");
  const entry = reminders[0];
  if (!entry) return undefined;
  const data = entry.data;
  if (typeof data.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.fingerprint) ||
      !Number.isSafeInteger(data.occurrence) || data.occurrence < 0 || data.text !== REMINDER_TEXT) {
    throw new Error("저장된 문맥 안내 기록이 잘못됐어요.");
  }
  return entry;
}

export function reminderAnchor(messages, windowId, text = REMINDER_TEXT) {
  if (!messages.length) throw new Error("안내를 붙일 문맥 항목이 없어요.");
  const fingerprint = messageFingerprint(messages.at(-1));
  const occurrence = messages.slice(0, -1).filter((m) => messageFingerprint(m) === fingerprint).length;
  return { windowId, fingerprint, occurrence, text };
}

export function reminderIndex(messages, entry) {
  let occurrence = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messageFingerprint(messages[i]) !== entry.data.fingerprint) continue;
    if (occurrence++ === entry.data.occurrence) return i;
  }
  // Never move a previously sent reminder to the end: that edits the cache
  // prefix. A changed serializer/engine needs investigation or a new window.
  throw new Error("저장된 문맥 안내의 위치를 찾지 못했어요. 안내 위치를 바꿔 캐시와 기록을 어긋나게 하지 않고 멈췄어요.");
}

export function reminderMessage(entry) {
  return { role: "user", timestamp: 0, content: [{ type: "text", text: entry.data.text }] };
}
