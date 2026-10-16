import { SessionClient } from '../../pi-server/src/client.mjs';
import { controlCommandFor, rewriteSkillMentions } from './commands.mjs';
import { applySelectionOptions } from './model-catalog-order.mjs';
import { messageFingerprint } from '../../pi-runtime/features/conversation-rewind/rewind.mjs';
import { cacheFrom, cacheMoved } from './session-state.mjs';
import { isBookkeepingTool } from './activity.mjs';

/**
 * One Pi RPC stream for upstream T3's Pi adapter (orchestrator V2), served by the shared
 * Rubato engine instead of a `pi --mode rpc` child. Each Rubato session already is a Pi
 * RPC worker behind the engine; this attaches to one and speaks the adapter's side of the
 * protocol (PiRpcConnection in packages/provider-pi/src/server/rpc.ts):
 *
 *   request(record)  correlated command → the engine's Control.command, its data back
 *   send(record)     fire-and-forget; its answer comes back as an id-less `response`
 *                    record on the event stream, in the order Pi would write it
 *   onRecord         every session event the engine publishes after we attached
 *   close()          detaches. The engine keeps the session and any running turn.
 *
 * Two Pi commands do not exist on an attached session and are answered here:
 * `new_session` creates one through the engine's Management service, `switch_session`
 * attaches to an existing one. A `pi --mode rpc` process starts inside a fresh session and
 * the adapter's first registration relies on that (its first command is `get_state`), so
 * the first command with nothing attached opens the thread's session: the one the thread
 * already ran in (`boundSession`, a conversation from before T3's V2 orchestrator or one
 * the inventory imported), or a new one. The native thread id the adapter keeps is the engine's
 * session id: `get_state` reports it as `sessionFile` (the field the adapter reads as
 * the id `switch_session` takes); Pi's real file path rides along as `rubatoSessionFile`.
 *
 * Two Rubato behaviors live in this stream, because the adapter decides from it:
 * - A turn stays open while the idle agent waits on a background completion that will
 *   wake it (decisions/t3-turn-held-on-awaited-wake.md): Pi's `agent_settled` is held while
 *   the engine names an awaited wake, a "Waiting on …" tool row says what for, and the
 *   wake's `agent_start` continues the same turn. A wait that ends without a wake lets the
 *   settle through after a grace; Stop ends it as interrupted.
 * - Rubato's controls typed in the composer (/name, /reload, /rewind N) are not prompts for
 *   Pi (commands.mjs CONTROL). /rewind sends Pi nothing: T3 reverts the turns, which rewinds
 *   the engine through the rollback below and drops the rows on every screen. Upstream's
 *   compact becomes Rubato's own /compact when the engine has it (the notes-mode cut), and
 *   the picker's reasoning effort and Fast reach Pi through `rubato_selection`, a record
 *   the adapter sends after its own model choice (pi-adapter-edits.mjs selectionRecord).
 * - A Stop can strand a steer Pi had not read yet. After the abort it is cleared from Pi's
 *   queue and its text comes back as a warning in the turn instead of surfacing inside an
 *   unrelated later turn (decisions/t3-queued-message-vs-steer.md).
 */
/** The active branch of a `get_entries` answer, root first. */
export function activeBranch({ entries, leafId } = {}) {
  const byId = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));
  const branch = [];
  const seen = new Set();
  for (let id = leafId ?? null; id !== null && byId.has(id) && !seen.has(id); id = byId.get(id).parentId ?? null) {
    seen.add(id);
    branch.push(byId.get(id));
  }
  return branch.reverse();
}
/**
 * The cut T3 asks for as the engine names it. Upstream's Pi adapter names the first entry a
 * rollback or fork drops: the first user message of the earliest turn that goes. The engine
 * names what stays: the fingerprint of the last reply before that entry
 * (conversation-rewind findRewindTarget, session-link forkedHistory). No reply before it
 * keeps nothing.
 */
