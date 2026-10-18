import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PiCommandRejected } from './contracts.mjs';
import { trimHistoryImagePixels } from './history-images.mjs';
import { FRAME_BUDGET } from './wire.mjs';

// get_messages carries every image the session ever saw as inline base64, and the
// frame limit below stops the whole session when a response crosses it. A session
// that is far inside its token window can still cross it: 41 screenshots made a
// 36MB history, and the thread could no longer be opened. Readers of the history
// (the T3 bridge) use its text, so the oldest pixels give way first.
const trimHistoryImages = (value) => {
  const data = value.data;
  const messages = Array.isArray(data) ? data : data?.messages;
  if (!Array.isArray(messages)) return value;
  const trimmed = trimHistoryImagePixels(messages);
  if (trimmed === messages) return value;
  return { ...value, data: Array.isArray(data) ? trimmed : { ...data, messages: trimmed } };
};

/** One frame: what this boundary and the presentation transport carry (host.mjs maxFrameLength). */
const FRAME_LIMIT = 32 * 1024 * 1024;

// get_entries lists every entry the session file holds: every branch, every tool output and
// image. A 222MB session answered with 222MB, the frame limit stopped the session, and T3's
// Pi adapter asks for that listing whenever it binds a thread, so every turn on it died
// within a second. The listing's readers walk the tree: entry ids, parents and kinds, the
// role, timestamp and model a reply's fingerprint hashes (conversation-rewind
// messageFingerprint), and tool call ids (T3 step rewind). A listing over one frame's
// budget therefore comes as that outline of every entry, marked `rubatoOutlined`.
/** Longest string an outline keeps. Ids measured at most 92 chars; payloads run to megabytes. */
const OUTLINE_STRING = 256;
const scalar = (value) => value === null || typeof value === 'number' || typeof value === 'boolean'
  || (typeof value === 'string' && value.length <= OUTLINE_STRING);
const scalars = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => scalar(value)));

/** One entry as its tree position, kind, message identity and tool call ids. */
export function outlineEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const outline = scalars(entry);
  const message = entry.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    outline.message = scalars(message);
    if (Array.isArray(message.content)) outline.message.content = message.content
      .filter((part) => part?.type === 'toolCall')
      .map(({ type, id, name }) => ({ type, id, name }));
  }
  return outline;
}

/** The listing whole while it fits one reply's budget; past it, every entry outlined. */
const outlineEntries = (value) => {
  const entries = value.data?.entries;
  if (!Array.isArray(entries)) return value;
  let bytes = 0;
  for (const entry of entries) {
    bytes += Buffer.byteLength(JSON.stringify(entry) ?? 'null') + 1;
    if (bytes > FRAME_BUDGET) return { ...value, data: { ...value.data, entries: entries.map(outlineEntry), rubatoOutlined: true } };
  }
  return value;
};

/** Same host contract as RpcWorker, but the SDK runtime lives in this process.
 * Bootstrap is injected by the engine owner, never guessed from process cwd.
 */
