import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * What the app should do with the thread that shows a conversation: the app's own Archive, Delete
 * or rename. The engine never reaches the app; the app's inventory pass (T3 bridge.mjs
 * applyThreadRequests) takes these from the engine, applies them to its threads and settles them.
 */
export const THREAD_ACTIONS = Object.freeze(['archive', 'delete', 'rename']);

const valid = (item) => item && typeof item.id === 'string' && typeof item.sessionId === 'string'
  && THREAD_ACTIONS.includes(item.action) && (item.action !== 'rename' || typeof item.title === 'string');

/**
 * Requests wait until the app settles them, across engine restarts when `file` is given: an app that
 * is closed applies them when it next runs. A newer request of the same action for the same
 * conversation replaces the older one.
 */
export function createThreadRequests({ file, now = Date.now, onError = () => {} } = {}) {
  let items = [];
  const loaded = !file ? Promise.resolve() : readFile(file, 'utf8')
    .then((text) => { const parsed = JSON.parse(text); if (Array.isArray(parsed)) items = parsed.filter(valid); })
    .catch((error) => { if (error?.code !== 'ENOENT') onError(error); });
  let writing = Promise.resolve();
  const save = () => {
    if (!file) return writing;
    const text = JSON.stringify(items);
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, text);
      await rename(temporary, file);
    }).catch(onError);
    return writing;
  };
  return {
    async add({ sessionId, action, title }) {
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('A thread request needs a session id');
      if (!THREAD_ACTIONS.includes(action)) throw new TypeError(`A thread request is one of ${THREAD_ACTIONS.join(', ')}`);
      if (action === 'rename' && (typeof title !== 'string' || !title.trim())) throw new TypeError('A rename needs a title');
      await loaded;
      const request = { id: randomUUID(), sessionId, action, ...(action === 'rename' ? { title: title.trim() } : {}), at: now() };
      items = [...items.filter((item) => !(item.sessionId === sessionId && item.action === action)), request];
      await save();
      return { ...request };
    },
    async pending() {
      await loaded;
      return items.map((item) => ({ ...item }));
    },
    async settle(ids) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new TypeError('settle takes a list of request ids');
      await loaded;
      const before = items.length;
      items = items.filter((item) => !ids.includes(item.id));
      if (items.length !== before) await save();
      return before - items.length;
    },
  };
}
