import { open, readFile, stat, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { COMPANION_ENTRY } from '../../companion/companion.mjs';
import { SessionClient } from './client.mjs';
import { createFollower } from './companion-follow.mjs';
import { readSessionMetadata } from './session-metadata.mjs';
import { UI_METHODS } from './contracts.mjs';
import { sideChatEntries } from '../../pi-runtime/features/session-link/side-chat.mjs';
import { WAKES } from '../../pi-runtime/features/session-link/message.mjs';
import { EFFORT_LEVELS } from '../../pi-runtime/features/session-link/tools.mjs';
import { findRewindTarget } from '../../pi-runtime/features/conversation-rewind/rewind.mjs';
import { createInspector, isAgentId, readEntries, searchTerms, turnAround, windowTurn, INSPECT_LIMITS } from './session-inspect.mjs';

/** Answered by the session-link extension inside the target runtime. */
export const DELIVER_REQUEST = 'rubato.session-link.deliver';
export const SESSION_MESSAGE = 'rubato-session-message';
export const LIMITS = Object.freeze({ textChars: 8000, pairPerMinute: 8, senderPerMinute: 20, duplicateMs: 30000,
  // Receiver side, across all senders.
  inboundPerMinute: 20, inboundCharsPerMinute: 60000,
  windowMs: 60000, listDefault: 20, listMax: 50, readDefault: 12, readMax: 40, charsDefault: 1200, charsMax: 20000,
  waitTargets: 8, waitMaxMs: 120000, queryChars: 200 });
const METHODS = ['list', 'read', 'search', 'wait', 'send', 'create', 'fork', 'channel', 'telegramSend', 'companionSettings'];
const VIEWS = new Set(['messages', 'notes', 'board']);
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

/** One entry as a reader sees it. `tools` adds each call's input and the tool results. */
function summarize(entry, maxChars, { tools = false } = {}) {
  const at = timeOf(entry);
  if (isSessionMessage(entry)) {
    const text = typeof entry.details?.text === 'string' ? entry.details.text : textOf(entry.content);
    return { entryId: entry.id, role: 'session-message', text: clip(text, maxChars), at, toolCalls: [], isFinal: false };
  }
  if (entry.type !== 'message') return;
  const { role, content } = entry.message ?? {};
  if (role === 'user') return { entryId: entry.id, role, text: clip(textOf(content), maxChars), at, toolCalls: [], isFinal: false };
  if (tools && role === 'toolResult') {
    return { entryId: entry.id, role: 'tool', name: entry.message.toolName ?? null, text: clip(textOf(content), maxChars), at,
      toolCalls: [], isFinal: false, ...(entry.message.isError ? { isError: true } : {}) };
  }
  if (tools && role === 'bashExecution') {
    return { entryId: entry.id, role: 'tool', name: 'bash', text: clip(`${entry.message.command ?? ''}\n${entry.message.output ?? ''}`, maxChars), at,
      toolCalls: [], isFinal: false };
  }
  if (role !== 'assistant') return;
  const calls = Array.isArray(content) ? content.filter((part) => part?.type === 'toolCall') : [];
  const toolCalls = tools ? calls.map((part) => ({ name: part.name, input: clip(JSON.stringify(part.arguments ?? {}), maxChars) }))
    : calls.map((part) => part.name);
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
    final: final ? { entryId: final.id, text: clip(textOf(final.message.content), LIMITS.charsDefault),
      ...(final.message.stopReason === 'aborted' || final.message.stopReason === 'error' ? { stopReason: final.message.stopReason } : {}) } : undefined,
    latestAssistant: latest ? { entryId: latest.id, text: clip(textOf(latest.message.content), LIMITS.charsDefault) } : undefined,
    latestTool: tool ? { entryId: tool.id, name: toolName } : undefined,
  };
}

