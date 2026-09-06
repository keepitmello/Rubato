import { NOTE_ENTRY } from "./protocol.mjs";

export const MANAGEMENT_TOOLS = new Set([
  "history_list_windows", "history_list_items", "history_search_contents", "history_read_item",
  "notes_list_files_by_prefix", "notes_read_file", "notes_search_contents", "notes_write_file",
  "notes_append_to_file", "new_context", "get_context_remaining",
]);

/** A note is a safe checkpoint only if no newer work can be lost by the cut. */
export function assertCheckpointFresh(branch, note, { allowStale = false } = {}) {
  const index = branch.findIndex((e) => e.id === note?.id && e.type === "custom" && e.customType === NOTE_ENTRY);
  if (index < 0) throw new Error("현재 가지에서 작업 노트를 찾지 못했어요.");
  if (allowStale) return;
  for (const entry of branch.slice(index + 1)) {
    if (entry.type === "custom_message") {
      throw new Error("노트 저장 뒤 새 안내나 작업 요청이 도착했어요. 노트를 갱신한 뒤 전환해 주세요.");
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "toolResult" && MANAGEMENT_TOOLS.has(message.toolName)) continue;
    if (message?.role === "assistant" && !["error", "aborted"].includes(message.stopReason)) {
      const calls = Array.isArray(message.content) ? message.content.filter((p) => p?.type === "toolCall") : [];
      if (calls.length > 0 && calls.every((p) => MANAGEMENT_TOOLS.has(p.name))) continue;
    }
    throw new Error("노트 저장 뒤 새 작업 결과가 생겼어요. 최신 상태를 노트에 저장한 뒤 전환해 주세요.");
  }
}
