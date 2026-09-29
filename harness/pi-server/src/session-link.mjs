import { open, readFile, stat, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionClient } from './client.mjs';
import { readSessionMetadata } from './session-metadata.mjs';
import { UI_METHODS } from './contracts.mjs';

/** Answered by the session-link extension inside the target runtime. */
export const DELIVER_REQUEST = 'rubato.session-link.deliver';
export const SESSION_MESSAGE = 'rubato-session-message';
export const LIMITS = Object.freeze({ textChars: 8000, pairPerMinute: 8, senderPerMinute: 20, duplicateMs: 30000,
  // Receiver side, across all senders.
  inboundPerMinute: 20, inboundCharsPerMinute: 60000,
  windowMs: 60000, listDefault: 20, listMax: 50, readDefault: 12, readMax: 40, charsDefault: 1200, charsMax: 20000,
  waitTargets: 8, waitMaxMs: 120000 });
const METHODS = ['list', 'read', 'wait', 'send', 'create', 'fork'];
// A transcript is append-only (a branch appends too), so its newest lines are the
// live branch. Bounded tails keep one screenshot-heavy session from costing a full read.
// The last size is the ceiling: an entry larger than it is never parsed from a tail.
export const TAIL_BYTES = Object.freeze([256 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]);
const BUSY = new Set(['running', 'starting', 'waiting']);
const POLL_MS = 250;

