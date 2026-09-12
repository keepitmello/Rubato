import { mkdir, readdir, realpath, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionManager, parseSessionEntries } from '@earendil-works/pi-coding-agent';
import { SessionNotFoundError, SessionAmbiguousError } from '@earendil-works/pi-server';

/** A view of existing Pi JSONL files, not a second conversation database. */
export class SessionFiles {
  constructor(root) {
    if (!path.isAbsolute(root)) throw new TypeError('sessionsDir must be absolute');
    this.root = path.resolve(root);
  }
  async list() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Pi supports a flat explicit sessions directory and its default cwd folders.
    // Listing each with the public SDK does not create/hydrate any agent runtime.
    const folders = [this.root, ...(await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(this.root, entry.name))];
    const sessions = (await Promise.all(folders.map((dir) => SessionManager.listAll(dir)))).flat();
    const canonicalRoot = await realpath(this.root);
    const result = [];
    for (const item of sessions) {
      const file = await realpath(item.path).catch(() => null);
      if (!file || !file.startsWith(canonicalRoot + path.sep)) continue;
      result.push({ id: item.id, file, cwd: item.cwd, title: item.name || item.firstMessage || 'New session',
        createdAt: item.created.getTime(), modifiedAt: item.modified.getTime(), messageCount: item.messageCount });
    }
    return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
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
    const entries = parseSessionEntries(await readFile(metadata.file, 'utf8'))
      .filter((entry) => entry.type !== 'session');
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = [];
    const seen = new Set();
    let entry = entries.at(-1);
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id); branch.unshift(entry); entry = byId.get(entry.parentId);
    }
    return { sessionId: id, messages: branch.filter((entry) => entry.type === 'message')
      .map((entry) => ({ entryId: entry.id, ...entry.message })) };
  }
  async create({ cwd, title } = {}) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('cwd must be absolute');
    if (title !== undefined && (typeof title !== 'string' || title.length > 512)) throw new TypeError('Invalid title');
    cwd = await realpath(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new TypeError('cwd must be a directory');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(cwd, this.root);
    const file = manager.getSessionFile();
    // Pi deliberately delays initial writes until the first assistant message.
    // Persist its PUBLIC header, exclusively, so an empty created session can be
    // discovered after restart. No fake conversation entry or private SDK call.
    await writeFile(file, JSON.stringify(manager.getHeader()) + '\n', { flag: 'wx', mode: 0o600 });
    if (title) SessionManager.open(file, this.root).appendSessionInfo(title);
    return this.resolve(manager.getSessionId());
  }
}
