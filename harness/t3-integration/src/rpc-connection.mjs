import { SessionClient } from '../../pi-server/src/client.mjs';
import { rewriteSkillMentions } from './commands.mjs';

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
 * attaches to an existing one. The native thread id the adapter keeps is the engine's
 * session id: `get_state` reports it as `sessionFile` (the field the adapter reads as
 * the id `switch_session` takes); Pi's real file path rides along as `rubatoSessionFile`.
 */
export class RubatoRpcConnection {
  constructor(bridge, { threadId, cwd, onRecord, onClosed = () => {}, log = () => {} }) {
    Object.assign(this, { bridge, threadId, cwd, onRecord, onClosed, log });
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
    this.unsubscribe = await this.client.subscribeSession((state) => this.onState(state));
  }
  onState(state) {
    if (this.closed || !state) return;
    if (this.runtimeId === undefined) {
      // What the session did before we attached is history, not this stream.
      this.runtimeId = state.runtimeId;
      this.sequence = state.sequence ?? 0;
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
      this.onRecord(record.event);
    }
    if (state.status === 'unloaded' || state.status === 'error')
      void this.close(new Error(`Rubato session ${this.sessionId} ${state.status === 'error' ? 'failed' : 'was unloaded'}`));
  }
  command(record) {
    if (this.closed) return Promise.reject(new Error('Rubato connection is closed'));
    if (!this.sessionId) return Promise.reject(new Error('No Rubato session is attached'));
    const { id: _id, ...command } = record;
    if (command.type === 'prompt' && typeof command.message === 'string')
      command.message = rewriteSkillMentions(command.message, this.bridge.skillNames);
    return this.client.command(command);
  }
  async request(record) {
    switch (record?.type) {
      case 'new_session': {
        const systemPrompt = this.bridge.pendingPrompts.get(this.threadId);
        const created = await this.bridge.viaInventory((client) => client.create({
          cwd: this.cwd, ...(systemPrompt ? { systemPrompt } : {}) }));
        this.bridge.pendingPrompts.delete(this.threadId);
        await this.attach(created.sessionId);
        return { cancelled: false };
      }
      case 'switch_session':
        await this.attach(record.sessionPath);
        return { cancelled: false };
      case 'get_state': {
        const state = await this.command(record);
        return state && typeof state === 'object'
          ? { ...state, sessionFile: this.sessionId, rubatoSessionFile: state.sessionFile } : state;
      }
      case 'fork':
        // On the engine a fork re-keys the runtime every attachment shares; the session
        // other windows hold would move with it.
        throw new Error('Rubato forks conversations through the engine, not on an attached session');
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
    try { await this.unsubscribe?.(); } catch { /* the engine may be gone */ }
    if (this.sessionId) await this.client?.detach().catch(() => {});
    await this.client?.close().catch(() => {});
    this.onClosed(error);
  }
}