const fail = (code, message) => Object.assign(new Error(message), { code });
const clamp = (value, fallback, min, max, name) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail('invalid', `${name} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(value)));
};
const requireId = (value, name) => {
  if (typeof value !== 'string' || !value) throw fail('invalid', `${name} must be a session id`);
  return value;
};
const requireText = (text) => {
  if (typeof text !== 'string' || !text.trim()) throw fail('invalid', 'text must be a non-empty string');
  if (text.length > LIMITS.textChars) throw fail('too_long', `text is ${text.length} characters; the limit is ${LIMITS.textChars}`);
  return text;
};
const clip = (text, max) => text.length > max ? text.slice(0, max) + '…' : text;
const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';
const timeOf = (entry) => typeof entry.message?.timestamp === 'number' ? entry.message.timestamp
  : Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : null;
const isAssistant = (entry) => entry?.type === 'message' && entry.message?.role === 'assistant';
/** A turn has ended at an assistant message that does not hand over to tools. */
const isFinal = (entry) => isAssistant(entry) && entry.message.stopReason !== 'toolUse';
const isSessionMessage = (entry) => entry?.type === 'custom_message' && entry.customType === SESSION_MESSAGE;

/** Newest `bytes` of a JSONL file, whole lines only. Read-only: never a SessionManager. */
async function readTail(file, bytes) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return { entries: [], whole: true }; throw error; }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line); if (entry && typeof entry === 'object') entries.push(entry); } catch {}
    }
    return { entries, whole: start === 0 };
  } finally { await handle.close(); }
}

/** The live branch: from the last entry back through parentId, oldest first. */
function branchOf(entries) {
  const body = entries.filter((entry) => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map(body.map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  let entry = body.at(-1);
  while (entry && !seen.has(entry.id)) { seen.add(entry.id); branch.unshift(entry); entry = byId.get(entry.parentId); }
  return { branch, rooted: !branch.length || !branch[0].parentId };
}

/**
 * Grows the tail until the branch holds what the caller needs or reaches the root. A tail
 * with no complete line (one entry larger than the read) says nothing about the history,
 * so it grows too; `unreadable` means even the ceiling held no whole entry.
 */
async function readBranch(file, enough) {
  let result;
  for (const bytes of TAIL_BYTES) {
    const tail = await readTail(file, bytes);
    result = branchOf(tail.entries);
    result.rooted = tail.whole || (result.branch.length > 0 && !result.branch[0].parentId);
    result.unreadable = !tail.whole && !result.branch.length;
    if (result.rooted || (result.branch.length && enough(result.branch))) return result;
  }
  return result;
}

function summarize(entry, maxChars) {
  const at = timeOf(entry);
  if (isSessionMessage(entry)) {
    const text = typeof entry.details?.text === 'string' ? entry.details.text : textOf(entry.content);
    return { entryId: entry.id, role: 'session-message', text: clip(text, maxChars), at, toolCalls: [], isFinal: false };
  }
  if (entry.type !== 'message') return;
  const { role, content } = entry.message ?? {};
  if (role === 'user') return { entryId: entry.id, role, text: clip(textOf(content), maxChars), at, toolCalls: [], isFinal: false };
  if (role !== 'assistant') return;
  const toolCalls = Array.isArray(content) ? content.filter((part) => part?.type === 'toolCall').map((part) => part.name) : [];
  const text = textOf(content);
  if (!text && !toolCalls.length) return;
  return { entryId: entry.id, role, text: clip(text, maxChars), at, toolCalls, isFinal: isFinal(entry) };
}

/** What a waiter compares: the newest completed answer, and whether the user is needed. */
function progressOf(branch) {
  const final = branch.findLast(isFinal);
  const latest = branch.findLast((entry) => isAssistant(entry) && textOf(entry.message.content));
  const tool = branch.findLast((entry) => isAssistant(entry) && entry.message.content?.some?.((part) => part?.type === 'toolCall'));
  const toolName = tool?.message.content.findLast((part) => part?.type === 'toolCall')?.name;
  return {
    final: final ? { entryId: final.id, text: clip(textOf(final.message.content), LIMITS.charsDefault) } : undefined,
    latestAssistant: latest ? { entryId: latest.id, text: clip(textOf(latest.message.content), LIMITS.charsDefault) } : undefined,
    latestTool: tool ? { entryId: tool.id, name: toolName } : undefined,
  };
}

const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value?.v === 1) return value;
  } catch {}
  throw fail('invalid', 'afterCursor is not a cursor returned by session wait');
}

/**
 * Everything up to the last completed assistant answer, plus the bookkeeping that
 * follows it (title, labels, model changes, compaction) until the next message: the
 * message that starts a turn and everything the unfinished turn produced stay behind.
 */
export function completedHistory(branch) {
  let end = branch.findLastIndex(isFinal) + 1;
  while (end < branch.length && branch[end].type !== 'message' && branch[end].type !== 'custom_message') end++;
  let parentId = null;
  return branch.slice(0, end).map((entry) => { const copy = { ...entry, parentId }; parentId = entry.id; return copy; });
}

/**
 * One engine-wide link between the conversations of this profile. The holder exists
 * before the host does (extension factories receive it at runtime creation) and is
 * bound once the server listens; until then every method refuses.
 */
export function createSessionLink({ now = Date.now, pollMs = POLL_MS } = {}) {
  let bound;
  const files = new Map();
  const recent = [];
  const waiters = new Set();
  const need = () => {
    if (!bound) throw fail('unavailable', 'session link is not available in this process');
    return bound;
  };
  const rows = () => need().host.directory.value.sessions ?? [];
  const row = (id) => rows().find((item) => item.sessionId === id);
  async function locate(id) {
    const { host } = need();
    const live = host.getSessionWorker(id)?.metadata?.file;
    if (live) return live;
    const cached = files.get(id);
    if (cached) {
      try { await stat(cached); return cached; } catch { files.delete(id); }
    }
    let metadata;
    try { metadata = await host.resolveSession(id); }
    catch { throw fail('unknown_session', `No conversation with id ${id}`); }
    files.set(id, metadata.file);
    return metadata.file;
  }
  async function describe(id) {
    const item = row(id);
    if (item) return { sessionId: id, title: item.title, cwd: item.cwd, status: item.status,
      updatedAt: item.modifiedAt ?? null, messageCount: item.messageCount ?? 0, live: item.runtimeId !== null };
    let metadata;
    try { metadata = await need().host.resolveSession(id); }
    catch { throw fail('unknown_session', `No conversation with id ${id}`); }
    files.set(id, metadata.file);
    const live = Boolean(need().host.getSessionWorker(id));
    return { sessionId: id, title: metadata.title ?? '', cwd: metadata.cwd ?? '', status: live ? 'idle' : 'stored',
      updatedAt: metadata.modifiedAt ?? null, messageCount: metadata.messageCount ?? 0, live };
  }
  /** The sender's own name and folder; callers pass ids only. */
  async function sender(id) {
    const known = row(id);
    if (known) return { sessionId: id, title: known.title, cwd: known.cwd };
    const worker = need().host.getSessionWorker(id);
    // A new CLI conversation has no file until its first answer, but it is live.
    if (worker) {
      const title = worker.runtime?.session?.sessionManager?.getSessionName?.() ?? '';
      return { sessionId: id, title: title || id, cwd: worker.metadata?.cwd ?? '' };
    }
    const described = await describe(id).catch(() => undefined);
    if (!described) throw fail('unknown_session', `The sending conversation ${id} is not known to this engine`);
    return { sessionId: id, title: described.title, cwd: described.cwd };
  }
  /** Refuses floods and repeats before anything is delivered; returns a release for failed delivery. */
  function admit(from, to, text, { retry = false, inbound = true } = {}) {
    const at = now();
    while (recent.length && at - recent[0].at >= LIMITS.windowMs) recent.shift();
    // An explicit messageId is a retry the receiver judges by id (in its transcript or
    // still queued), so only an unnamed repeat is refused here by its text.
    if (!retry && recent.some((item) => item.from === from && item.to === to && item.text === text && at - item.at < LIMITS.duplicateMs))
      throw fail('duplicate', 'The same message was just sent to this conversation; wait for its answer instead of resending');
    if (recent.filter((item) => item.from === from && item.to === to).length >= LIMITS.pairPerMinute)
      throw fail('rate_limited', `At most ${LIMITS.pairPerMinute} messages per minute to one conversation`);
    if (recent.filter((item) => item.from === from && !item.alias).length >= LIMITS.senderPerMinute)
      throw fail('rate_limited', `At most ${LIMITS.senderPerMinute} messages per minute from one conversation`);
    if (inbound) {
      const received = recent.filter((item) => item.to === to);
      if (received.length >= LIMITS.inboundPerMinute)
        throw fail('rate_limited', `This conversation already received ${LIMITS.inboundPerMinute} messages in the last minute; try again later`);
      if (received.reduce((sum, item) => sum + item.text.length, 0) + text.length > LIMITS.inboundCharsPerMinute)
        throw fail('rate_limited', `This conversation already received close to ${LIMITS.inboundCharsPerMinute} characters in the last minute; try again later`);
    }
    const record = { from, to, text, at };
    recent.push(record);
    return () => { const index = recent.indexOf(record); if (index >= 0) recent.splice(index, 1); };
  }
  /**
   * A created conversation's first message was admitted under its folder, before the
   * conversation had an id. Once it has one, the same message also counts as received
   * there (pair and inbound caps), without counting twice against its sender.
   */
  function received(from, to, text) {
    recent.push({ from, to, text, at: now(), alias: true });
  }
  async function withClient(work) {
    const { socketPath, serverId, onError } = need();
    const client = new SessionClient({ socketPath, serverId, onError });
    try { await client.connect(); return await work(client); }
    finally { await client.close().catch(() => {}); }
  }
  /**
   * Attach exactly like a GUI does, so the official router loads (or reuses) the one
   * runtime for this session file, then hand the message to that runtime's extension.
   * The attachment also keeps the runtime from idling out during the call.
   * Resolves to the handler's answer.
   */
  async function deliver(to, data) {
    return withClient(async (client) => {
      try { await client.attach(to); }
      catch (error) { throw fail(/not found/i.test(error?.message) ? 'unknown_session' : 'delivery_failed', `Could not open conversation ${to}: ${error?.message ?? error}`); }
      try {
        const worker = need().host.getSessionWorker(to);
        if (!worker) throw fail('delivery_failed', `Conversation ${to} has no running engine after attach`);
        try { return await worker.request({ type: 'extension_request', name: DELIVER_REQUEST, data }); }
        catch (error) {
          throw fail('delivery_failed', /Unknown extension RPC request/.test(error?.message)
            ? `Conversation ${to} cannot receive session messages (its runtime has no session-link extension)`
            : `Delivery to ${to} failed: ${error?.message ?? error}`);
        }
      } finally { await client.detach().catch(() => {}); }
    });
  }
  function envelope({ messageId, kind, from, text }) {
    return { v: 1, messageId, kind, from: { sessionId: from.sessionId, title: from.title, cwd: from.cwd }, text };
  }
  const messageIdOf = (value) => {
    if (value === undefined) return randomUUID();
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 200) throw fail('invalid', 'messageId must be a non-empty string of at most 200 characters');
    return id;
  };
  /**
   * A turn that stopped on a question to the user still reads `running` in the
   * directory. The wait listens to the target's live worker for questions asked while it
   * waits, and never attaches: observing must not start a runtime, and an attach can
   * load one. A target with no live worker is judged by its directory row and transcript.
   * `asked` keeps the questions seen per target across a worker that unloads or changes.
   */
  function listen(id, listeners, asked) {
    const worker = need().host.getSessionWorker(id);
    const current = listeners.get(id);
    if (current?.worker === worker) return;
    current?.stop();
    listeners.delete(id);
    if (typeof worker?.on !== 'function') return;
    const ids = asked.get(id) ?? asked.set(id, []).get(id);
    const onEvent = (event) => {
      if (event?.type === 'extension_ui_request' && UI_METHODS.has(event.method) && event.id !== undefined) ids.push(String(event.id));
    };
    worker.on('event', onEvent);
    listeners.set(id, { worker, stop: () => worker.off('event', onEvent) });
  }
  /** `seen` carries the last parse per file, so an unchanged transcript is not read again. */
  async function progress(id, seen) {
    const file = await locate(id);
    const stats = await stat(file).catch(() => undefined);
    const key = stats ? `${file}:${stats.size}:${stats.mtimeMs}` : `${file}:absent`;
    let parsed = seen.get(id)?.key === key ? seen.get(id).progress : undefined;
    if (!parsed) {
      const { branch } = await readBranch(file, (entries) => entries.some(isFinal));
      parsed = { leaf: branch.at(-1)?.id ?? null, ...progressOf(branch) };
      seen.set(id, { key, progress: parsed });
    }
    return parsed;
  }
  async function snapshot(id, seen, listeners, asked) {
    const status = row(id)?.status ?? (need().host.getSessionWorker(id) ? 'idle' : 'stored');
    listen(id, listeners, asked);
    return { status, ui: [...new Set(asked.get(id) ?? [])], ...await progress(id, seen) };
  }
  const cursorOf = (state) => encodeCursor({ v: 1, final: state.final?.entryId ?? null, leaf: state.leaf,
    waiting: state.status === 'waiting', ui: [...state.ui].sort() });

  const api = {
    async list({ cwd, query, limit } = {}) {
      need();
      const max = clamp(limit, LIMITS.listDefault, 1, LIMITS.listMax, 'limit');
      let cwds;
      if (cwd !== undefined) {
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('invalid', 'cwd must be an absolute path');
        cwds = new Set([path.resolve(cwd), await realpath(cwd).catch(() => path.resolve(cwd))]);
      }
      if (query !== undefined && typeof query !== 'string') throw fail('invalid', 'query must be a string');
      const needle = query?.trim().toLowerCase();
      const matches = rows().filter((item) => (!cwds || cwds.has(item.cwd)) && (!needle ||
        [item.title, item.cwd, item.sessionId].some((value) => String(value ?? '').toLowerCase().includes(needle))));
      const live = (item) => item.runtimeId !== null && item.runtimeId !== undefined;
      const ordered = matches.map((item, index) => ({ item, index }))
        .sort((a, b) => (live(b.item) - live(a.item)) || ((b.item.modifiedAt ?? 0) - (a.item.modifiedAt ?? 0)) || (a.index - b.index))
        .map(({ item }) => item);
      return { sessions: ordered.slice(0, max).map((item) => ({ sessionId: item.sessionId, title: item.title, cwd: item.cwd,
        status: item.status, live: live(item), updatedAt: item.modifiedAt ?? null, messageCount: item.messageCount ?? 0 })),
      truncated: ordered.length > max };
    },
    async read({ sessionId, messages, maxCharsPerMessage } = {}) {
      requireId(sessionId, 'sessionId');
      const count = clamp(messages, LIMITS.readDefault, 1, LIMITS.readMax, 'messages');
      const chars = clamp(maxCharsPerMessage, LIMITS.charsDefault, 1, LIMITS.charsMax, 'maxCharsPerMessage');
      const described = await describe(sessionId);
      const file = await locate(sessionId);
      const visible = (entry) => summarize(entry, chars);
      const { branch, rooted, unreadable } = await readBranch(file, (entries) => entries.filter(visible).length > count);
      if (unreadable) throw fail('unreadable', `The newest entry of conversation ${sessionId} is larger than ${TAIL_BYTES.at(-1) / 1024 / 1024} MiB, so its recent messages cannot be read`);
      const summaries = branch.map(visible).filter(Boolean);
      const selected = branch.findLast((entry) => entry.type === 'model_change');
      const answer = branch.findLast((entry) => isAssistant(entry) && entry.message.model);
      const model = selected ? `${selected.provider}/${selected.modelId}`
        : answer ? [answer.message.provider, answer.message.model].filter(Boolean).join('/') : null;
      return {
        session: { sessionId, title: described.title, cwd: described.cwd, status: described.status, model,
          updatedAt: described.updatedAt, messageCount: described.messageCount },
        messages: summaries.slice(-count),
        truncated: summaries.length > count || !rooted,
      };
    },
    async wait({ targets, timeoutMs, signal } = {}) {
      need();
      if (!Array.isArray(targets) || !targets.length) throw fail('invalid', 'targets must list at least one conversation');
      if (targets.length > LIMITS.waitTargets) throw fail('invalid', `At most ${LIMITS.waitTargets} targets`);
      const timeout = clamp(timeoutMs, LIMITS.waitMaxMs, 0, LIMITS.waitMaxMs, 'timeoutMs');
      const deadline = now() + timeout;
      const stop = new AbortController();
      const ended = new Promise((resolve) => stop.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
      const end = () => stop.abort();
      const budget = setTimeout(end, timeout);
      signal?.addEventListener('abort', end, { once: true });
      if (signal?.aborted) end();
      const watched = [];
      const seen = new Map();
      const listeners = new Map();
      const asked = new Map();
      let wake = null;
      const waiter = { stop: end };
      waiters.add(waiter);
      try {
        for (const target of targets) {
          const id = requireId(target?.sessionId, 'targets[].sessionId');
          await describe(id);
          const current = await snapshot(id, seen, listeners, asked);
          // Without a cursor the caller has seen nothing since it sent: a pending question
          // wakes at once, and so does the answer of a target that already finished. Only
          // a running target's latest answer counts as seen, so the wait is for its next one.
          const base = target.afterCursor === undefined
            ? { ...decodeCursor(cursorOf(current)), waiting: false, ui: [], ...(BUSY.has(current.status) ? {} : { final: null }) }
            : decodeCursor(requireId(target.afterCursor, 'afterCursor'));
          watched.push({ id, base, baseCursor: encodeCursor(base), current });
        }
        const judge = ({ id, base, current }) => {
          if ((current.status === 'waiting' && !base.waiting) || current.ui.some((request) => !base.ui?.includes(request)))
            return { sessionId: id, cursor: cursorOf(current), reason: 'needs-attention', status: current.status,
              ...(current.latestAssistant ? { latestAssistant: current.latestAssistant } : {}) };
          // Commentary and tool steps stream while the target is busy; only a finished turn counts.
          if (!BUSY.has(current.status) && current.final && current.final.entryId !== base.final)
            return { sessionId: id, cursor: cursorOf(current), reason: 'completed', status: current.status, latestAssistant: current.final };
        };
        for (;;) {
          for (const item of watched) { wake = judge(item); if (wake) break; }
          if (wake || now() >= deadline || !bound || stop.signal.aborted) break;
          let timer;
          await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - now()))); })]);
          clearTimeout(timer);
          if (!bound) break;
          for (const item of watched) item.current = await snapshot(item.id, seen, listeners, asked);
        }
      } finally {
        waiters.delete(waiter);
        clearTimeout(budget);
        signal?.removeEventListener('abort', end);
        end();
        for (const listener of listeners.values()) listener.stop();
      }
      return {
        timedOut: !wake,
        wake: wake ?? null,
        polls: watched.map(({ id, baseCursor, current }) => {
          const cursor = cursorOf(current);
          return { sessionId: id, cursor, changed: cursor !== baseCursor, status: current.status,
            ...(current.latestAssistant ? { latestAssistant: current.latestAssistant } : {}),
            ...(current.latestTool ? { latestTool: current.latestTool } : {}) };
        }),
      };
    },
    async send({ from, to, text, messageId } = {}) {
      requireId(from, 'from'); requireId(to, 'to'); requireText(text);
      const id = messageIdOf(messageId);
      if (from === to) throw fail('self_send', 'A conversation cannot send a message to itself');
      const origin = await sender(from);
      await describe(to);
      const release = admit(from, to, text, { retry: messageId !== undefined });
      // Read before delivering, so an answer written before this call returns is still after it.
      let cursor;
      try {
        const before = await progress(to, new Map());
        cursor = encodeCursor({ v: 1, final: before.final?.entryId ?? null, leaf: before.leaf, waiting: false, ui: [] });
      } catch (error) { release(); throw error; }
      let answer;
      try { answer = await deliver(to, envelope({ messageId: id, kind: 'message', from: origin, text })); }
      catch (error) { release(); throw error; }
      const target = await describe(to);
      // What the target's handler said, never more: an older runtime answers without these.
      return { messageId: id, cursor, to: { sessionId: to, title: target.title, status: target.status },
        duplicate: typeof answer?.duplicate === 'boolean' ? answer.duplicate : null,
        state: answer?.state === 'queued' || answer?.state === 'written' ? answer.state : null };
    },
    async create({ from, cwd, title, text } = {}) {
      requireId(from, 'from'); requireText(text);
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('invalid', 'cwd must be an absolute path');
      if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 512)) throw fail('invalid', 'title must be a non-empty string of at most 512 characters');
      const origin = await sender(from);
      // A repeated create is a second conversation, so it counts as a duplicate per folder.
      const release = admit(from, `create:${cwd}`, text, { inbound: false });
      let created;
      try {
        created = await withClient(async (client) => client.create({ cwd, title: title?.trim(), titleLocked: title !== undefined }));
      } catch (error) {
        release();
        throw fail('invalid', `Could not create a conversation in ${cwd}: ${error?.message ?? error}`);
      }
      received(from, created.sessionId, text);
      try { await deliver(created.sessionId, envelope({ messageId: randomUUID(), kind: 'create', from: origin, text })); }
      catch (error) { throw fail(error.code ?? 'delivery_failed', `Created conversation ${created.sessionId}, but its first message was not delivered: ${error.message}`); }
      const described = await describe(created.sessionId);
      return { sessionId: created.sessionId, title: described.title, cwd: described.cwd, status: described.status };
    },
    /** `from` is optional and additive: the first message's sender defaults to the forked conversation. */
    async fork({ sessionId, text, from } = {}) {
      requireId(sessionId, 'sessionId');
      if (text !== undefined) requireText(text);
      if (from !== undefined) requireId(from, 'from');
      const { sessionsDir } = need();
      await describe(sessionId);
      const source = await locate(sessionId);
      const origin = text === undefined ? undefined : await sender(from ?? sessionId);
      const { parseSessionEntries, migrateSessionEntries, SessionManager } = await import('@earendil-works/pi-coding-agent');
      const entries = parseSessionEntries(await readFile(source, 'utf8'));
      const header = entries.find((entry) => entry.type === 'session');
      if (!header) throw fail('invalid', `Conversation ${sessionId} has no session header`);
      migrateSessionEntries(entries);
      const copied = completedHistory(branchOf(entries).branch);
      // Pi's own fork writes next to its source with Pi's header and file naming.
      const dir = path.dirname(source);
      const root = await realpath(sessionsDir);
      if (dir !== root && !dir.startsWith(root + path.sep)) throw fail('invalid', 'Source conversation is outside this profile');
      const manager = SessionManager.create(header.cwd, dir, { parentSession: source });
      const file = manager.getSessionFile();
      // Refuse before the file exists: a refused fork leaves nothing behind.
      const release = text === undefined ? () => {} : admit(origin.sessionId, manager.getSessionId(), text);
      try {
        await writeFile(file, [manager.getHeader(), ...copied].map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      } catch (error) { release(); throw error; }
      const metadata = await readSessionMetadata(file, await stat(file, { bigint: true }));
      files.set(metadata.id, file);
      // Publish it now rather than at the next directory poll.
      await withClient((client) => client.list()).catch(() => {});
      if (text !== undefined) {
        try { await deliver(metadata.id, envelope({ messageId: randomUUID(), kind: 'message', from: origin, text })); }
        catch (error) {
          release();
          throw fail(error.code ?? 'delivery_failed', `Forked conversation ${metadata.id}, but its first message was not delivered: ${error.message}`);
        }
      }
      return { sessionId: metadata.id, title: metadata.title, cwd: metadata.cwd,
        copiedMessages: copied.filter((entry) => entry.type === 'message').length };
    },
  };
  // Availability is checked before arguments, so an unbound engine answers the same way to every call.
  const facade = Object.freeze(Object.fromEntries(METHODS.map((name) => [name, async (args) => { need(); return api[name](args); }])));
  return {
    api: facade,
    ...facade,
    bind({ host, sessionsDir, socketPath, serverId, onError = () => {} }) {
      if (bound) throw new Error('session link is already bound');
      if (!host?.directory || typeof host.getSessionWorker !== 'function') throw new TypeError('session link requires a session host');
      if (!path.isAbsolute(sessionsDir ?? '') || !socketPath || !serverId) throw new TypeError('session link requires sessionsDir, socketPath and serverId');
      bound = { host, sessionsDir, socketPath, serverId, onError };
    },
    /** Unbinds: waits return, later calls refuse, and a restarted engine may bind again. */
    close() { bound = undefined; for (const waiter of waiters) waiter.stop?.(); },
  };
}