/** The model a transcript last used: its newest model change, else its newest answer's model. */
function modelOf(entries) {
  const selected = entries.findLast((entry) => entry.type === 'model_change');
  const answer = entries.findLast((entry) => isAssistant(entry) && entry.message.model);
  return selected ? `${selected.provider}/${selected.modelId}`
    : answer ? [answer.message.provider, answer.message.model].filter(Boolean).join('/') : null;
}

/** The newest `count` readable messages of a transcript's live branch, oldest first. */
async function recentMessages(file, id, { count, chars, tools }) {
  const visible = (entry) => summarize(entry, chars, { tools });
  const { branch, rooted, unreadable } = await readBranch(file, (entries) => entries.filter(visible).length > count);
  if (unreadable) throw fail('unreadable', `The newest entry of conversation ${id} is larger than ${TAIL_BYTES.at(-1) / 1024 / 1024} MiB, so its recent messages cannot be read`);
  const summaries = branch.map(visible).filter(Boolean);
  return { model: modelOf(branch), messages: summaries.slice(-count), truncated: summaries.length > count || !rooted };
}

/** The turn holding `entryId`, from the newest transcript file that has it. */
async function turnMessages(files, id, entryId, { count, chars, tools }) {
  for (const file of [...files].reverse()) {
    const entries = await readEntries(file);
    const turn = turnAround(entries, entryId);
    if (!turn) continue;
    const pairs = turn.entries.map((entry, index) => ({ index, summary: summarize(entry, chars, { tools }) })).filter((pair) => pair.summary);
    const target = Math.max(0, pairs.findLastIndex((pair) => pair.index <= turn.targetIndex));
    const { messages, truncated } = windowTurn(pairs.map((pair) => pair.summary), target, count);
    return { model: modelOf(entries), messages, truncated, around: entryId };
  }
  throw fail('invalid', `No entry ${entryId} in ${id}; pass an entryId that session_read or session_search returned for it`);
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
 * What a fork copies. Without `at`, the completed history. With `at` (the fingerprint of an
 * assistant message, as the app names a reply), the conversation up to the end of that
 * reply's turn: everything before the first input after it, the same point an app rewind
 * to that reply lands on (conversation-rewind findRewindTarget).
 */
export function forkedHistory(branch, at) {
  if (at === undefined) return completedHistory(branch);
  let drop;
  try { drop = findRewindTarget(branch, { keep: [at] }); }
  catch { throw fail('invalid', 'That reply is not on this conversation\'s current branch'); }
  return completedHistory(drop === null ? branch : branch.slice(0, branch.findIndex((entry) => entry.id === drop)));
}

/**
 * Writes a new conversation holding the completed history of `source`'s live branch, next to
 * it with Pi's own header and file naming (`parentSession` names the source). The source is
 * never rewritten. `title` names the copy; without one it keeps the source's title.
 * `at` ends the copy at a reply instead (forkedHistory).
 * `admit(sessionId)` runs before the file exists and returns a release; it may refuse by
 * throwing, so a refused fork leaves nothing behind. The session link's fork and the
 * engine's Management fork (host.mjs) both copy through here.
 * `side` makes the copy a side chat: the history is followed by the marker and the hidden
 * notice of side-chat.mjs, so the model knows where it is and the copied bytes stay as cached.
 */
export async function forkSessionFile({ source, sessionsDir, title, side = false, at, admit = () => () => {} }) {
  const { parseSessionEntries, migrateSessionEntries, SessionManager } = await import('@earendil-works/pi-coding-agent');
  const entries = parseSessionEntries(await readFile(source, 'utf8'));
  const header = entries.find((entry) => entry.type === 'session');
  if (!header) throw fail('invalid', `Conversation ${source} has no session header`);
  migrateSessionEntries(entries);
  // There is one companion: a copy of its conversation is an ordinary one (harness/companion).
  const copied = forkedHistory(branchOf(entries).branch.filter((entry) => !(entry.type === 'custom' && entry.customType === COMPANION_ENTRY)), at);
  if (side) {
    const taken = new Set(entries.map((entry) => entry.id));
    const newId = () => { let id; do id = randomBytes(4).toString('hex'); while (taken.has(id)); taken.add(id); return id; };
    copied.push(...sideChatEntries({ parentSessionId: header.id, parentId: copied.at(-1)?.id ?? null, newId }));
  }
  const dir = path.dirname(source);
  const root = await realpath(sessionsDir);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw fail('invalid', 'Source conversation is outside this profile');
  const manager = SessionManager.create(header.cwd, dir, { parentSession: source });
  const file = manager.getSessionFile();
  const release = admit(manager.getSessionId());
  try {
    await writeFile(file, [manager.getHeader(), ...copied].map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { release(); throw error; }
  if (title) SessionManager.open(file, dir).appendSessionInfo(title);
  const metadata = await readSessionMetadata(file, await stat(file, { bigint: true }));
  return { metadata, release, copiedMessages: copied.filter((entry) => entry.type === 'message').length };
}

/**
 * One engine-wide link between the conversations of this profile. The holder exists
 * before the host does (extension factories receive it at runtime creation) and is
 * bound once the server listens; until then every method refuses.
 */
export function createSessionLink({ now = Date.now, pollMs = POLL_MS, followPollMs = 2000 } = {}) {
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
  /**
   * The sender's own name and folder, and whether it is the companion (its words then reach the
   * receiver framed as work Segno, the CTO leading it, assigned (message.mjs); callers pass ids only.
   */
  async function sender(id) {
    const known = row(id);
    if (known) return { sessionId: id, title: known.title, cwd: known.cwd, ...(known.companion === true ? { companion: true } : {}) };
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
   * `prepare(worker)` runs in that runtime before the message goes in. Resolves to the handler's answer.
   */
  async function deliver(to, data, prepare) {
    return withClient(async (client) => {
      try { await client.attach(to); }
      catch (error) { throw fail(/not found/i.test(error?.message) ? 'unknown_session' : 'delivery_failed', `Could not open conversation ${to}: ${error?.message ?? error}`); }
      try {
        const worker = need().host.getSessionWorker(to);
        if (!worker) throw fail('delivery_failed', `Conversation ${to} has no running engine after attach`);
        if (prepare) await prepare(worker);
        try { return await worker.request({ type: 'extension_request', name: DELIVER_REQUEST, data }); }
        catch (error) {
          throw fail('delivery_failed', /Unknown extension RPC request/.test(error?.message)
            ? `Conversation ${to} cannot receive session messages (its runtime has no session-link extension)`
            : `Delivery to ${to} failed: ${error?.message ?? error}`);
        }
      } finally { await client.detach().catch(() => {}); }
    });
  }
  function envelope({ messageId, kind, from, text, attachments }) {
    // A channel delivery names where it came from instead of another conversation: the messenger,
    // the chat, who wrote and whether that is the user (harness/companion/messenger), and the
    // files it saved from that message; the receiving runtime checks them (message.mjs).
    if (kind === 'channel')
      return { v: 1, messageId, kind, from: { channel: from.channel, chatId: from.chatId, isUser: from.isUser === true,
        ...(from.name ? { name: from.name } : {}), ...(from.messageId === undefined ? {} : { messageId: from.messageId }) }, text,
        ...(attachments === undefined ? {} : { attachments }) };
    return { v: 1, messageId, kind, from: { sessionId: from.sessionId, title: from.title, cwd: from.cwd,
      ...(from.companion === true ? { companion: true } : {}) }, text };
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
    return { status, ui: [...new Set(asked.get(id) ?? [])], pending: need().host.pendingQuestions?.(id) ?? [], ...await progress(id, seen) };
  }
  /**
   * Whether the handoff message was written before the final `finalId` ('before'), after it or not
   * at all ('after'). The transcript is append-only, so file order is write order.
   */
  async function handoffOrder(id, messageId, finalId, cache) {
    const file = await locate(id);
    const stats = await stat(file).catch(() => undefined);
    const key = `${file}:${stats?.size}:${stats?.mtimeMs}:${messageId}:${finalId}`;
    if (cache.get(id)?.key === key) return cache.get(id).order;
    const text = await readFile(file, 'utf8').catch(() => '');
    const message = text.indexOf(`"messageId":${JSON.stringify(messageId)}`);
    const final = text.indexOf(`"id":${JSON.stringify(finalId)}`);
    const order = message >= 0 && final >= 0 && message < final ? 'before' : 'after';
    cache.set(id, { key, order });
    return order;
  }
  const cursorOf = (state) => encodeCursor({ v: 1, final: state.final?.entryId ?? null, leaf: state.leaf,
    waiting: state.status === 'waiting', ui: [...state.ui].sort() });

  /** The companion's handoffs are followed until they end (companion-follow.mjs). */
  const fromCompanion = (id) => row(id)?.companion === true;
  function createCompanionFollower({ store, onError }) {
    const seen = new Map();
    const listeners = new Map();
    const asked = new Map();
    const orders = new Map();
    return createFollower({ store, onError, pollMs: followPollMs,
      inspect: async (id, record) => {
        const described = await describe(id);
        const current = await snapshot(id, seen, listeners, asked);
        const handoff = record?.messageId && current.final ? await handoffOrder(id, record.messageId, current.final.entryId, orders) : undefined;
        return { ...current, title: described.title, cwd: described.cwd, ...(handoff ? { handoff } : {}) };
      },
      notify: async (companionId, targetId, text) => {
        const about = await describe(targetId);
        return deliver(companionId, envelope({ messageId: randomUUID(), kind: 'notice',
          from: { sessionId: targetId, title: about.title, cwd: about.cwd }, text }));
      },
    });
  }

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
    /**
     * One conversation, or one subagent or team member by its st_ id. `view` picks what to read:
     * its messages (the recent ones, or with `entryId` the turn holding that entry), its context
     * notes, or the shared board of its team runs. The messages overview also lists the subagents
     * and team runs a conversation started, when it has any.
     */
    async read({ sessionId, messages, maxCharsPerMessage, entryId, includeTools, view, notePath } = {}) {
      requireId(sessionId, 'sessionId');
      const shown = view ?? 'messages';
      if (!VIEWS.has(shown)) throw fail('invalid', 'view must be messages, notes or board');
      if (includeTools !== undefined && typeof includeTools !== 'boolean') throw fail('invalid', 'includeTools must be a boolean');
      if (entryId !== undefined && (typeof entryId !== 'string' || !entryId)) throw fail('invalid', 'entryId must be an entry id from session_read or session_search');
      if (notePath !== undefined && (typeof notePath !== 'string' || !notePath)) throw fail('invalid', 'notePath must be a note path');
      const count = clamp(messages, entryId === undefined ? LIMITS.readDefault : LIMITS.readMax, 1, LIMITS.readMax, 'messages');
      const chars = clamp(maxCharsPerMessage, LIMITS.charsDefault, 1, LIMITS.charsMax, 'maxCharsPerMessage');
      const tools = includeTools === true;
      const { inspector } = need();

      if (isAgentId(sessionId)) {
        const found = await inspector.agent(sessionId);
        if (!found) throw fail('unknown_session', `No conversation or subagent with id ${sessionId}`);
        const head = { agent: found.info };
        if (shown === 'notes') return { ...head, ...(found.sessionUuid ? await inspector.notes(found.sessionUuid, { chars, notePath }) : { available: false, notes: [] }) };
        if (shown === 'board') return { ...head, teams: await inspector.boards({ agentId: sessionId }) };
        if (!found.files.length) return { ...head, messages: [], truncated: false };
        const read = entryId === undefined
          ? await recentMessages(found.files.at(-1), sessionId, { count, chars, tools })
          : await turnMessages(found.files, sessionId, entryId, { count, chars, tools });
        return { ...head, messages: read.messages, ...(read.around ? { around: read.around } : {}), truncated: read.truncated };
      }

      const described = await describe(sessionId);
      const session = { sessionId, title: described.title, cwd: described.cwd, status: described.status };
      if (shown === 'notes') return { session, ...await inspector.notes(sessionId, { chars, notePath }) };
      if (shown === 'board') return { session, teams: await inspector.boards({ sessionId, cwd: described.cwd }) };
      const file = await locate(sessionId);
      const read = entryId === undefined
        ? await recentMessages(file, sessionId, { count, chars, tools })
        : await turnMessages([file], sessionId, entryId, { count, chars, tools });
      const result = {
        session: { ...session, model: read.model, updatedAt: described.updatedAt, messageCount: described.messageCount },
        messages: read.messages,
        ...(read.around ? { around: read.around } : {}),
        truncated: read.truncated,
      };
      if (entryId === undefined) {
        // Only what exists: a conversation that started no subagent or team reads exactly as before.
        const { agents, agentsTruncated, teams } = await inspector.related(sessionId, described.cwd);
        if (agents.length) result.agents = agents;
        if (agentsTruncated) result.agentsTruncated = true;
        if (teams.length) result.teams = teams;
      }
      return result;
    },
    /**
     * Full-text search over conversations and the transcripts of their subagents and team members.
     * Every whitespace-separated term must appear in one message; tool calls and output count only
     * with `includeTools`. `exclude` drops one conversation (the caller's own) from a broad search.
     */
    async search({ query, cwd, sessionId, includeTools, limit, exclude } = {}) {
      const { inspector } = need();
      if (typeof query !== 'string' || !searchTerms(query).length) throw fail('invalid', 'query must be a non-empty string');
      if (query.length > LIMITS.queryChars) throw fail('too_long', `query is ${query.length} characters; the limit is ${LIMITS.queryChars}`);
      if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw fail('invalid', 'cwd must be an absolute path');
      if (includeTools !== undefined && typeof includeTools !== 'boolean') throw fail('invalid', 'includeTools must be a boolean');
      if (exclude !== undefined) requireId(exclude, 'exclude');
      if (sessionId !== undefined) {
        requireId(sessionId, 'sessionId');
        if (!isAgentId(sessionId)) await describe(sessionId);
      }
      const max = clamp(limit, INSPECT_LIMITS.searchDefault, 1, INSPECT_LIMITS.searchMax, 'limit');
      const result = await inspector.search({ query, ...(cwd === undefined ? {} : { cwd: path.resolve(cwd) }), sessionId,
        tools: includeTools === true, limit: max, exclude });
      if (result.unknown) throw fail('unknown_session', `No conversation or subagent with id ${sessionId}`);
      delete result.unknown;
      return result;
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
      let cursor, before;
      const busy = BUSY.has(row(to)?.status);
      try {
        before = await progress(to, new Map());
        cursor = encodeCursor({ v: 1, final: before.final?.entryId ?? null, leaf: before.leaf, waiting: false, ui: [] });
      } catch (error) { release(); throw error; }
      let answer;
      try { answer = await deliver(to, envelope({ messageId: id, kind: 'message', from: origin, text })); }
      catch (error) { release(); throw error; }
      if (fromCompanion(from)) need().follower.follow(to, from, { final: before.final?.entryId ?? null, busy, messageId: id });
      const target = await describe(to);
      // What the target's handler said, never more: an older runtime answers without these.
      return { messageId: id, cursor, to: { sessionId: to, title: target.title, status: target.status },
        duplicate: typeof answer?.duplicate === 'boolean' ? answer.duplicate : null,
        state: answer?.state === 'queued' || answer?.state === 'written' ? answer.state : null };
    },
    /**
     * `model` ("provider/model-id") and `thinking` (an effort level) are selected in the new
     * runtime before its first message, so the first turn already runs on them. The model clamps
     * an unsupported level to its nearest one; the answer reports what took effect.
     */
    async create({ from, cwd, title, text, model, thinking } = {}) {
      requireId(from, 'from'); requireText(text);
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('invalid', 'cwd must be an absolute path');
      if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 512)) throw fail('invalid', 'title must be a non-empty string of at most 512 characters');
      if (model !== undefined && (typeof model !== 'string' || !/^[^/\s]+\/\S+$/.test(model))) throw fail('invalid', 'model must be "provider/model-id"');
      if (thinking !== undefined && !EFFORT_LEVELS.includes(thinking)) throw fail('invalid', `thinking must be one of ${EFFORT_LEVELS.join(', ')}`);
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
      let selected;
      const select = model === undefined && thinking === undefined ? undefined : async (worker) => {
        try {
          if (model !== undefined) {
            const split = model.indexOf('/');
            await worker.request({ type: 'set_model', provider: model.slice(0, split), modelId: model.slice(split + 1) });
          }
          if (thinking !== undefined) await worker.request({ type: 'set_thinking_level', level: thinking });
          const state = await worker.request({ type: 'get_state' });
          selected = { model: state?.model?.provider && state?.model?.id ? `${state.model.provider}/${state.model.id}` : null,
            thinking: state?.thinkingLevel ?? null };
        } catch (error) {
          throw fail('invalid', `could not select ${[model, thinking && `effort ${thinking}`].filter(Boolean).join(' at ')}: ${error?.message ?? error}`);
        }
      };
      try { await deliver(created.sessionId, envelope({ messageId: randomUUID(), kind: 'create', from: origin, text }), select); }
      catch (error) { throw fail(error.code ?? 'delivery_failed', `Created conversation ${created.sessionId}, but its first message was not delivered: ${error.message}`); }
      if (fromCompanion(from)) need().follower.follow(created.sessionId, from);
      const described = await describe(created.sessionId);
      return { sessionId: created.sessionId, title: described.title, cwd: described.cwd, status: described.status, ...selected };
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
      const { metadata, release, copiedMessages } = await forkSessionFile({ source, sessionsDir,
        admit: (id) => text === undefined ? () => {} : admit(origin.sessionId, id, text) });
      files.set(metadata.id, metadata.file);
      // Publish it now rather than at the next directory poll.
      await withClient((client) => client.list()).catch(() => {});
      if (text !== undefined) {
        try { await deliver(metadata.id, envelope({ messageId: randomUUID(), kind: 'message', from: origin, text })); }
        catch (error) {
          release();
          throw fail(error.code ?? 'delivery_failed', `Forked conversation ${metadata.id}, but its first message was not delivered: ${error.message}`);
        }
      }
      return { sessionId: metadata.id, title: metadata.title, cwd: metadata.cwd, copiedMessages };
    },
    /**
     * The companion's settings, read or changed by talking to it (harness/companion/settings.mjs):
     * through the Settings page's own code, and a change only in a run the user opened.
     */
    async companionSettings({ sessionId, action, piece, change } = {}) {
      requireId(sessionId, 'sessionId');
      const { sessionsDir } = need();
      if (row(sessionId) && row(sessionId).companion !== true) throw fail('not_companion', "Only Segno's own conversation has settings");
      const { companionSettings } = await import('../../companion/settings.mjs');
      try { return await companionSettings({ sessionId, sessionsDir, request: { action, piece, change } }); }
      catch (error) { throw error?.name === 'SettingsRefused' ? fail(error.code, error.message) : error; }
    },
    /**
     * What the companion's Telegram tools ask for (harness/companion/messenger): a message it wrote,
     * a reaction or an edit (`op`). The resident messenger checks the request and decides what
     * goes out at once and what waits for the person, so the tools never reach Telegram themselves.
     * It lives on `api`, so the facade the runtime gets reaches it.
     */
    async telegramSend(request = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('invalid', 'telegramSend takes one request object');
      if (!bound) throw fail('unavailable', 'This engine has no messenger');
      const send = bound.telegramSend;
      if (typeof send !== 'function') throw fail('unavailable', 'The messenger is not running in this engine');
      const { to, name, ...rest } = request;
      return send({ ...rest, to: to === undefined || to === null || to === '' ? 'user' : String(to),
        ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}) });
    },
  };
  // Availability is checked before arguments, so an unbound engine answers the same way to every call.
  const facade = Object.freeze(Object.fromEntries(METHODS.map((name) => [name, async (args) => { need(); return api[name](args); }])));
  return {
    api: facade,
    ...facade,
    /** `followStore` keeps the companion's followed handoffs across restarts (harness/companion followingStore). */
    bind({ host, sessionsDir, socketPath, serverId, onError = () => {}, followStore }) {
      if (bound) throw new Error('session link is already bound');
      if (!host?.directory || typeof host.getSessionWorker !== 'function') throw new TypeError('session link requires a session host');
      if (!path.isAbsolute(sessionsDir ?? '') || !socketPath || !serverId) throw new TypeError('session link requires sessionsDir, socketPath and serverId');
      // Context notes and the runtime's own tools live next to the sessions folder (agentDir).
      const inspector = createInspector({ agentDir: path.dirname(sessionsDir), sessionsDir,
        cwds: () => rows().map((item) => item.cwd).filter(Boolean), titleOf: (id) => row(id)?.title, locate });
      bound = { host, sessionsDir, socketPath, serverId, onError, inspector };
      bound.follower = createCompanionFollower({ store: followStore, onError });
    },
    /** Rubato's own word to a conversation (`kind: 'notice'`); it wakes the conversation like any delivery. */
    async notice({ to, about, text } = {}) {
      requireId(to, 'to'); requireText(text);
      const from = about ?? { sessionId: 'rubato', title: 'Rubato', cwd: '' };
      return deliver(to, envelope({ messageId: randomUUID(), kind: 'notice', from, text }));
    },
    /**
     * Rubato's own clock (`kind: 'wake'`): the companion's heartbeat and daily report (harness/companion
     * keeper.mjs). The conversation takes it as a system message where its model allows, and it
     * draws no bubble; only the turn it starts shows.
     */
    async wake({ to, what, text } = {}) {
      requireId(to, 'to'); requireText(text);
      if (!WAKES.includes(what)) throw fail('invalid', `what must be one of ${WAKES.join(', ')}`);
      return deliver(to, { v: 1, messageId: randomUUID(), kind: 'wake', what,
        from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text });
    },
    /**
     * A person's words from a messenger into a conversation (harness/companion/messenger): the
     * companion's Telegram chat. `from.isUser` says whether it is the person the conversation
     * belongs to; anyone else's words arrive without the user's authority.
     */
    async channel({ to, from, text, attachments } = {}) {
      requireId(to, 'to'); requireText(text);
      if (!from || typeof from !== 'object' || typeof from.channel !== 'string' || !from.channel.trim())
        throw fail('invalid', 'from.channel must name the messenger');
      if (attachments !== undefined && !Array.isArray(attachments)) throw fail('invalid', 'attachments must be a list');
      return deliver(to, envelope({ messageId: randomUUID(), kind: 'channel',
        from: { channel: from.channel.trim(), chatId: from.chatId === undefined || from.chatId === null ? '' : String(from.chatId),
          isUser: from.isUser === true,
          ...(typeof from.name === 'string' && from.name.trim() ? { name: from.name.trim() } : {}),
          ...(from.messageId === undefined ? {} : { messageId: from.messageId }) }, text,
        ...(attachments?.length ? { attachments } : {}) }));
    },
    /**
     * Connects the messenger's queue to the tools (`telegramSend`). The resident messenger passes a
     * function that queues one message; the engine's service supervisor owns the service itself.
     */
    attachTelegram(send) {
      if (typeof send !== 'function') throw new TypeError('attachTelegram needs a function');
      if (!bound) throw new Error('session link is not bound yet');
      bound.telegramSend = send;
    },
    /** Unbinds: waits return, later calls refuse, and a restarted engine may bind again. */
    close() { void bound?.follower.close(); bound = undefined; for (const waiter of waiters) waiter.stop?.(); },
  };
}
