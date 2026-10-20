import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionNotFoundError, SessionAmbiguousError } from '@earendil-works/pi-server';
import { readSessionMetadata, SESSION_METADATA_VERSION } from './session-metadata.mjs';
import { TITLE_ENTRY } from '../../pi-runtime/features/session-title/session-title.mjs';
import { SYSTEM_PROMPT_REPLACEMENT_ENTRY } from '../../pi-runtime/features/session-prompt/patches.mjs';
import { SESSION_MESSAGE } from './session-link.mjs';
import { COMPANION_ENTRY } from '../../companion/companion.mjs';

const fingerprint = (stats) => [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode].join(':');
const newestFirst = (a, b) => b.modifiedAt - a.modifiedAt;
/**
 * A message another conversation sent (session link) as Pi's live `get_messages` carries
 * it: the custom message shape plus `entryId`. Rubato's clock (`wake`) and Pi's own custom
 * messages (a background terminal or subagent finishing) come too, hidden, as in Pi's live list,
 * so a reader of the stored conversation sees the same list as one of the live session.
 */
const receivedRow = (entry) => {
  if (entry.type !== 'custom_message') return undefined;
  const session = entry.customType === SESSION_MESSAGE;
  if (session && !(entry.display !== false || entry.details?.kind === 'wake')) return undefined;
  return { entryId: entry.id, role: 'custom', customType: entry.customType, content: entry.content,
    display: session ? entry.display !== false : false, details: entry.details, timestamp: new Date(entry.timestamp).getTime() };
};
// One cap across all cwd folders, rather than Pi's per-folder cap multiplied
// by the number of folders. Concurrent list/resolve calls share the same scan.
async function mapFiles(items, read) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(10, items.length) }, async () => {
    while (next < items.length) { const i = next++; result[i] = await read(items[i]); }
  }));
  return result;
}

/** A replacement prompt larger than this is refused rather than sent on every request. */
export const SYSTEM_PROMPT_LIMIT = 512 * 1024;
const shortText = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : undefined;

function replacementEntry(input) {
  const text = typeof input === 'object' ? input.text : undefined;
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('systemPrompt.text must be a non-empty string');
  if (text.length > SYSTEM_PROMPT_LIMIT) throw new TypeError(`systemPrompt.text exceeds ${SYSTEM_PROMPT_LIMIT} characters`);
  const label = shortText(input.label, 200);
  const source = shortText(input.source, 4096);
  return { value: text, ...(label ? { label } : {}), ...(source ? { source } : {}), createdAt: new Date().toISOString() };
}

const INDEX_FORMAT = 1;
// JSON has no NaN, Infinity or -0, and legacy sessions do produce NaN dates. A listing read
// back from the index must sort exactly like a fresh parse. The two date fields are always
// numbers in parsed metadata, so in the index a string there is one of those values spelled
// out. Every other field is copied as parsed; a header may hold any JSON at all.
const DATE_FIELDS = ['createdAt', 'modifiedAt'];
const SPECIAL_NUMBERS = new Set(['NaN', 'Infinity', '-Infinity', '-0']);
const encodeDates = (metadata) => {
  if (!metadata) return metadata;
  const copy = { ...metadata };
  for (const field of DATE_FIELDS) {
    const value = copy[field];
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) copy[field] = Object.is(value, -0) ? '-0' : String(value);
  }
  return copy;
};
// Undefined when a field holds anything that encodeDates could not have written.
const decodeDates = (metadata) => {
  if (!metadata) return metadata;
  const copy = { ...metadata };
  for (const field of DATE_FIELDS) {
    const value = copy[field];
    if (typeof value === 'string' && SPECIAL_NUMBERS.has(value)) copy[field] = Number(value);
    else if (typeof value !== 'number') return undefined;
  }
  return copy;
};

/** A view of existing Pi JSONL files, not a second conversation database.
 *
 * Reading every file's metadata means parsing every line of every session (2.1 GB on the
 * maintainer's machine, six seconds), and an engine restart used to pay that before its
 * socket opened. With `indexPath` the per-file results are saved and the next process starts
 * from them. A saved entry is used only while its file keeps the exact fingerprint it was
 * parsed at — the same rule the in-memory cache follows — so the index can be old but never
 * wrong: a changed, new or missing file is parsed or dropped as if there were no index. An
 * index that is absent, unreadable or from another reader version is ignored.
 */
