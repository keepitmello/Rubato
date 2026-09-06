import { randomBytes } from "node:crypto";

export const SOURCE = "rubato-history-notes-v1";
export const INIT_ENTRY = "rubato.context-window.init.v1";
export const PREPARE_ENTRY = "rubato.context-window.prepare.v1";
export const MODE_ENTRY = "rubato.context-mode.v1";
export const NOTE_ENTRY = "rubato.context-note.v1";
export const REMINDER_ENTRY = "rubato.context-window.reminder.v1";
export const BOOTSTRAP_PREFIX = "<rubato_context_window_v1>\n";
export const BOOTSTRAP_END = "\n</rubato_context_window_v1>";

export function uuidv7(now = Date.now()) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const s = bytes.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function validateWindow(window) {
  const validId = (id) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
  if (!window || !validId(window.windowId) || !validId(window.firstWindowId) ||
      !(window.previousWindowId === null || validId(window.previousWindowId)) ||
      !Number.isSafeInteger(window.number) || window.number < 0) {
    throw new Error("저장된 문맥 창 정보가 올바르지 않아요.");
  }
  if ((window.number === 0 && (window.windowId !== window.firstWindowId || window.previousWindowId !== null)) ||
      (window.number > 0 && (!window.previousWindowId || window.windowId === window.previousWindowId))) {
    throw new Error("문맥 창의 순서와 연결이 올바르지 않아요.");
  }
  return window;
}

export function initialWindow() {
  const id = uuidv7();
  return { firstWindowId: id, previousWindowId: null, windowId: id, number: 0 };
}

export function nextWindow(current) {
  validateWindow(current);
  return { firstWindowId: current.firstWindowId, previousWindowId: current.windowId,
    windowId: uuidv7(), number: current.number + 1 };
}

export function encodeBootstrap(window, hint = "") {
  validateWindow(window);
  if (typeof hint !== "string" || Buffer.byteLength(hint) > 4000) throw new Error("노트 안내 크기를 초과했어요.");
  return BOOTSTRAP_PREFIX + JSON.stringify({ ...window, hint }) + BOOTSTRAP_END;
}

export function decodeBootstrap(text) {
  if (typeof text !== "string" || !text.startsWith(BOOTSTRAP_PREFIX)) return undefined;
  if (!text.endsWith(BOOTSTRAP_END)) throw new Error("문맥 창 안내가 잘렸어요.");
  const data = JSON.parse(text.slice(BOOTSTRAP_PREFIX.length, -BOOTSTRAP_END.length));
  validateWindow(data);
  if (typeof data.hint !== "string" || Buffer.byteLength(data.hint) > 4000) throw new Error("노트 안내가 잘못됐어요.");
  return data;
}

export function bootstrapMessage(summary, timestamp = Date.now()) {
  const data = decodeBootstrap(summary);
  if (!data) return undefined;
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
  return { role: "user", timestamp: Number.isFinite(time) ? time : 0,
    content: [{ type: "text", text: summary }] };
}

export function isWindowCompaction(entry) {
  return entry?.type === "compaction" && entry.details?.source === SOURCE;
}

export function branchWindow(branch) {
  const init = branch.find((e) => e.type === "custom" && e.customType === INIT_ENTRY);
  let current = init ? validateWindow(init.data.window) : undefined;
  for (const entry of branch) {
    if (!isWindowCompaction(entry)) continue;
    const data = decodeBootstrap(entry.summary);
    const window = validateWindow(entry.details.window);
    if (!data || !sameWindow(data, window)) throw new Error("문맥 전환 기록이 서로 맞지 않아요.");
    if (current && (window.firstWindowId !== current.firstWindowId ||
        window.previousWindowId !== current.windowId || window.number !== current.number + 1)) {
      throw new Error("문맥 창의 이전 기록 연결이 끊겼어요. 자동으로 복구한 것처럼 진행하지 않았어요.");
    }
    current = window;
  }
  return current;
}

export function notePath(path) {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path) > 512 || /[\x00-\x1f\x7f\\]/u.test(path)) {
    throw new Error("노트 이름이 올바르지 않아요.");
  }
  // Virtual paths, never resolved against the real filesystem. Scope is the
  // current session/branch, including a fork's inherited entries.
  let value = path.startsWith("/root/notes/") ? path.slice(12) : path;
  if (value.startsWith("/")) throw new Error("이 구현에서는 현재 세션의 노트만 읽고 쓸 수 있어요.");
  const parts = value.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("빈 경로나 상위 경로는 사용할 수 없어요.");
  return value;
}

export function notePrefix(prefix = "") {
  if (prefix == null || prefix === "" || prefix === "/root/notes" || prefix === "/root/notes/") return "";
  if (typeof prefix !== "string") throw new Error("노트 접두사는 문자열이어야 해요.");
  const directory = prefix.endsWith("/");
  return notePath(directory ? prefix.slice(0, -1) : prefix) + (directory ? "/" : "");
}

export function codepointSlice(text, offset, limit) {
  return Array.from(text).slice(offset, offset + limit).join("");
}

export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return JSON.stringify(message ?? {});
  return message.content.map((part) => {
    if (part?.type === "text") return part.text ?? "";
    if (part?.type === "image") return `[image mime=${part.mimeType ?? "unknown"}]`;
    return JSON.stringify(part);
  }).join("\n");
}

export function lastUserId(branch) {
  return branch.findLast((e) => e.type === "message" && e.message?.role === "user")?.id ?? null;
}

export function validateTransition(result) {
  if (result?.details?.source !== SOURCE) throw new Error("새 문맥 모드에서는 요약 압축을 실행하지 않아요. /new-context를 사용해 주세요.");
  const data = decodeBootstrap(result.summary);
  const window = validateWindow(result.details.window);
  if (!data || !sameWindow(data, window) || typeof result.firstKeptEntryId !== "string" || !result.firstKeptEntryId) {
    throw new Error("문맥 전환 결과가 올바르지 않아요.");
  }
}

export function sameWindow(a, b) {
  return ["firstWindowId", "previousWindowId", "windowId", "number"].every((key) => a[key] === b[key]);
}
