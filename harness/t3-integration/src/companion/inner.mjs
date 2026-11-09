// What a companion did between the bubbles of its room (user item f8828a9f): its thinking, the
// words it wrote to itself, its tool calls, and what woke it. The room stays a chat log of the
// person's messages and what the companion sent with reply or say (intent companion-segno rev 11);
// this is read only when the room asks, from the conversation's own session file, so the thread
// gains nothing and the phone hears nothing more. Older history gets its folds too.
//
// The file is a tree: a rewind appends a branch, and the entries it left stay in the file. Only
// the branch that ends at the file's last entry counts. The file only grows, so each read parses
// what was appended since the last one.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const LIMITS = { text: 6_000, thinking: 6_000, input: 600, output: 1_500, summary: 160 };

const bounded = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
const oneLine = (text, limit = LIMITS.summary) => bounded(String(text ?? '').replace(/\s+/g, ' ').trim(), limit);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
}

/** The one line a tool row shows: the argument that says what the call was about. */
export function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'path', 'file_path', 'query', 'pattern', 'url', 'text', 'description', 'prompt', 'name'])
    if (typeof args[key] === 'string' && args[key].trim()) return oneLine(args[key]);
  const first = Object.values(args).find((value) => typeof value === 'string' && value.trim());
  return first ? oneLine(first) : '';
}

function inputOf(args) {
  if (args === undefined || args === null) return '';
  try { return typeof args === 'string' ? args : JSON.stringify(args, null, 2); } catch { return String(args); }
}

const atOf = (value) => {
  const at = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(at) ? at : undefined;
};

/**
 * A call that started or forked another conversation (session-link tools.mjs): the room draws it
 * as a work card (chat/RubatoWorkCard.tsx). Its result names the new conversation: the text opens
 * with `Created "<title>" (<id>)` or `Forked into "<title>" (<id>)` and ends with the engine's JSON.
 */
export const LAUNCH_TOOLS = { session_create: 'create', session_fork: 'fork' };
export function launchResult(text) {
  const body = String(text ?? '');
  const json = body.indexOf('\n{');
  if (json >= 0) {
    try {
      const parsed = JSON.parse(body.slice(json + 1));
      if (typeof parsed?.sessionId === 'string' && parsed.sessionId)
        return { sessionId: parsed.sessionId, title: typeof parsed.title === 'string' ? parsed.title : null,
          model: typeof parsed.model === 'string' ? parsed.model : null };
    } catch { /* cut short: the line below still names it */ }
  }
  const head = /^(?:Created|Forked into) "([^]*?)" \(([^()\s]+)\)/.exec(body);
  return head ? { sessionId: head[2], title: head[1], model: null } : null;
}

/** A segno_commit result (companion-home index.mjs): `Committed <sha>: <files>`, or nothing changed. */
export function commitResult(text) {
  const match = /^Committed ([0-9a-f]{4,64})\b/.exec(String(text ?? ''));
  return match ? match[1] : null;
}

/**
 * The items one session entry contributes, oldest first. The person's own messages are bubbles, so
 * they contribute none. A tool result lands on its call (`calls`, by call id).
 */