export class SessionWorker extends EventEmitter {
  // Hosted prompt preflight and large get_messages can exceed 30s (astra notes).
  constructor(metadata, { createRuntime, runRpcMode, timeoutMs = 120000, deferSessionStart = false, disposeContext }) {
    super();
    if (typeof createRuntime !== 'function' || typeof runRpcMode !== 'function') throw new TypeError('A hosted worker requires runtime and RPC factories');
    this.metadata = metadata;
    this.options = { createRuntime, runRpcMode, timeoutMs, deferSessionStart, disposeContext };
    this.id = randomUUID();
    this.pending = new Map();
    this.eventSequence = 0;
    this.closed = false;
    this.terminated = new Promise(resolve => { this.resolveTerminated = resolve; });
  }
  finish(error) {
    if (this.finished) return;
    error ??= this.failure;
    this.finished = true;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('Pi session stopped'));
    }
    this.pending.clear();
    this.resolveTerminated(error);
  }
  releaseContext() {
    return this.contextReleased ??= Promise.resolve().then(() => this.options.disposeContext?.());
  }
  output(value) {
    if (this.closed) return;
    // Keep the existing RPC value boundary: no shared mutable session objects.
    const pendingCall = value?.type === 'response' ? this.pending.get(value.id) : undefined;
    let record;
    try {
      const answer = !pendingCall || !value.success ? value
        : pendingCall.type === 'get_messages' ? trimHistoryImages(value)
        : pendingCall.type === 'get_entries' ? outlineEntries(value) : value;
      const encoded = JSON.stringify(answer);
      if (Buffer.byteLength(encoded) > FRAME_LIMIT) throw new Error(`Pi RPC frame exceeds limit${pendingCall ? `: ${pendingCall.type}` : ''}`);
      record = JSON.parse(encoded);
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') {
        throw new Error('Invalid Pi RPC frame');
      }
    }
    catch (error) {
      // An answer that cannot cross never left this process, so the session behind it is
      // intact: only the request that asked for it fails. An event cannot be dropped without
      // breaking the stream every presentation replays, so it still stops the session.
      if (pendingCall) { this.pending.delete(value.id); clearTimeout(pendingCall.timer); pendingCall.reject(error); return; }
      void this.stop(error); return;
    }
    if (record.type !== 'response') {
      this.eventSequence++;
      this.emit('event', record);
      return;
    }
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    clearTimeout(pending.timer);
    if (!record.success) pending.reject(new PiCommandRejected(record.error || 'Pi RPC failed'));
    else pending.resolve(pending.withBoundary
      ? { data: record.data ?? null, eventSequence: this.eventSequence } : record.data ?? null);
  }
  start() {
    if (this.starting || this.closed) return Promise.reject(new Error('Worker already started or closed'));
    this.starting = (async () => {
      this.runtime = await this.options.createRuntime(this.metadata);
      if (this.closed) throw new Error('Session stopped during startup');
      this.controller = await this.options.runRpcMode(this.runtime, {
        deferSessionStart: this.options.deferSessionStart,
        output: value => this.output(value), onClose: error => {
          void this.releaseContext().then(() => this.finish(error), cleanupError => this.finish(error ?? cleanupError));
        },
      });
      if (this.closed) throw new Error('Session stopped during startup');
      const state = await this.request({ type: 'get_state' });
      if (state.sessionId !== this.metadata.id) throw new Error('Pi resumed a different persisted session');
      return state;
    })();
    return this.starting.catch(async error => { await this.stop(error); throw error; });
  }
  request(command, { withBoundary = false } = {}) {
    if (this.closed || !this.controller) return Promise.reject(new Error('Pi session is not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC timed out: ${command.type}; outcome may be unknown`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, withBoundary, type: command.type });
      Promise.resolve().then(() => this.controller.dispatch({ ...command, id })).catch(error => {
        if (this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  reply(response) {
    if (this.closed || !this.controller) throw new Error('Pi session is not running');
    void this.controller.dispatch({ ...response, type: 'extension_ui_response' }).catch(error => this.stop(error));
  }
  stop(error) {
    this.failure ??= error;
    if (this.stopping) return this.stopping;
    this.closed = true;
    // Release callers immediately, but not the router's termination fence: a
    // replacement writer may start only after startup and SDK cleanup finish.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(error ?? new Error('Pi session stopped'));
    }
    this.pending.clear();
    return this.stopping = (async () => {
      let failure = error;
      await this.starting?.catch(() => {});
      try {
        if (this.controller) await this.controller.close();
        else if (this.runtime) {
          try { await this.runtime.session.abort(); }
          finally { await this.runtime.dispose(); }
        }
      } catch (caught) { failure ??= caught; }
      try { await this.releaseContext(); } catch (caught) { failure ??= caught; }
      this.finish(failure);
      return this.terminated;
    })();
  }
}
