import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { INIT_ENTRY, NOTE_ENTRY, SOURCE, branchWindow, codepointSlice, isWindowCompaction,
  messageText, notePath, notePrefix, validateWindow } from "./protocol.mjs";

export function databasePath(agentDir, sessionId) {
  if (typeof agentDir !== "string" || !agentDir || typeof sessionId !== "string" || !sessionId) {
    throw new Error("문맥 기록을 저장할 세션 위치가 없어요.");
  }
  const key = createHash("sha256").update(sessionId).digest("hex");
  return join(agentDir, "context-notes", `${key}.sqlite`);
}

function safeInteger(value, fallback, min, max, name) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} 값이 범위를 벗어났어요.`);
  return n;
}

function ownAgent(name) {
  if (name != null && !["root", "/root", "."].includes(name)) {
    throw new Error("기록 검색은 현재 세션 범위로 제한돼 있어요. 다른 세션은 해당 세션에서 열어 주세요.");
  }
}

function resultPage(items, requested, maxChars = 24_000) {
  const result = [];
  let length = 300;
  for (const item of items.slice(0, requested)) {
    const cost = JSON.stringify(item).length;
    if (length + cost > maxChars) break;
    result.push(item);
    length += cost;
  }
  return { items: result, has_more: result.length < items.length,
    next_after_item_id: result.length ? result.at(-1).item_id ?? null : null };
}

export class ContextNotesStore {
  constructor(path, { maxNoteBytes = 1_000_000 } = {}) {
    this.path = path;
    this.maxNoteBytes = maxNoteBytes;
    this.noteVersions = new Map();
    this.activeIds = new Set();
    this.branch = [];
    this.current = undefined;
    this.closed = false;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("문맥 저장소 디렉터리에 심볼릭 링크를 사용할 수 없어요.");
      chmodSync(dirname(path), 0o700);
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        try { if (lstatSync(candidate).isSymbolicLink()) throw new Error("문맥 저장소에 심볼릭 링크를 사용할 수 없어요."); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    this.db = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (version !== 0 && version !== 1) throw new Error(`지원하지 않는 문맥 저장소 버전이에요: ${version}`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS windows (
          id TEXT PRIMARY KEY, first_id TEXT NOT NULL, previous_id TEXT, number INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY, window_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
          role TEXT NOT NULL, kind TEXT NOT NULL, tool_name TEXT, content TEXT NOT NULL,
          raw TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS items_window ON items(window_id, ordinal);
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, text TEXT NOT NULL, window_id TEXT NOT NULL,
          through_user_id TEXT, ordinal INTEGER NOT NULL, operation_id TEXT
        );
        CREATE TABLE IF NOT EXISTS diagnostics (
          ordinal INTEGER PRIMARY KEY, created_at TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE TEMP TABLE active_items (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL);
        PRAGMA user_version=1;
      `);
      if (path !== ":memory:") {
        for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
          try { chmodSync(candidate, 0o600); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  initialWindowFromArchive() {
    const row = this.db.prepare("SELECT * FROM windows WHERE number=0 ORDER BY rowid LIMIT 1").get();
    return row ? { firstWindowId: row.first_id, previousWindowId: row.previous_id, windowId: row.id, number: 0 } : undefined;
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // The session journal is authoritative, including note revisions and window
  // boundaries. SQLite is an immutable archive plus a disposable search index.
  // A branch's active set is connection-local: rewinding never imports future
  // messages/notes, even if they remain in the on-disk archive.
  sync(branch) {
    if (this.closed) throw new Error("문맥 저장소가 닫혔어요.");
    if (!Array.isArray(branch)) throw new Error("세션 기록을 읽지 못했어요.");
    const current = branchWindow(branch);
    if (!current) throw new Error("세션에 문맥 창 시작 기록이 없어요.");
    const init = branch.find((e) => e.type === "custom" && e.customType === INIT_ENTRY);
    let window = init ? validateWindow(init.data.window) : current;
    const notes = new Map();
    const activeIds = new Set();
    const putWindow = this.db.prepare("INSERT OR IGNORE INTO windows VALUES (?, ?, ?, ?)");
    const putItem = this.db.prepare("INSERT OR IGNORE INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const getItem = this.db.prepare("SELECT raw FROM items WHERE id=?");
    const putActive = this.db.prepare("INSERT INTO active_items VALUES (?, ?)");
    const putNote = this.db.prepare("INSERT OR IGNORE INTO notes VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.transaction(() => {
      this.db.exec("DELETE FROM active_items");
      putWindow.run(window.windowId, window.firstWindowId, window.previousWindowId, window.number);
      for (let ordinal = 0; ordinal < branch.length; ordinal += 1) {
        const entry = branch[ordinal];
        if (!entry || typeof entry.id !== "string") throw new Error("식별자가 없는 세션 항목이 있어요.");
        if (isWindowCompaction(entry)) {
          window = validateWindow(entry.details.window);
          putWindow.run(window.windowId, window.firstWindowId, window.previousWindowId, window.number);
        }
        if (entry.type === "custom" && entry.customType === NOTE_ENTRY) {
          const data = entry.data;
          const path = notePath(data.path);
          if (typeof data.text !== "string" || Buffer.byteLength(data.text) > this.maxNoteBytes) throw new Error("저장된 노트 크기가 올바르지 않아요.");
          if (data.windowId !== window.windowId) throw new Error("노트가 기록된 문맥 창과 노트의 식별자가 달라요.");
          putNote.run(entry.id, path, data.text, data.windowId, data.throughUserId ?? null, ordinal, data.operationId ?? null);
          const saved = this.db.prepare("SELECT * FROM notes WHERE id=?").get(entry.id);
          if (saved.text !== data.text || saved.path !== path || saved.window_id !== data.windowId ||
              saved.through_user_id !== (data.throughUserId ?? null) || saved.operation_id !== (data.operationId ?? null)) {
            throw new Error("같은 식별자의 노트가 변경됐어요. 기존 기록은 덮어쓰지 않았어요.");
          }
          notes.set(path, { ...data, id: entry.id, path, ordinal, createdOrdinal: notes.get(path)?.createdOrdinal ?? ordinal });
        }
        let message;
        if (entry.type === "message") message = entry.message;
        else if (entry.type === "custom_message") message = { role: "user", content: entry.content };
        if (!message) continue;
        const raw = JSON.stringify(entry);
        const existing = getItem.get(entry.id);
        if (existing && existing.raw !== raw) throw new Error(`기록 항목 ${entry.id}의 원문이 변경됐어요. 덮어쓰지 않고 멈췄어요.`);
        const role = message.role === "toolResult" ? "tool" : message.role ?? "unknown";
        putItem.run(entry.id, window.windowId, ordinal, role, entry.type,
          message.toolName ?? null, messageText(message), raw, String(entry.timestamp ?? ""));
        putActive.run(entry.id, ordinal);
        activeIds.add(entry.id);
      }
    });
    this.branch = branch;
    this.current = current;
    this.noteVersions = notes;
    this.activeIds = activeIds;
    return current;
  }

  latestNoteForWindow(windowId, userId) {
    return [...this.noteVersions.values()].filter((note) => note.windowId === windowId &&
      note.throughUserId === userId && note.text.trim()).sort((a, b) => b.ordinal - a.ordinal)[0];
  }

  noteForOperation(operationId) {
    if (!operationId) return undefined;
    const entry = this.branch.findLast((e) => e.type === "custom" && e.customType === NOTE_ENTRY && e.data?.operationId === operationId);
    return entry ? { ...entry.data, id: entry.id } : undefined;
  }

  noteText(path) { return this.noteVersions.get(notePath(path))?.text; }

  noteRead({ path, start_line, stop_line } = {}) {
    path = notePath(path);
    const note = this.noteVersions.get(path);
    if (!note) throw new Error(`현재 대화 가지에 노트가 없어요: ${path}`);
    const lines = note.text === "" ? [] : note.text.split("\n");
    const resolve = (n, fallback) => {
      if (n == null) return fallback;
      if (!Number.isSafeInteger(n) || n === 0) throw new Error("줄 번호는 0이 아닌 정수여야 해요.");
      return n < 0 ? lines.length + n + 1 : n;
    };
    const first = Math.max(1, resolve(start_line, 1));
    const last = Math.min(lines.length, resolve(stop_line, lines.length));
    let text = "";
    let end = first - 1;
    for (let i = first; i <= last; i += 1) {
      const next = (i === first ? "" : "\n") + lines[i - 1];
      if (Array.from(text).length + Array.from(next).length > 20_000) {
        if (text === "") {
          // Do not get stuck on a single enormous line. Character reads below
          // provide an exact continuation without splitting UTF-16 surrogates.
          return this.noteReadChars({ path, offset_chars: Array.from(lines.slice(0, first - 1).join("\n") + (first > 1 ? "\n" : "")).length });
        }
        break;
      }
      text += next; end = i;
    }
    return { path, text, start_line: first, stop_line: end, total_lines: lines.length,
      truncated: end < last, next_start_line: end < last ? end + 1 : null };
  }

  noteReadChars({ path, offset_chars = 0, limit_chars = 20_000 }) {
    path = notePath(path);
    const text = this.noteText(path);
    if (text === undefined) throw new Error("현재 대화 가지에 해당 노트가 없어요.");
    const offset = safeInteger(offset_chars, 0, 0, Number.MAX_SAFE_INTEGER, "offset_chars");
    const limit = safeInteger(limit_chars, 20_000, 1, 20_000, "limit_chars");
    const total = Array.from(text).length;
    return { path, text: codepointSlice(text, offset, limit), offset_chars: offset, total_chars: total,
      truncated: offset + limit < total, next_offset_chars: offset + limit < total ? offset + limit : null };
  }

  noteList({ prefix = "", max_results = 20, file_order_by = "name", file_order = "ascending", after_path } = {}) {
    prefix = notePrefix(prefix);
    if (!["name", "created_at", "updated_at"].includes(file_order_by) || !["ascending", "descending"].includes(file_order)) throw new Error("노트 정렬 방식이 올바르지 않아요.");
    const limit = safeInteger(max_results, 20, 1, 100, "max_results");
    let notes = [...this.noteVersions.values()].filter((n) => n.path.startsWith(prefix));
    const compareName = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    notes.sort((a, b) => (file_order_by === "name" ? compareName(a, b) : file_order_by === "created_at" ? a.createdOrdinal - b.createdOrdinal : a.ordinal - b.ordinal) * (file_order === "ascending" ? 1 : -1));
    if (after_path !== undefined) {
      const at = notes.findIndex((n) => n.path === notePath(after_path));
      if (at < 0) throw new Error("현재 노트 목록에 없는 이어보기 위치예요.");
      notes = notes.slice(at + 1);
    }
    const files = []; let size = 300;
    for (const n of notes.slice(0, limit)) {
      const file = { path: n.path, bytes: Buffer.byteLength(n.text),
        lines: n.text === "" ? 0 : n.text.split("\n").length, revision_id: n.id };
      const length = JSON.stringify(file).length;
      if (size + length > 22000) break;
      files.push(file); size += length;
    }
    return { files, has_more: notes.length > files.length,
      next_after_path: notes.length > files.length ? files.at(-1)?.path ?? null : null };
  }

  noteSearch({ query, path_prefix = "", max_files = 10, max_matches_per_file = 5,
      recent_file_first = true, after_path } = {}) {
    if (typeof query !== "string" || !query || query.length > 2000) throw new Error("검색어는 1~2000자여야 해요.");
    const count = safeInteger(max_files, 10, 1, 50, "max_files");
    const perFile = safeInteger(max_matches_per_file, 5, 1, 50, "max_matches_per_file");
    const prefix = notePrefix(path_prefix);
    let notes = [...this.noteVersions.values()].filter(n => n.path.startsWith(prefix))
      .sort((a, b) => (recent_file_first ? -1 : 1) * (a.ordinal - b.ordinal));
    if (after_path !== undefined) {
      const at = notes.findIndex(n => n.path === notePath(after_path));
      if (at < 0) throw new Error("현재 노트 검색에 없는 이어보기 위치예요.");
      notes = notes.slice(at + 1);
    }
    const result = []; let size = 300;
    for (const note of notes) {
      const matches = []; let matchSize = 0, hasMoreMatches = false;
      const lines = note.text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const at = lines[i].indexOf(query);
        if (at < 0) continue;
        const before = Array.from(lines[i].slice(0, at)).length;
        const match = { line: i + 1, text: codepointSlice(lines[i], Math.max(0, before - 80), 400) };
        const cost = JSON.stringify(match).length;
        if (matches.length === perFile || matchSize + cost > 16000) { hasMoreMatches = true; break; }
        matches.push(match); matchSize += cost;
      }
      if (!matches.length) continue;
      const item = { path: note.path, matches, has_more_matches: hasMoreMatches,
        next_start_line: hasMoreMatches ? matches.at(-1).line + 1 : null };
      const cost = JSON.stringify(item).length;
      if (size + cost > 22000 || result.length === count) return { files: result, truncated: true,
        next_after_path: result.at(-1)?.path ?? null };
      result.push(item); size += cost;
    }
    return { files: result, truncated: false, next_after_path: null };
  }

  hint({ maxBytes = 4000, maxFiles = 5 } = {}) {
    const lines = ["Recent notes (read with notes_read_file; paths are virtual):"];
    for (const note of [...this.noteVersions.values()].sort((a, b) => b.ordinal - a.ordinal).slice(0, maxFiles)) {
      const line = `- ${JSON.stringify(note.path)} (${Buffer.byteLength(note.text)} UTF-8 bytes)`;
      if (Buffer.byteLength([...lines, line].join("\n")) > maxBytes) break;
      lines.push(line);
    }
    return lines.length > 1 ? lines.join("\n") : "No notes yet. Preserve working state with notes_write_file before new_context.";
  }

  listWindows({ limit = 20, recent_first = true, agent_name, after_window_id } = {}) {
    ownAgent(agent_name);
    limit = safeInteger(limit, 20, 1, 100, "limit");
    const ids = new Set([this.current.windowId, this.current.firstWindowId]);
    for (const entry of this.branch) if (isWindowCompaction(entry)) ids.add(entry.details.window.windowId);
    let rows = this.db.prepare("SELECT * FROM windows ORDER BY number " + (recent_first ? "DESC" : "ASC")).all().filter((w) => ids.has(w.id));
    if (after_window_id !== undefined) {
      const at = rows.findIndex((w) => w.id === after_window_id);
      if (at < 0) throw new Error("현재 가지에 없는 문맥 창 이어보기 위치예요.");
      rows = rows.slice(at + 1);
    }
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM items i JOIN active_items a ON a.id=i.id WHERE window_id=?");
    return { windows: rows.slice(0, limit).map((w) => ({ window_id: w.id, first_window_id: w.first_id,
      previous_window_id: w.previous_id, number: w.number, item_count: count.get(w.id).n })), has_more: rows.length > limit,
      next_after_window_id: rows.length > limit ? rows[limit - 1].id : null };
  }

  listItems(params = {}, search = false) {
    ownAgent(params.agent_name);
    const limit = safeInteger(params.limit, 20, 1, 100, "limit");
    const chars = safeInteger(params.max_chars_per_item, 300, 1, 2000, "max_chars_per_item");
    const where = []; const values = [];
    if (params.window_id != null) { where.push("i.window_id=?"); values.push(params.window_id); }
    if (params.role != null) { where.push("i.role=?"); values.push(params.role); }
    if (params.tool_name != null) { where.push("i.tool_name=?"); values.push(params.tool_name); }
    if (params.tool_namespace != null) {
      where.push("i.role='tool' AND substr(i.tool_name, 1, length(?)+1)=? || '.'");
      values.push(params.tool_namespace, params.tool_namespace);
    }
    const recent = params.recent_first !== false;
    if (params.after_item_id != null) {
      const cursor = this.db.prepare("SELECT ordinal FROM active_items WHERE id=?").get(params.after_item_id);
      if (!cursor) throw new Error("현재 가지에 없는 검색 이어보기 위치예요.");
      where.push(`a.ordinal ${recent ? "<" : ">"} ?`); values.push(cursor.ordinal);
    }
    if (search) {
      if (typeof params.query !== "string" || !params.query || params.query.length > 2000) throw new Error("검색어는 1~2000자여야 해요.");
      where.push("instr(i.content, ?) > 0"); values.push(params.query);
    }
    const rows = this.db.prepare(`SELECT i.*, a.ordinal AS active_ordinal FROM items i JOIN active_items a ON a.id=i.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.ordinal ${recent ? "DESC" : "ASC"} LIMIT ?`).all(...values, limit + 1);
    const items = rows.map((row) => {
      const matchAt = search ? Array.from(row.content.slice(0, row.content.indexOf(params.query))).length : 0;
      const start = Math.max(0, matchAt - 80);
      return { window_id: row.window_id, item_id: row.id, role: row.role, tool_name: row.tool_name,
        ordinal: row.active_ordinal, truncated_content: codepointSlice(row.content, start, chars),
        preview_offset_chars: start, total_chars: Array.from(row.content).length };
    });
    return resultPage(items, limit);
  }

  readItem({ item_id, window_id, agent_name, offset_chars = 0, limit_chars = 20_000, view = "text" } = {}) {
    ownAgent(agent_name);
    if (!["text", "raw"].includes(view)) throw new Error("읽기 형식이 올바르지 않아요.");
    const row = this.db.prepare("SELECT i.* FROM items i JOIN active_items a ON a.id=i.id WHERE i.id=? AND i.window_id=?").get(item_id, window_id);
    if (!row) throw new Error("현재 대화 가지에 해당 기록이 없어요.");
    const offset = safeInteger(offset_chars, 0, 0, Number.MAX_SAFE_INTEGER, "offset_chars");
    const limit = safeInteger(limit_chars, 20_000, 1, 20_000, "limit_chars");
    const text = view === "raw" ? row.raw : row.content;
    const total = Array.from(text).length;
    return { item_id, window_id, role: row.role, tool_name: row.tool_name, view,
      content: codepointSlice(text, offset, limit), offset_chars: offset, total_chars: total,
      truncated: offset + limit < total, next_offset_chars: offset + limit < total ? offset + limit : null };
  }

  readImage({ item_id, window_id, agent_name, image_index = 0 } = {}) {
    ownAgent(agent_name);
    const index = safeInteger(image_index, 0, 0, 1000, "image_index");
    const row = this.db.prepare("SELECT i.raw FROM items i JOIN active_items a ON a.id=i.id WHERE i.id=? AND i.window_id=?").get(item_id, window_id);
    if (!row) throw new Error("현재 대화 가지에 해당 기록이 없어요.");
    const entry = JSON.parse(row.raw);
    const images = (entry.message?.content ?? entry.content ?? []);
    const selected = Array.isArray(images) ? images.filter((part) => part?.type === "image")[index] : undefined;
    if (!selected) throw new Error("해당 순서의 이미지가 원문에 없어요.");
    if (typeof selected.data !== "string" || !selected.data || selected.data.length > 4_000_000 ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(selected.mimeType)) {
      throw new Error("이 이미지는 자동 재주입 범위를 벗어났어요. 원문 또는 원래 파일을 확인해 주세요.");
    }
    return { type: "image", data: selected.data, mimeType: selected.mimeType };
  }

  record(event, data = {}) {
    // No note text, user message text, prompts or tool arguments in diagnostics.
    this.db.prepare("INSERT INTO diagnostics(created_at,event,data) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), event, JSON.stringify(data));
  }
  diagnostics() { return this.db.prepare("SELECT * FROM diagnostics ORDER BY ordinal").all(); }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
