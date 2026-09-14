import { mkdir, readdir, realpath, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionNotFoundError, SessionAmbiguousError } from '@earendil-works/pi-server';
import { readSessionMetadata } from './session-metadata.mjs';

const fingerprint = (stats) => [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.mode].join(':');
const newestFirst = (a, b) => b.modifiedAt - a.modifiedAt;
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

/** A view of existing Pi JSONL files, not a second conversation database. */
export class SessionFiles {
  #cache = new Map();
  #refreshing;
  constructor(root) {
    if (!path.isAbsolute(root)) throw new TypeError('sessionsDir must be absolute');
    this.root = path.resolve(root);
  }
  async list() {
    const records = await (this.#refreshing ??= this.#scan().finally(() => { this.#refreshing = undefined; }));
    // Callers must not mutate cached metadata or a concurrent caller's result.
    return records.map((record) => ({ ...record }));
  }
  async #read(file, canonicalRoot, seen) {
    try {
      file = await realpath(file);
      if (!file.startsWith(canonicalRoot + path.sep)) return null;
      const before = await stat(file, { bigint: true });
      if (!before.isFile()) return null;
      seen?.add(file);
      const key = fingerprint(before);
      const cached = this.#cache.get(file);
      if (cached?.key === key) return cached.metadata;
      const metadata = await readSessionMetadata(file, before);
      const after = await stat(file, { bigint: true });
      // Bound the read at its starting size. An append/replace during parsing
      // must never validate a cache entry for bytes we did not actually parse.
      const unchangedPath = await realpath(file) === file;
      if (key === fingerprint(after) && unchangedPath) this.#cache.set(file, { key, metadata });
      else this.#cache.delete(file);
      if (before.dev !== after.dev || before.ino !== after.ino || !unchangedPath) return null;
      return metadata;
    } catch {
      this.#cache.delete(file);
      return null; // Same per-file error isolation as Pi discovery; retry next scan.
    }
  }
  async #scan() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const folders = [this.root, ...entries
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(this.root, entry.name))];
    const canonicalRoot = await realpath(this.root);
    const groups = await mapFiles(folders, async (dir) => {
      try { return (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)); }
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
    for (const file of this.#cache.keys()) if (!present.has(file)) this.#cache.delete(file);
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
      messages: branch.filter((entry) => entry.type === 'message')
        .map((entry) => ({ entryId: entry.id, ...entry.message })) };
  }
  async create({ cwd, title } = {}) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd must be absolute');
    if (title !== undefined && (typeof title !== 'string' || title.length > 512)) throw new TypeError('Invalid title');
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
    if (title) SessionManager.open(file, this.root).appendSessionInfo(title);
    const metadata = await this.#read(file, await realpath(this.root));
    if (!metadata) throw new SessionNotFoundError();
    return { ...metadata };
  }
}