export function entryItems(entry, calls) {
  if (entry?.type === 'compaction') {
    const at = atOf(entry.timestamp);
    return at === undefined ? [] : [{ kind: 'compaction', at }];
  }
  if (entry?.type === 'custom_message' && entry.customType === 'rubato-session-message') {
    const at = atOf(entry.timestamp);
    const details = entry.details ?? {};
    if (at === undefined || details.kind === 'channel') return [];
    if (details.kind === 'wake') return [{ kind: 'wake', what: String(details.what ?? 'wake'), text: bounded(String(details.text ?? ''), LIMITS.text), at }];
    return [{ kind: 'message', from: String(details.from?.title ?? ''), text: bounded(String(details.text ?? textOf(entry.content)), LIMITS.text), at }];
  }
  if (entry?.type !== 'message' || !entry.message) return [];
  const message = entry.message;
  const at = atOf(message.timestamp) ?? atOf(entry.timestamp);
  if (at === undefined) return [];
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    const items = [];
    for (const part of message.content) {
      if (part?.type === 'thinking' && part.thinking?.trim()) items.push({ kind: 'thinking', text: bounded(part.thinking.trim(), LIMITS.thinking), at });
      else if (part?.type === 'text' && part.text?.trim()) items.push({ kind: 'text', text: bounded(part.text.trim(), LIMITS.text), at });
      else if (part?.type === 'toolCall') {
        const tool = { kind: 'tool', id: String(part.id ?? ''), name: String(part.name ?? 'tool'),
          summary: toolSummary(part.name, part.arguments), input: bounded(inputOf(part.arguments), LIMITS.input), at };
        const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : {};
        if (LAUNCH_TOOLS[tool.name]) Object.defineProperty(tool, 'launch', { enumerable: false, writable: true,
          value: { tool: LAUNCH_TOOLS[tool.name], title: typeof args.title === 'string' ? args.title : null,
            model: typeof args.model === 'string' ? args.model : null, sessionId: null } });
        if (tool.name === 'segno_commit') Object.defineProperty(tool, 'commit', { enumerable: false, writable: true,
          value: { message: typeof args.message === 'string' ? oneLine(args.message, 400) : '',
            files: Array.isArray(args.paths) ? args.paths.filter((file) => typeof file === 'string') : [], sha: null } });
        items.push(tool);
        if (tool.id) calls.set(tool.id, tool);
      }
    }
    if (message.stopReason === 'error' && message.errorMessage) items.push({ kind: 'error', text: bounded(String(message.errorMessage), LIMITS.output), at });
    return items;
  }
  if (message.role === 'toolResult') {
    const tool = calls.get(String(message.toolCallId ?? ''));
    if (tool) {
      const full = textOf(message.content);
      if (tool.launch && !message.isError) Object.assign(tool.launch, launchResult(full) ?? {});
      if (tool.commit && !message.isError) tool.commit.sha = commitResult(full);
      tool.output = bounded(full, LIMITS.output);
      if (message.isError) tool.isError = true;
      tool.done = at;
    }
  }
  return [];
}

/**
 * One session file, read as it grows. `items()` answers the items on the live branch, oldest first.
 */
export function createSessionReader(file) {
  const entries = new Map(); // id -> { parentId, items }
  const calls = new Map();
  let offset = 0;
  // The bytes after the last newline: a line still being written, possibly cut inside a character.
  let rest = Buffer.alloc(0);
  let lastId = null;
  let size = -1;
  async function refresh() {
    const info = await stat(file);
    if (info.size === size) return;
    // A file that shrank was replaced: read it again from the start.
    if (info.size < offset) { entries.clear(); calls.clear(); offset = 0; rest = Buffer.alloc(0); lastId = null; }
    const handle = await open(file, 'r');
    try {
      const length = info.size - offset;
      const buffer = Buffer.alloc(length);
      for (let read = 0; read < length;) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      offset = info.size;
      size = info.size;
      const bytes = Buffer.concat([rest, buffer]);
      const end = bytes.lastIndexOf(0x0a);
      rest = end < 0 ? bytes : bytes.subarray(end + 1);
      const lines = end < 0 ? [] : bytes.subarray(0, end).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (typeof entry?.id !== 'string') continue;
        entries.set(entry.id, { parentId: entry.parentId ?? null, items: entryItems(entry, calls) });
        lastId = entry.id;
      }
    } finally { await handle.close(); }
  }
  return {
    async items() {
      await refresh();
      const branch = [];
      const seen = new Set();
      for (let id = lastId; id !== null && entries.has(id) && !seen.has(id); id = entries.get(id).parentId) {
        seen.add(id);
        branch.push(entries.get(id));
      }
      return branch.reverse().flatMap((entry) => entry.items);
    },
  };
}

