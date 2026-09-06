import { historyNotesEnabled } from "./config.mjs";
import { SUMMARY_SESSION_TOOL_ERROR } from "./mode-policy.mjs";

export const CONTEXT_NOTES_TOOL_NAMES = Object.freeze([
  "history_list_windows", "history_list_items", "history_search_contents", "history_read_item",
  "notes_list_files_by_prefix", "notes_read_file", "notes_search_contents", "notes_write_file",
  "notes_append_to_file", "new_context", "get_context_remaining",
]);

export function syncNotesToolActivation(pi, enabled) {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const notes = new Set(CONTEXT_NOTES_TOOL_NAMES);
  const current = pi.getActiveTools();
  const next = enabled
    ? [...new Set([...current, ...CONTEXT_NOTES_TOOL_NAMES])]
    : current.filter((name) => !notes.has(name));
  pi.setActiveTools(next);
}

// Flat tool names preserve the Codex operations across providers whose function
// names cannot contain periods. TypeBox comes from the pinned senpi installation.
export function createContextNotesTools(getController, T, notesActive = historyNotesEnabled) {
  const optional = (type) => T.Optional(type);
  const str = () => T.String();
  const int = (max = 100) => optional(T.Integer({ minimum: 1, maximum: max }));
  const flag = () => optional(T.Boolean());
  const agent = () => optional(str());
  const historyFilters = () => ({ agent_name: agent(), window_id: optional(str()),
    role: optional(T.Union(["user", "assistant", "tool", "system", "developer"].map((v) => T.Literal(v)))),
    tool_name: optional(str()), tool_namespace: optional(str()), recent_first: flag(),
    limit: int(), after_item_id: optional(str()), max_chars_per_item: int(2000) });
  const definitions = [
    ["history_list_windows", "과거 문맥 창 목록", "List prior context windows and item counts in this session's current branch.",
      { agent_name: agent(), limit: int(), recent_first: flag(), after_window_id: optional(str()) }, (c, p) => c.store.listWindows(p)],
    ["history_list_items", "과거 기록 목록", "List history by window, role or tool. Follow next_after_item_id to page. IDs must be copied unchanged.",
      historyFilters(), (c, p) => c.store.listItems(p)],
    ["history_search_contents", "과거 기록 검색", "Case-sensitive literal substring search over original history, not semantic search. Read a result with history_read_item.",
      { ...historyFilters(), query: T.String({ minLength: 1, maxLength: 2000 }) }, (c, p) => c.store.listItems(p, true)],
    ["history_read_item", "과거 기록 읽기", "Read a bounded Unicode-character range of a history item. view=raw reads the original persisted entry JSON, including multimodal data. Text view uses image placeholders. include_image=true attaches one original image selected by zero-based image_index (up to 4,000,000 base64 characters).",
      { agent_name: agent(), window_id: str(), item_id: str(),
        offset_chars: optional(T.Integer({ minimum: 0 })), limit_chars: int(20000),
        view: optional(T.Union([T.Literal("text"), T.Literal("raw")])), include_image: flag(), image_index: optional(T.Integer({ minimum: 0 })) }, (c, p) => c.store.readItem(p)],
    ["notes_list_files_by_prefix", "작업 노트 목록", "List virtual note paths in the current session and branch. These are not filesystem paths.",
      { prefix: optional(str()), max_results: int(), after_path: optional(str()),
        file_order_by: optional(T.Union(["name", "created_at", "updated_at"].map((v) => T.Literal(v)))),
        file_order: optional(T.Union([T.Literal("ascending"), T.Literal("descending")])) }, (c, p) => c.store.noteList(p)],
    ["notes_read_file", "작업 노트 읽기", "Read notes by inclusive 1-based lines (negative lines count from the end), or offset_chars/limit_chars for character paging. Follow the returned continuation. Read relevant notes after a window change.",
      { path: str(), start_line: optional(T.Integer()), stop_line: optional(T.Integer()),
        offset_chars: optional(T.Integer({ minimum: 0 })), limit_chars: int(20000) },
      (c, p) => {
        if (p.offset_chars !== undefined || p.limit_chars !== undefined) {
          if (p.start_line !== undefined || p.stop_line !== undefined) throw new Error("줄 범위와 문자 범위를 함께 지정하지 마세요.");
          return c.store.noteReadChars(p);
        }
        return c.store.noteRead(p);
      }],
    ["notes_search_contents", "작업 노트 검색", "Search note lines by case-sensitive literal substring. Read matching files for details.",
      { query: T.String({ minLength: 1, maxLength: 2000 }), path_prefix: optional(str()),
        max_files: int(50), max_matches_per_file: int(50), recent_file_first: flag(), after_path: optional(str()) }, (c, p) => c.store.noteSearch(p)],
    ["notes_write_file", "작업 노트 저장", "Create or replace a working note. Save goal, decisions, failed approaches, progress, next steps and original window/item references. Maximum 1,000,000 UTF-8 bytes per note.",
      { path: str(), text: str() }, (c, p, ctx, id, signal) => c.writeNote(p, ctx, { operationId: id, signal }), "sequential"],
    ["notes_append_to_file", "작업 노트에 추가", "Append exactly the supplied text, without an automatic newline. Note writes persist independently of the active context.",
      { path: str(), text: str() }, (c, p, ctx, id, signal) => c.writeNote(p, ctx, { append: true, operationId: id, signal }), "sequential"],
    ["new_context", "새 문맥 창으로 전환", "Start a fresh context window without summarizing. First save a current working note. Transition happens at the completed tool-round boundary; no environment reset and no new session.",
      {}, (c, _p, ctx, _id, signal) => c.requestWindow(ctx, signal), "sequential"],
    ["get_context_remaining", "남은 문맥 확인", "Get the experimental input budget, current estimate and window IDs. Save a checkpoint before the budget is exhausted.",
      {}, (c) => ({ ...c.usage(), window: c.window, mode: "history-notes" })],
  ];
  return definitions.map(([name, label, description, properties, action, executionMode = "parallel"]) => ({
    name, label, description, exposure: "search", allowLazyActivation: false, executionMode,
    parameters: T.Object(properties, { additionalProperties: false }),
    async execute(id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!notesActive()) throw new Error(SUMMARY_SESSION_TOOL_ERROR);
      const controller = getController(ctx);
      controller.refresh(ctx);
      if (controller.fatal) throw new Error(controller.fatal);
      const started = Date.now();
      try {
        const value = await action(controller, params, ctx, id, signal);
        const text = JSON.stringify(value);
        const image = name === "history_read_item" && params.include_image ? controller.store.readImage(params) : undefined;
        controller.record("tool_completed", { name, window_id: controller.window.windowId, duration_ms: Date.now() - started, output_chars: text.length, output_utf8_bytes: Buffer.byteLength(text),
          image_base64_chars: image?.data.length ?? 0 });
        return { content: [{ type: "text", text }, ...(image ? [image] : [])], details: { contextNotes: true } };
      } catch (error) {
        try { controller.record("tool_failed", { name, window_id: controller.window.windowId, duration_ms: Date.now() - started }); } catch {}
        throw error;
      }
    },
  }));
}
