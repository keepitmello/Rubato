import { createHash } from "node:crypto";
import { REMINDER_ENTRY } from "./protocol.mjs";

export const REMINDER_TEXT = "<context_window_reminder>This window is nearing its input budget. Save current goals, decisions, progress, failed approaches, next steps and original window/item references with the notes tools, then call new_context. The next window will not include this conversation. Do not start another large task before saving your state. Use get_context_remaining for a current estimate.</context_window_reminder>";

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

export function reminderAnchor(messages, windowId) {
  if (!messages.length) throw new Error("안내를 붙일 문맥 항목이 없어요.");
  const fingerprint = messageFingerprint(messages.at(-1));
  const occurrence = messages.slice(0, -1).filter((m) => messageFingerprint(m) === fingerprint).length;
  return { windowId, fingerprint, occurrence, text: REMINDER_TEXT };
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