/** Where the engine keeps session files (pi-server profile-server.mjs: <agent dir>/sessions). */
export function sessionsDir(env = process.env) {
  const agentDir = env.RUBATO_PI_CODING_AGENT_DIR || path.join(env.HOME || homedir(), '.rubato-pi', 'agent');
  return path.join(agentDir, 'sessions');
}

/** The file of session `sessionId`: `<created>_<id>.jsonl` in the sessions folder. */
export async function sessionFile(sessionId, env = process.env) {
  const dir = sessionsDir(env);
  const name = (await readdir(dir)).find((entry) => entry.endsWith(`_${sessionId}.jsonl`));
  return name ? path.join(dir, name) : undefined;
}

/**
 * What a span holds, for its folded line: counts and when it ran. `wakeKinds` counts what woke the
 * companion by its kind (keeper.mjs notify `what`), in the order the kinds first came, so the line
 * names each one — a heartbeat, the work room, a voice call — instead of one word for all.
 */
export function spanSummary(items) {
  const summary = { thinking: 0, text: 0, tools: 0, wakes: 0, wakeKinds: {}, messages: 0, from: null, to: null, launches: [], commits: [] };
  for (const item of items) {
    if (item.kind === 'thinking') summary.thinking += 1;
    else if (item.kind === 'text') summary.text += 1;
    else if (item.kind === 'tool') {
      summary.tools += 1;
      // The conversations it started (a card each) and the records it committed (one grey line each).
      if (item.launch) summary.launches.push({ id: item.id, ...item.launch, at: item.at, done: item.done ?? null,
        error: item.isError ? oneLine(item.output ?? '', 300) : null });
      if (item.commit?.sha) summary.commits.push({ id: item.id, message: item.commit.message, files: item.commit.files,
        sha: item.commit.sha, at: item.done ?? item.at });
    }
    else if (item.kind === 'wake') {
      summary.wakes += 1;
      summary.wakeKinds[item.what] = (summary.wakeKinds[item.what] ?? 0) + 1;
    }
    else if (item.kind === 'message') summary.messages += 1;
    summary.from = summary.from === null ? item.at : Math.min(summary.from, item.at);
    summary.to = Math.max(summary.to ?? item.at, item.done ?? item.at);
  }
  return summary;
}

/**
 * Splits `items` by the room's bubble times: span i holds what happened after `boundaries[i - 1]`
 * up to and including `boundaries[i]` (a reply's own call lands before its bubble); the last span,
 * after the last bubble, is what goes on now or went on since. Span 0 starts at `after`.
 */
export function splitSpans(items, boundaries, after = -Infinity) {
  const edges = [after, ...boundaries];
  const spans = edges.map(() => []);
  for (const item of items) {
    if (!(item.at > after)) continue;
    let index = boundaries.findIndex((boundary) => item.at <= boundary);
    if (index < 0) index = boundaries.length;
    spans[index].push(item);
  }
  return spans;
}

/** One reader per file, so a room that asks every few seconds parses only what was appended. */
export function createInnerReader({ env = process.env } = {}) {
  const readers = new Map();
  async function itemsOf(sessionId) {
    const file = await sessionFile(sessionId, env);
    if (!file) return [];
    if (!readers.has(file)) readers.set(file, createSessionReader(file));
    return readers.get(file).items();
  }
  return {
    /** The summary of each span between the given bubble times (see splitSpans). */
    async summaries(sessionId, boundaries, after) {
      return splitSpans(await itemsOf(sessionId), boundaries, after).map(spanSummary);
    },
    /** The items of one span: after `after`, up to and including `until` (null: up to now). */
    async span(sessionId, after, until) {
      return (await itemsOf(sessionId)).filter((item) => item.at > after && (until === null || item.at <= until));
    },
  };
}
