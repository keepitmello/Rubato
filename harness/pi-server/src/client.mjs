import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import { createRemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Directory, Management, Control } from './contracts.mjs';

/** One presentation attachment; disconnect never stops the runtime. */
export class SessionClient {
  constructor({ socketPath, serverId, timeoutMs = 30000, onError = () => {} }) {
    this.timeoutMs = timeoutMs;
    this.onError = onError;
    this.client = new Client({ serverId, transportFactory: createUnixTransportFactory({ path: socketPath }),
      maxFrameLength: 32 * 1024 * 1024, onListenerError: onError });
    this.bindings = new Set();
  }
  async connect() { await this.client.connect(); return this; }
  call(service, member, args, session = false) {
    const target = session ? this.client.attachment : { serverId: this.client.serverId };
    if (!target) return Promise.reject(new Error('No session is attached'));
    return this.client.request(target, { serviceId: service.id, member, args: JSON.parse(JSON.stringify(args)) }, AbortSignal.timeout(this.timeoutMs));
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
    return async () => { unsubscribe(); this.bindings.delete(binding); await binding.dispose(); };
  }
  subscribeDirectory(listener) { return this.subscribe(Directory, listener); }
  subscribeSession(listener) { return this.subscribe(Control, listener, true); }
  async reconnect(id) {
    await this.clearBindings(); this.client.disconnect(); await this.client.reconnect();
    if (id) await this.attach(id);
    return id ? this.snapshot() : null;
  }
  async clearBindings() { await Promise.all([...this.bindings].map((binding) => binding.dispose())); this.bindings.clear(); }
  async close() { await this.clearBindings(); await this.client.dispose(); }
}