export function replyBefore(branch, entryId) {
  const at = branch.findIndex((entry) => entry.id === entryId);
  if (at < 0) throw new Error('That point is not on this conversation\'s current branch');
  const reply = branch.slice(0, at).findLast((entry) => entry.type === 'message' && entry.message?.role === 'assistant');
  return reply ? messageFingerprint(reply.message) : null;
}

/**
 * The prompt a step rewind's "continue" sends through T3 (RubatoStepRewind.ts). T3 shows it
 * as the user's message; Pi gets no message and runs on from the step's tool results, so
 * every byte the model saw before stays as cached.
 */
export const STEP_CONTINUE_TEXT = 'Continue from the rewound step.';
/** The tool calls answered together with `toolCallId` (one assistant message), on the live branch. */
export function stepBatch(branch, toolCallId) {
  const reply = branch.find((entry) => entry.type === 'message' && entry.message?.role === 'assistant'
    && (entry.message.content ?? []).some((part) => part?.type === 'toolCall' && part.id === toolCallId));
  if (!reply) throw new Error('This step is not on the conversation\'s current branch');
  return reply.message.content.filter((part) => part?.type === 'toolCall' && typeof part.id === 'string').map((part) => part.id);
}

/** The wait that ended starts the agent's next run a moment later; the turn waits that long. */
export const AWAIT_POLL_MS = 2_000;
export const AWAIT_GRACE_MS = 3_000;
export const AWAIT_TITLE = 'Waiting on background work';
const nonempty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
/** Pi's queued inputs in the order they were sent (`clear_queue` returns them by kind). */
export function queuedMessagesInOrder(state, cleared) {
  const byDelivery = {
    steer: [...(cleared?.steering ?? [])],
    followUp: [...(cleared?.followUp ?? [])],
  };
  const ordered = [];
  for (const pending of state?.requestTimeline?.pendingInputs ?? []) {
    const queue = byDelivery[pending?.delivery];
    if (queue?.length) ordered.push(queue.shift());
  }
  return [...ordered, ...byDelivery.steer, ...byDelivery.followUp]
    .filter((message) => typeof message === 'string' && message.trim());
}
export class RubatoRpcConnection {
  constructor(bridge, { threadId, cwd, onRecord, onClosed = () => {}, log = () => {},
    awaitTimings = { pollMs: AWAIT_POLL_MS, graceMs: AWAIT_GRACE_MS } }) {
    Object.assign(this, { bridge, threadId, cwd, onRecord, onClosed, log, awaitTimings });
    this.bound = undefined;
    // Inbound records in order, through the steps that may wait on the engine.
    this.inbound = Promise.resolve();
    this.hold = null;
    this.waits = 0;
    this.strandedNotices = 0;
    this.sessionId = null;
    this.closed = false;
  }
  async open() {
    await this.bridge.connection();
    this.client = await new SessionClient({ ...this.bridge.descriptor, onError: (error) => this.log('client error', error) }).connect();
    // A dead engine socket surfaces as `connected` turning false; the adapter then sees the
    // transport fail and the orchestrator opens a new session on the next turn.
    this.watchdog = setInterval(() => {
      if (!this.closed && this.client && !this.client.client.connected) void this.close(new Error('Rubato engine connection closed'));
    }, 1000);
    this.watchdog.unref?.();
    return this;
  }
  async attach(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('A Rubato session id is required');
    if (this.sessionId === sessionId) return;
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.sessionId) await this.client.detach().catch(() => {});
    this.sessionId = null;
    await this.client.attach(sessionId);
    this.sessionId = sessionId;
    this.bridge.claimed.add(sessionId);
    this.runtimeId = undefined;
    this.sequence = 0;
    // What Pi runs with is the session's: ask again rather than carry the last one over.
    this.thinkingLevel = undefined;
    this.fastMode = undefined;
    this.compactCommand = undefined;
    this.fold = this.bridge.stateFor?.(this.threadId, sessionId);
    this.unsubscribe = await this.client.subscribeSession((state) => this.onState(state));
    void this.refreshCache();
    // A name given while T3 was away (the CLI, a turn T3 did not watch) shows on attach.
    this.command({ type: 'get_state' }).then((state) => {
      if (typeof state?.sessionName === 'string' && state.sessionName.trim()) this.mirrorTitle(state.sessionName.trim());
    }, () => {});
  }
  mirrorTitle(name) {
    Promise.resolve(this.bridge.sessionTitle?.(this.threadId, name))
      .catch((error) => this.log('title mirror failed', error));
  }
  /** The prompt cache behind the context ring and the sidebar capsule (session-state.mjs). */
  async refreshCache() {
    if (!this.fold || this.cacheRefresh) return;
    this.cacheRefresh = (async () => {
      try {
        const value = await this.command({ type: 'get_cache_warming' });
        const cache = cacheFrom({ ...value, sessionId: this.sessionId });
        this.fold?.setCache(cache);
        this.bridge.rememberWarmth?.(this.threadId, cache);
      } catch { /* an engine without the warmer leaves the ring as it was */ }
    })().finally(() => { this.cacheRefresh = undefined; });
  }
  onState(state) {
    if (this.closed || !state) return;
    if (this.runtimeId === undefined) {
      // What the session did before we attached is history, not this stream. The session
      // state still reads it (a GUI restart reattaching keeps its agents and Speed Index).
      this.runtimeId = state.runtimeId;
      this.sequence = state.sequence ?? 0;
      for (const record of state.events ?? []) this.fold?.feed(record.event);
      return;
    }
    if (state.runtimeId !== this.runtimeId) {
      // The engine reloaded the session under a new worker; its sequence starts over.
      this.runtimeId = state.runtimeId;
      this.sequence = 0;
    }
    const records = (state.events ?? []).filter((record) => record.sequence > this.sequence);
    if (records.length && records[0].sequence !== this.sequence + 1)
      this.log('events skipped', `${this.sessionId} ${this.sequence}→${records[0].sequence}`);
    for (const record of records) {
      this.sequence = record.sequence;
      this.deliver(record.event);
    }
    if (state.status === 'unloaded' || state.status === 'error')
      void this.close(new Error(`Rubato session ${this.sessionId} ${state.status === 'error' ? 'failed' : 'was unloaded'}`));
  }
  deliver(event) {
    // The Agents panel, Speed Index and cache read the engine's own records, not the
    // rows this stream turns them into.
    this.fold?.feed(event);
    if (cacheMoved(event)) void this.refreshCache();
    // Rubato's title extension names the session from its topic; the thread shows that name
    // (V1 mirrorSessionTitle). A name T3 itself set comes back equal and changes nothing.
    if (event?.type === 'session_info_changed' && typeof event.name === 'string' && event.name.trim())
      this.mirrorTitle(event.name.trim());
    this.enqueue(() => this.process(event));
  }
  enqueue(step) {
    this.inbound = this.inbound.then(step).catch((error) => this.log('inbound step failed', error));
    return this.inbound;
  }
  emit(event) { if (!this.closed) this.onRecord(event); }
  async process(event) {
    if (event?.type === 'agent_settled') {
      // A Stop's cleanup writes into the turn, so it goes ahead of the settle that ends it.
      if (this.aborting) await this.aborting.catch(() => {});
      if (this.hold) return; // already waiting; the newer settle changes nothing
      if (event.aborted === true || this.stopping) { this.emit(event); return; }
      const labels = await this.awaitedLabels();
      if (labels.length === 0 || this.closed) { this.emit(event); return; }
      this.hold = { settled: event, id: `rubato-wait:${this.sessionId}:${++this.waits}`, detail: null };
      this.showHold(this.hold, labels);
      this.scheduleHoldCheck(this.hold, this.awaitTimings.pollMs);
      return;
    }
    if (event?.type === 'agent_start' && this.hold) this.endHold(false);
    // The agent's own records (context notes, task list, tool search) are not work the person
    // asked for: the turn's work summary leaves them out, as V1's work log did.
    if (/^tool_execution_(start|update|end)$/.test(event?.type ?? '') && isBookkeepingTool(event.toolName)) return;
    this.emit(event);
  }
  async awaitedLabels() {
    try {
      const answer = await this.command({ type: 'get_awaited_wakes' });
      const items = Array.isArray(answer?.items) ? answer.items : [];
      return [...new Set(items.map((item) => nonempty(item?.description) || nonempty(item?.id)).filter(Boolean))];
    } catch { return []; } // a runtime that cannot answer has nothing the turn should wait for
  }
  showHold(hold, labels) {
    const detail = labels.join(' · ');
    if (hold.detail === detail) return;
    const started = hold.detail === null;
    hold.detail = detail;
    const row = { toolCallId: hold.id, toolName: AWAIT_TITLE, args: { waitingOn: detail } };
    if (started) this.emit({ type: 'tool_execution_start', ...row });
    this.emit({ type: 'tool_execution_update', ...row,
      partialResult: { content: [{ type: 'text', text: `Waiting on ${detail}` }] } });
  }
  scheduleHoldCheck(hold, ms) {
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => { this.enqueue(() => this.checkHold(hold)); }, ms);
    hold.timer.unref?.();
  }
  async checkHold(hold) {
    if (this.hold !== hold || this.closed) return;
    const labels = await this.awaitedLabels();
    if (this.hold !== hold) return;
    if (labels.length > 0) {
      hold.emptySince = undefined;
      this.showHold(hold, labels);
      this.scheduleHoldCheck(hold, this.awaitTimings.pollMs);
      return;
    }
    if (hold.emptySince === undefined) {
      hold.emptySince = Date.now();
      this.scheduleHoldCheck(hold, this.awaitTimings.graceMs);
      return;
    }
    this.endHold(false);
    this.emit(hold.settled);
  }
  /** Closes the wait row; the turn carries on (a wake) or the caller lets the settle through. */
  endHold(interrupted) {
    const hold = this.hold;
    if (!hold) return null;
    clearTimeout(hold.timer);
    this.hold = null;
    this.emit({ type: 'tool_execution_end', toolCallId: hold.id, toolName: AWAIT_TITLE, args: { waitingOn: hold.detail },
      isError: interrupted, result: { content: [{ type: 'text', text: `${interrupted ? 'Stopped waiting' : 'Waited'} on ${hold.detail}` }] } });
    return hold;
  }
  /** Stop: abort, hand back what Pi never read, and end a held wait as interrupted. */
  async abort(record) {
    this.stopping = true;
    const aborting = (async () => {
      const result = await this.command(record);
      await this.returnStranded();
      return result;
    })();
    this.aborting = aborting;
    try { return await aborting; }
    finally {
      if (this.aborting === aborting) this.aborting = undefined;
      await this.enqueue(() => {
        this.stopping = false;
        const hold = this.endHold(true);
        if (hold) this.emit({ ...hold.settled, aborted: true });
      });
    }
  }
  async returnStranded() {
    let state;
    try { state = await this.command({ type: 'get_state' }); } catch { return; }
    if (!state || state.isStreaming || state.isCompacting || !(Number(state.pendingMessageCount) > 0)) return;
    const cleared = await this.command({ type: 'clear_queue' }).catch(() => null);
    const messages = queuedMessagesInOrder(state, cleared);
    if (messages.length === 0) return;
    // Straight out, not queued: the settle this Stop caused waits in the queue for this step.
    this.emit({ type: 'extension_ui_request', id: `rubato-stranded:${this.sessionId}:${++this.strandedNotices}`,
      method: 'notify', notifyType: 'warning',
      message: `${messages.length} message${messages.length === 1 ? '' : 's'} never reached the model before the turn stopped:\n${
        messages.map((text, index) => `${index + 1}. ${text}`).join('\n')}` });
  }
  /** The session this thread already runs in, asked once per connection; null when none. */
  async boundSession() {
    if (this.bound !== undefined) return this.bound;
    let bound = null;
    try { bound = (await this.bridge.boundSession?.(this.threadId)) ?? null; }
    catch (error) { this.log('binding lookup failed', error); }
    const serverId = this.bridge.descriptor?.serverId;
    // A cursor from another engine profile names a session this engine does not have.
    if (bound && bound.serverId && serverId && bound.serverId !== serverId) {
      this.log('binding from another engine ignored', `${this.threadId} ${bound.serverId}`);
      bound = null;
    }
    this.bound = bound?.sessionId ?? null;
    return this.bound;
  }
  async createSession() {
    const systemPrompt = this.bridge.pendingPrompts.get(this.threadId);
    const created = await this.bridge.viaInventory((client) => client.create({
      cwd: this.cwd, ...(systemPrompt ? { systemPrompt } : {}) }));
    this.bridge.pendingPrompts.delete(this.threadId);
    return created.sessionId;
  }
  async openThreadSession() {
    this.opening ??= (async () => {
      const bound = await this.boundSession();
      if (bound) {
        try {
          await this.attach(bound);
          // Its history is already in the model's context: T3's handoff of the same
          // messages is answered as delivered (RubatoPiDriver injectHistory).
          this.bridge.resumedSessions?.add(bound);
          return;
        } catch (error) {
          // A conversation the engine no longer has: start over, and T3's handoff
          // carries the history in the first prompt as it does for any provider.
          this.log('bound session unavailable', `${this.threadId} ${bound} ${error?.message ?? error}`);
        }
      }
      await this.attach(await this.createSession());
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  async command(record) {
    if (this.closed) throw new Error('Rubato connection is closed');
    if (!this.sessionId) await this.openThreadSession();
    const { id: _id, ...command } = record;
    // Only the step-rewind continue route's own message (it marks the thread right before it
    // sends): the same words typed by hand stay a prompt, and any other prompt drops the mark.
    if (command.type === 'prompt') {
      const continuing = this.bridge.stepContinues?.delete(this.threadId)
        && command.message === STEP_CONTINUE_TEXT && !command.images?.length;
      if (continuing) {
        // A step rewind's continue: no message for Pi, it runs on from the tool results.
        await this.client.command({ type: 'continue' });
        return { disposition: 'started' };
      }
    }
    if ((command.type === 'prompt' || command.type === 'steer') && typeof command.message === 'string') {
      const control = controlCommandFor(command.message);
      if (control) {
        if (command.type === 'steer') throw new Error(`Interrupt the current turn before /${control.name}`);
        return this.control(control);
      }
      command.message = rewriteSkillMentions(command.message, this.bridge.skillNames);
    }
    if (command.type === 'compact' && await this.compactCommandAvailable()) {
      // Rubato's compact picks the cut by mode (notes mode starts a new context window);
      // the cut it makes reports itself through compaction events.
      await this.client.command({ type: 'prompt', message: command.customInstructions ? `/compact ${command.customInstructions}` : '/compact' });
      return {};
    }
    if (command.type === 'set_model') { this.thinkingLevel = undefined; this.fastMode = undefined; }
    return this.client.command(command);
  }
  /** A control typed as a prompt; the adapter's turn for it settles once Pi reads idle. */
  async control(control) {
    if (control.name === 'rewind') {
      // T3 checks the count first so a refusal reaches the composer, then reverts once
      // this turn has settled (RubatoPiSessions.ts bindRubatoSessionLookup).
      if (!this.bridge.checkRewind) throw new Error('This server cannot rewind the conversation yet');
      await this.bridge.checkRewind(this.threadId, control.rpc.turns);
      void Promise.resolve(this.bridge.rewindConversation(this.threadId, { turns: control.rpc.turns }))
        .catch((error) => this.log('rewind failed', error));
      return { disposition: 'handled' };
    }
    if (control.name === 'compact') return this.command(control.rpc);
    await this.client.command(control.rpc);
    if (control.name === 'name') this.mirrorTitle(control.args);
    return { disposition: 'handled' };
  }
  /** Whether the engine has Rubato's compact command; the command list is fixed for an attach. */
  async compactCommandAvailable() {
    if (this.compactCommand !== undefined) return this.compactCommand;
    try {
      const { commands } = await this.client.command({ type: 'get_commands' });
      this.compactCommand = (commands ?? []).some((entry) => entry?.name === 'compact' && entry.source === 'extension');
    } catch { this.compactCommand = false; }
    return this.compactCommand;
  }
  /**
   * The picker's options upstream Pi has no field for (model-catalog-order.mjs optionDescriptorsFor).
   * T3 sends the Fast toggle on every turn, so the toggle is the answer; Pi remembers fast per
   * model, so compare against what Pi will send rather than the last value (V1 applyFast).
   */
  async applySelection(options) {
    const { thinking, fast } = applySelectionOptions(Array.isArray(options) ? options : []);
    if (thinking !== undefined && thinking !== this.thinkingLevel) {
      await this.client.command({ type: 'set_thinking_level', level: thinking });
      this.thinkingLevel = thinking;
    }
    if (fast === undefined) return {};
    let tier;
    try { tier = await this.client.command({ type: 'get_service_tier' }); } catch { /* an engine without it */ }
    const active = tier ? (tier.supported === true ? tier.active === true : fast) : this.fastMode;
    if (active !== fast) await this.client.command({ type: 'prompt', message: fast ? '/fast on' : '/fast off' });
    this.fastMode = fast;
    return {};
  }
  async request(record) {
    switch (record?.type) {
      case 'new_session':
        this.bridge.stepContinues?.delete(this.threadId);
        // A second registration on this connection wants a fresh conversation, unless
        // the thread already has one: that is the thread's, whichever path asked.
        await this.attach((this.sessionId === null ? await this.boundSession() : null) ?? await this.createSession());
        return { cancelled: false };
      case 'switch_session':
        // Not a new conversation: the adapter reattaches the thread's own session this way, as
        // after a GUI restart, and a Continue on its way must still find its mark.
        await this.attach(record.sessionPath);
        return { cancelled: false };
      case 'get_state': {
        const state = await this.command(record);
        return state && typeof state === 'object'
          ? { ...state, sessionFile: this.sessionId, rubatoSessionFile: state.sessionFile } : state;
      }
      case 'abort':
        return this.abort(record);
      case 'rubato_selection':
        if (!this.sessionId) await this.openThreadSession();
        return this.applySelection(record.options);
      case 'fork': {
        // Upstream rolls back with Pi's fork. On the engine a fork re-keys the runtime every
        // attachment shares, so the session other windows hold would move to the copy. The
        // engine rewinds in place instead: same session, its children and teams stay
        // (bridge rollbackThread did the same on V1).
        if (typeof record.entryId !== 'string' || !record.entryId) throw new Error('A rollback must name where it cuts');
        const reply = replyBefore(activeBranch(await this.command({ type: 'get_entries' })), record.entryId);
        const result = await this.command({ type: 'rewind', keep: reply ? [reply] : [], skip: 0 });
        return { cancelled: result?.cancelled === true };
      }
      default:
        return this.command(record);
    }
  }
  send(record) {
    if (record?.type === 'extension_ui_response') {
      const { type: _type, ...response } = record;
      this.client.reply(response).catch((error) => this.log('ui reply failed', error));
      return;
    }
    this.request(record).then(
      (data) => { if (!this.closed) this.onRecord({ type: 'response', command: record.type, success: true, ...(data === undefined ? {} : { data }) }); },
      (error) => { if (!this.closed) this.onRecord({ type: 'response', command: record.type, success: false, error: String(error?.message ?? error) }); },
    );
  }
  async close(error) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.hold?.timer);
    try { await this.unsubscribe?.(); } catch { /* the engine may be gone */ }
    if (this.sessionId) await this.client?.detach().catch(() => {});
    await this.client?.close().catch(() => {});
    this.onClosed(error);
  }
}
