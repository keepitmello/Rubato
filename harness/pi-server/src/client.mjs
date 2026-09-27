import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import { createRemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Directory, Management, Control } from './contracts.mjs';

/** One presentation attachment; disconnect never stops the runtime. */
export class SessionClient {
  constructor({ socketPath, serverId, timeoutMs = 30000, sessionTimeoutMs = 0, onError = () => {} }) {
    this.timeoutMs = timeoutMs;
    // Session control waits on the agent. A 30s AbortSignal cancelled in-flight
    // prompt/snapshot, dropped the attachment, and T3 showed both
    // "The operation was aborted due to timeout" and "No session is attached"
    // while the turn was still running. Directory/management stay bounded.
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.onError = onError;
    this.socketPath = socketPath;
    this.serverId = serverId;
    this.client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path: socketPath }),
      maxFrameLength: 32 * 1024 * 1024, onListenerError: onError });
    this.bindings = new Set();
    this.bindingDisposals = new WeakMap();
    this.closed = false;
  }
  async connect() {
    if (this.closed) throw new Error('SessionClient is closed');
    await this.client.connect(); return this;
  }
  call(service, member, args, session = false) {
    const target = session ? this.client.attachment : { serverId: this.client.serverId };
    if (!target) return Promise.reject(new Error('No session is attached'));
    const timeoutMs = session ? this.sessionTimeoutMs : this.timeoutMs;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    return this.client.request(target, { serviceId: service.id, member, args: JSON.parse(JSON.stringify(args)) }, signal);
  }
  list() { return this.call(Directory, 'list', []); }
  transcript(id) { return this.call(Directory, 'transcript', [id]); }
  catalogue(cwd) { return this.call(Directory, 'catalogue', [cwd]); }
  create(options) { return this.call(Management, 'create', [options]); }
  attach(id) { return this.call(Management, 'attach', [id]); }
  detach() { return this.call(Management, 'detach', []); }
  unload(id) { return this.call(Management, 'unload', [id]); }
  command(command) { return this.call(Control, 'command', [command], true); }
  snapshot() { return this.call(Control, 'snapshot', [], true); }
  reply(response) { return this.call(Control, 'reply', [response], true); }
  async subscribe(service, listener, session = false) {
    const target = session ? this.client.attachment : { serverId: this.client.serverId };
    if (!target) throw new Error('No session is attached');
    const binding = createRemoteServiceBinding({ services: [service],
      transport: createClientServiceTransport(this.client, () => target), onError: this.onError });
    this.bindings.add(binding);
    const implementation = binding.use(service);
    await binding.rebind(true, BACKGROUND_CONTEXT);
    const unsubscribe = implementation.state.subscribe(listener);
    return async () => { unsubscribe(); await this.disposeBinding(binding); };
  }
  subscribeDirectory(listener) { return this.subscribe(Directory, listener); }
  subscribeSession(listener) { return this.subscribe(Control, listener, true); }
  async reconnect(id) {
    if (this.closed) throw new Error('SessionClient is closed');
    await this.clearBindings(); this.client.disconnect(); await this.client.reconnect();
    if (id) await this.attach(id);
    return id ? this.snapshot() : null;
  }
  disposeBinding(binding) {
    let disposal = this.bindingDisposals.get(binding);
    if (!disposal) {
      disposal = Promise.resolve().then(() => binding.dispose()).finally(() => this.bindings.delete(binding));
      this.bindingDisposals.set(binding, disposal);
    }
    return disposal;
  }
  async clearBindings() { await Promise.all([...this.bindings].map(binding => this.disposeBinding(binding))); }
  /** Drop a disconnected client whose transport address is obsolete. No live transport or runtime is owned here. */
  async abandon() {
    if (this.closed) return;
    this.closed = true;
    await this.clearBindings();
    this.client.disconnect();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.clearBindings();
    if (!this.client.disposed) await this.client.dispose();
  }
}
