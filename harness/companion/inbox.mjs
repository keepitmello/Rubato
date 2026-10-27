// Segno's inbox: the issues the user's work brings in — a bug report from another Telegram chat, a
// note Segno sets aside — kept in one SQLite file the way a Linear list would, so a state change is
// a row, not a rewrite.
//
//   <companion home>/inbox/inbox.sqlite
//
// One item is: id, number, title, body, source (telegram / user / lead / note), the source's own
// reference, the reporter, status (open / in-progress / waiting / done / dropped), the lead
// conversation it was handed to, and timestamps. Every change appends a note row, so the list
// keeps what happened without a second log.
//
// The file is self-contained on purpose (no local imports): the same file is staged into the
// runtime build so the companion's inbox tools can read and write it beside the engine.
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const INBOX_STATUSES = Object.freeze(['open', 'in-progress', 'waiting', 'done', 'dropped']);
export const OPEN_STATUSES = Object.freeze(['open', 'in-progress', 'waiting']);
export const INBOX_SOURCES = Object.freeze(['telegram', 'user', 'lead', 'agent', 'note']);

/** The same rule as `companionHome` in companion.mjs; repeated because this file is also staged. */
export function companionHomeFor(env = process.env) {
  if (env.RUBATO_COMPANION_HOME) return path.resolve(env.RUBATO_COMPANION_HOME);
  return path.join(env.HOME || homedir(), '.rubato', 'companion');
}

export function inboxPath(env = process.env) {
  return path.join(companionHomeFor(env), 'inbox', 'inbox.sqlite');
}

/**
 * The wake line file (user item 5b32e195): the user's Telegram listener (tgd) appends one JSON line
 * per message Segno should wake for — one that tags the user or answers the user's own message —
 * `{"v":1,"at":ISO,"marker":"b-…","itemIds":["…"],"text":"…"}`, after writing the items to the
 * inbox. Everything else only lands in the inbox and Segno sees it on its heartbeat. The keeper
 * reads the file forward by bytes and wakes Segno (keeper.mjs).
 */
export function inboxWakePath(env = process.env) {
  return path.join(companionHomeFor(env), 'inbox', 'wake.jsonl');
}

/** Wake lines that come within this long of the first unread one go to Segno in one wake. */
export const INBOX_WAKE_WINDOW_MS = 5 * 60_000;
/** A line older than this when the keeper reads it is not woken for: the item waits in the inbox. */
export const INBOX_WAKE_STALE_MS = 60 * 60_000;

/**
 * The complete wake lines after byte `offset`: `records` in file order, `end` the byte after the
 * last complete line (an unfinished last line waits for its newline), `size` the file's size
 * (undefined when there is no file), `skipped` lines that are not a wake record.
 */