export class SessionFiles {
  #cache = new Map();
  #touched = new Map();
  #refreshing;
  #index;
  #indexLoad;
  #dirty = false;
  #savedOnce = false;
  #saveTimer;
  #saving = Promise.resolve();
  #closed = false;
  constructor(root, { indexPath, saveIntervalMs = 30000, onError = () => {} } = {}) {
    if (!path.isAbsolute(root)) throw new TypeError('sessionsDir must be absolute');
    if (indexPath !== undefined && !path.isAbsolute(indexPath)) throw new TypeError('indexPath must be absolute');
    this.root = path.resolve(root);
    this.#index = indexPath ? { path: indexPath, saveIntervalMs, onError } : undefined;
  }
  #remember(file, entry) { this.#cache.set(file, entry); this.#dirty = true; }
  #forget(file) { if (this.#cache.delete(file)) this.#dirty = true; }
  async #loadIndex(canonicalRoot) {
    if (!this.#index) return;
    let saved;
    try { saved = JSON.parse(await readFile(this.#index.path, 'utf8')); }
    catch { return; } // Missing or corrupt: this scan parses everything, as without an index.
    if (saved?.format !== INDEX_FORMAT || saved.metadataVersion !== SESSION_METADATA_VERSION ||
        saved.root !== canonicalRoot || !Array.isArray(saved.entries)) return;
    const entries = [];
    for (const entry of saved.entries) {
      const [file, key, stored] = Array.isArray(entry) ? entry : [];
      const shaped = Array.isArray(entry) && entry.length === 3 && typeof file === 'string' && file.startsWith(canonicalRoot + path.sep) &&
        typeof key === 'string' && (stored === null || (typeof stored === 'object' && !Array.isArray(stored) && stored.file === file));
      const metadata = shaped ? decodeDates(stored) : undefined;
      if (metadata === undefined) return; // One malformed entry means the file is not what we wrote; trust none of it.
      entries.push([file, key, metadata]);
    }
    for (const [file, key, metadata] of entries) if (!this.#cache.has(file)) this.#cache.set(file, { key, metadata });
  }
  // The first save follows the first scan, so a crash soon after start still leaves an index.
  // Later changes (a live conversation appends every turn) are saved at most once per interval;
  // whatever the last save missed is only parsed again, never misreported.
  #scheduleSave() {
    if (!this.#index || !this.#dirty || this.#saveTimer || this.#closed) return;
    if (!this.#savedOnce) { void this.#save(); return; }
    this.#saveTimer = setTimeout(() => { this.#saveTimer = undefined; void this.#save(); }, this.#index.saveIntervalMs);
    this.#saveTimer.unref?.();
  }
  #save() {
    this.#saving = this.#saving.then(async () => {
      if (!this.#index || !this.#dirty) return;
      this.#dirty = false;
      this.#savedOnce = true;
      const temporary = `${this.#index.path}.${randomUUID()}.tmp`;
      try {
        const body = JSON.stringify({ format: INDEX_FORMAT, metadataVersion: SESSION_METADATA_VERSION, root: await realpath(this.root),
          entries: [...this.#cache].map(([file, { key, metadata }]) => [file, key, encodeDates(metadata)]) });
        await mkdir(path.dirname(this.#index.path), { recursive: true, mode: 0o700 });
        // Written beside the index and renamed over it: a reader sees the old index or the new one.
        await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.#index.path);
      } catch (error) {
        this.#dirty = true;
        await rm(temporary, { force: true }).catch(() => {});
        try { this.#index.onError(error); } catch { /* reporting must not break listing */ }
      }
    });
    return this.#saving;
  }
  /** Writes the index now if anything changed since the last save. */
  flush() {
    clearTimeout(this.#saveTimer); this.#saveTimer = undefined;
    return this.#save();
  }
  /** Saves the index one last time; later scans no longer schedule saves. */
  async close() {
    this.#closed = true;
    await this.flush();
  }
  async list() {
    const records = await (this.#refreshing ??= this.#scan().finally(() => { this.#refreshing = undefined; }));
    // Callers must not mutate cached metadata or a concurrent caller's result.
    return records.map((record) => ({ ...record }));
  }
  /**
   * When the file was last written, as the latest scan saw it (epoch ms). Pi's listing has
   * no such field, so it stays beside the metadata: a warmer's cache refresh writes the file
   * without adding a message, which `modifiedAt` does not count.
   */
  touchedAt(file) { return this.#touched.get(file); }
  async #read(file, canonicalRoot, seen) {
    try {
      file = await realpath(file);
      if (!file.startsWith(canonicalRoot + path.sep)) return null;
      const before = await stat(file, { bigint: true });
      if (!before.isFile()) return null;
      seen?.add(file);
      this.#touched.set(file, Number(before.mtimeMs));
      const key = fingerprint(before);
      const cached = this.#cache.get(file);
      if (cached?.key === key) return cached.metadata;
      const metadata = await readSessionMetadata(file, before);
      const after = await stat(file, { bigint: true });
      // Bound the read at its starting size. An append/replace during parsing
      // must never validate a cache entry for bytes we did not actually parse.
      const unchangedPath = await realpath(file) === file;
      if (key === fingerprint(after) && unchangedPath) this.#remember(file, { key, metadata });
      else this.#forget(file);
      if (before.dev !== after.dev || before.ino !== after.ino || !unchangedPath) return null;
      return metadata;
    } catch {
      this.#forget(file);
      return null; // Same per-file error isolation as Pi discovery; retry next scan.
    }
  }
  async #scan() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const folders = [this.root, ...entries
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(this.root, entry.name))];
    const canonicalRoot = await realpath(this.root);
    await (this.#indexLoad ??= this.#loadIndex(canonicalRoot));
    const groups = await mapFiles(folders, async (dir) => {
      try { return (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
        // Pi 1.0 lists each folder newest-name-first before its stable date sort, which decides ties.
        .sort((x, y) => y.localeCompare(x)).map((name) => path.join(dir, name)); }
      catch { return []; }
    });
    const present = new Set();
    const loaded = await mapFiles(groups.flat(), (file) => this.#read(file, canonicalRoot, present));
    // Preserve Pi's per-folder sort followed by the aggregate sort, including
    // legacy invalid dates (NaN comparisons) and ties; do not reorder history.
    let offset = 0;
    const result = groups.flatMap((group) => {
      const items = loaded.slice(offset, offset += group.length);
      return items.filter(Boolean).sort(newestFirst);
    });
    // Discard deleted entries and failed discovery; no cache of full history.
    for (const file of [...this.#cache.keys()]) if (!present.has(file)) this.#forget(file);
    for (const file of [...this.#touched.keys()]) if (!present.has(file)) this.#touched.delete(file);
    this.#scheduleSave();
    return result.sort(newestFirst);
  }
  async resolve(id) {
    if (typeof id !== 'string' || !id) throw new SessionNotFoundError();
    const matches = (await this.list()).filter((session) => session.id === id);
    if (!matches.length) throw new SessionNotFoundError();
    if (matches.length !== 1) throw new SessionAmbiguousError();
    return matches[0];
  }
  async transcript(id) {
    const metadata = await this.resolve(id);
    // Read-only: opening a SessionManager can migrate old files. Never rewrite
    // a transcript simply because a presentation client wants to display it.
    const { parseSessionEntries } = await import('@earendil-works/pi-coding-agent');
    const entries = parseSessionEntries(await readFile(metadata.file, 'utf8'))
      .filter((entry) => entry.type !== 'session');
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = [];
    const seen = new Set();
    let entry = entries.at(-1);
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id); branch.unshift(entry); entry = byId.get(entry.parentId);
    }
    const selected = branch.findLast((entry) => entry.type === 'model_change');
    return { sessionId: id, model: selected ? `${selected.provider}/${selected.modelId}` : null,
      messages: branch.flatMap((entry) => {
        if (entry.type === 'message') return [{ entryId: entry.id, ...entry.message }];
        const received = receivedRow(entry);
        return received ? [received] : [];
      }) };
  }
  /**
   * `titleLocked` marks the title as chosen, so the session-title feature never replaces it
   * (its lock entry, read at session start). Scheduled runs use it for their "⏰ name" titles.
   * `systemPrompt` (`{ text, label?, source? }`) opens the session on that text as its whole
   * system prompt (session-prompt's replacement entry); forks copy it with the history.
   * `companion` marks the conversation as the companion (harness/companion): the engine runs it
   * under the companion role.
   */
  async create({ cwd, title, titleLocked = false, systemPrompt, companion = false } = {}) {
    if (typeof companion !== 'boolean') throw new TypeError('companion must be a boolean');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd must be absolute');
    if (title !== undefined && (typeof title !== 'string' || title.length > 512)) throw new TypeError('Invalid title');
    const replacement = systemPrompt === undefined || systemPrompt === null ? undefined : replacementEntry(systemPrompt);
    cwd = await realpath(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new TypeError('cwd must be a directory');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Inventory-only servers do not need the agent/TUI/provider module graph.
    // Keep the public Pi writer API, and load it only for an actual write.
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.create(cwd, this.root);
    const file = manager.getSessionFile();
    // Pi deliberately delays initial writes until the first assistant message.
    // Persist its PUBLIC header, exclusively, so an empty created session can be
    // discovered after restart. No fake conversation entry or private SDK call.
    await writeFile(file, JSON.stringify(manager.getHeader()) + '\n', { flag: 'wx', mode: 0o600 });
    if (title || replacement || companion) {
      const opened = SessionManager.open(file, this.root);
      if (companion) opened.appendCustomEntry(COMPANION_ENTRY, { since: new Date().toISOString() });
      if (replacement) opened.appendCustomEntry(SYSTEM_PROMPT_REPLACEMENT_ENTRY, replacement);
      if (title) opened.appendSessionInfo(title);
      if (title && titleLocked === true) opened.appendCustomEntry(TITLE_ENTRY, { locked: true });
    }
    const metadata = await this.#read(file, await realpath(this.root));
    if (!metadata) throw new SessionNotFoundError();
    return { ...metadata };
  }
}