export function readInboxWakes(offset, env = process.env) {
  const file = inboxWakePath(env);
  let size;
  try { size = statSync(file).size; } catch { return { records: [], end: offset, size: undefined, skipped: 0 }; }
  if (size <= offset) return { records: [], end: offset, size, skipped: 0 };
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
  const last = buffer.lastIndexOf(0x0a);
  if (last < 0) return { records: [], end: offset, size, skipped: 0 };
  const records = [];
  let skipped = 0;
  for (const line of buffer.subarray(0, last).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const itemIds = Array.isArray(record?.itemIds) ? record.itemIds.filter((id) => typeof id === 'string' && id) : [];
      if (typeof record?.text !== 'string' && !itemIds.length) { skipped += 1; continue; }
      records.push({ at: typeof record.at === 'string' ? record.at : undefined, marker: typeof record.marker === 'string' ? record.marker : undefined,
        itemIds, text: typeof record.text === 'string' ? record.text : '' });
    } catch { skipped += 1; }
  }
  return { records, end: offset + last + 1, size, skipped };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  source_ref TEXT UNIQUE,
  reporter TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  lead_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS item_notes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT
);
CREATE INDEX IF NOT EXISTS items_status ON items(status, seq DESC);
CREATE INDEX IF NOT EXISTS notes_item ON item_notes(item_id, seq);
`;

const toItem = (row) => row && {
  id: row.id,
  number: row.seq,
  title: row.title,
  body: row.body,
  source: row.source,
  ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
  ...(row.reporter ? { reporter: row.reporter } : {}),
  status: row.status,
  ...(row.lead_session_id ? { leadSessionId: row.lead_session_id } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.closed_at ? { closedAt: row.closed_at } : {}),
};

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Opens (and on first use creates) Segno's inbox. Safe across processes: WAL and a busy timeout, so
 * the engine writing a report and a tool reading the list never lock each other out.
 */
export function openInbox({ env = process.env, now = Date.now } = {}) {
  const file = inboxPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const at = () => new Date(now()).toISOString();
  const note = (itemId, kind, text, when) =>
    db.prepare('INSERT INTO item_notes (item_id, at, kind, text) VALUES (?, ?, ?, ?)').run(itemId, when, kind, text ?? null);
  const byId = (id) => toItem(db.prepare('SELECT * FROM items WHERE id = ?').get(id));

  function add({ title, body = '', source = 'user', sourceRef, reporter, status = 'open', leadSessionId } = {}) {
    const cleanTitle = oneLine(title);
    if (!cleanTitle) throw new TypeError('an inbox item needs a title');
    if (!INBOX_SOURCES.includes(source)) throw new TypeError(`source must be one of ${INBOX_SOURCES.join(', ')}`);
    if (!INBOX_STATUSES.includes(status)) throw new TypeError(`status must be one of ${INBOX_STATUSES.join(', ')}`);
    if (sourceRef) {
      // The same Telegram message delivered twice is one issue, not two.
      const existing = db.prepare('SELECT * FROM items WHERE source_ref = ?').get(String(sourceRef));
      if (existing) return { item: toItem(existing), duplicate: true };
    }
    const when = at();
    db.exec('BEGIN');
    try {
      const next = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM items').get().n;
      const id = `S-${next}`;
      db.prepare(`INSERT INTO items (seq, id, title, body, source, source_ref, reporter, status, lead_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(next, id, cleanTitle, String(body ?? ''), source,
        sourceRef ? String(sourceRef) : null, reporter ? String(reporter) : null, status,
        leadSessionId ? String(leadSessionId) : null, when, when);
      note(id, 'created', `from ${source}`, when);
      db.exec('COMMIT');
      return { item: byId(id), duplicate: false };
    } catch (error) {
      // SQLite already rolled back on some errors (a full disk); a second ROLLBACK would hide it.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function list({ status, source, unlinked, limit = 30 } = {}) {
    const capped = Math.min(200, Math.max(1, Math.floor(limit)));
    const where = [];
    const values = [];
    // A row no lead holds yet: what the person still has to hand to someone.
    if (unlinked === true) where.push('lead_session_id IS NULL');
    if (status === 'open') { where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`); values.push(...OPEN_STATUSES); }
    else if (status !== undefined) {
      if (!INBOX_STATUSES.includes(status)) throw new TypeError(`status must be one of ${INBOX_STATUSES.join(', ')}`);
      where.push('status = ?'); values.push(status);
    }
    if (source !== undefined) { where.push('source = ?'); values.push(String(source)); }
    const sql = `SELECT * FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return db.prepare(sql).all(...values, capped).map(toItem);
  }

  function get(id) {
    const item = byId(String(id));
    if (!item) return undefined;
    return { ...item, notes: db.prepare('SELECT at, kind, text FROM item_notes WHERE item_id = ? ORDER BY seq').all(item.id) };
  }

  function update(id, patch = {}) {
    const current = byId(String(id));
    if (!current) throw new TypeError(`no inbox item ${String(id)}`);
    const { status, title, body, leadSessionId, note: text } = patch;
    if (status !== undefined && !INBOX_STATUSES.includes(status)) throw new TypeError(`status must be one of ${INBOX_STATUSES.join(', ')}`);
    const when = at();
    const closed = status !== undefined && (status === 'done' || status === 'dropped');
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE items SET title = ?, body = ?, status = ?, lead_session_id = ?, updated_at = ?, closed_at = ? WHERE id = ?`).run(
        title === undefined ? current.title : oneLine(title),
        body === undefined ? current.body : String(body),
        status === undefined ? current.status : status,
        leadSessionId === undefined ? current.leadSessionId ?? null : leadSessionId ? String(leadSessionId) : null,
        when,
        closed ? when : status === undefined ? current.closedAt ?? null : null,
        current.id,
      );
      if (status !== undefined && status !== current.status) note(current.id, 'status', `${current.status} → ${status}`, when);
      if (leadSessionId !== undefined && leadSessionId !== (current.leadSessionId ?? null) && leadSessionId)
        note(current.id, 'linked', String(leadSessionId), when);
      if (text) note(current.id, 'note', String(text), when);
      db.exec('COMMIT');
    } catch (error) {
      // SQLite already rolled back on some errors (a full disk); a second ROLLBACK would hide it.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    return byId(current.id);
  }

  /** How many items are still someone's work: the number the Segno space and the day's report read. */
  function counts() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all();
    const by = Object.fromEntries(rows.map((row) => [row.status, row.n]));
    return { ...by, open: OPEN_STATUSES.reduce((total, name) => total + (by[name] ?? 0), 0) };
  }

  return {
    path: file,
    add,
    list,
    get,
    update,
    counts,
    /** SQLite keeps the last connection; closing lets a test remove the folder. */
    close() { db.close(); },
  };
}

/** Whether the inbox file exists yet (the settings page and the space show it without creating it). */
export function inboxExists(env = process.env) {
  return existsSync(inboxPath(env));
}

