import { randomUUID } from 'node:crypto';
import { RemoteServiceProvider, createRemoteServiceEndpoint, replicatedState, RemoteServiceError } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createUnixServer } from '@earendil-works/pi-server/unix';
import { Directory, Management, Control, COMMANDS, INPUT_COMMANDS, UI_METHODS, json } from './contracts.mjs';
import { SessionFiles } from './session-files.mjs';
import { RpcWorker } from './rpc-worker.mjs';

const invalid = (message) => new RemoteServiceError('service_invalid_value', message);
function endpoint(entries) {
  const provider = new RemoteServiceProvider(entries.map(([service]) => service));
  for (const [service, implementation] of entries) provider.provide(service, implementation);
  const routed = createRemoteServiceEndpoint(provider);
  return { invokeService: routed.invoke.bind(routed), release() { routed.dispose(); provider.dispose(); } };
}

/** Owns ONE runtime handle acquired by the official SessionRouter. */
class RuntimeHandle {
  constructor(metadata, worker, { idleMs, changed }) {
    this.metadata = metadata;
    this.worker = worker;
    this.idleMs = idleMs;
    this.changed = changed;
    this.attachments = 0;
    this.calls = 0;
    this.running = true; // Until the first authoritative state is available.
    this.pendingUi = new Map();
    this.uiTimers = new Map();
    this.closed = false;
    this.state = replicatedState({ sessionId: metadata.id, runtimeId: worker.id, status: 'starting',
      sequence: 0, events: [], pendingUi: [] });
    this.terminated = new Promise((resolve) => { this.finish = resolve; });
    worker.on('event', (event) => this.onEvent(event));
    worker.terminated.then((error) => {
      this.closed = true;
      clearTimeout(this.timer);
      for (const timer of this.uiTimers.values()) clearTimeout(timer);
      this.uiTimers.clear();
      this.state.state.status = error ? 'error' : 'unloaded';
      this.state.publish(BACKGROUND_CONTEXT);
      this.finish(error);
      this.changed();
    });
  }
  async start() {
    this.acceptState(await this.worker.start());
    return this;
  }
  publish() {
    this.state.state.status = this.closed ? 'unloaded' : this.running ? 'running' : this.pendingUi.size ? 'waiting' : 'idle';
    this.state.state.pendingUi = [...this.pendingUi.values()].map(json);
    this.state.publish(BACKGROUND_CONTEXT);
    this.changed();
  }
  acceptState(value) {
    if (value.sessionId !== this.metadata.id) throw new Error('A runtime cannot switch the persisted session behind its route');
    this.running = Boolean(value.isStreaming || value.isCompacting || value.pendingMessageCount);
    this.latestState = json(value);
    this.publish();
    this.scheduleUnload();
  }
  onEvent(event) {
    if (this.closed) return;
    const sequence = ++this.state.state.sequence;
    this.state.state.events.push({ sequence, event: json(event) });
    if (this.state.state.events.length > 256) this.state.state.events.shift();
    if (event.type === 'agent_start' || event.type === 'auto_compaction_start' || event.type === 'auto_retry_start') this.running = true;
    if (event.type === 'extension_ui_request' && UI_METHODS.has(event.method)) {
      this.pendingUi.set(event.id, event);
      if (Number.isFinite(event.timeout) && event.timeout > 0) {
        const timer = setTimeout(() => { this.pendingUi.delete(event.id); this.uiTimers.delete(event.id); this.publish(); this.scheduleUnload(); }, event.timeout);
        this.uiTimers.set(event.id, timer);
      }
    }
    this.publish();
    // agent_end alone is not quiescence: Pi may still drain a queued follow-up.
    if (event.type === 'agent_settled' || event.type === 'auto_compaction_end' || event.type === 'auto_retry_end') {
      void this.refresh().catch((error) => { this.lastError = error; });
    }
  }
  async refresh() {
    this.calls++;
    try { this.acceptState(await this.worker.request({ type: 'get_state' })); }
    finally { this.calls--; this.scheduleUnload(); }
  }
  scheduleUnload() {
    clearTimeout(this.timer);
    if (this.closed || this.attachments || this.calls || this.running || this.pendingUi.size || this.idleMs === null) return;
    this.timer = setTimeout(() => {
      if (!this.attachments && !this.calls && !this.running && !this.pendingUi.size) void this.close();
    }, this.idleMs);
    this.timer.unref?.();
  }
  async command(command) {
    if (!command || !COMMANDS.has(command.type)) throw invalid('Unsupported command for an attached session');
    if (this.closed) throw invalid('Runtime is unloading; attach again');
    this.calls++;
    clearTimeout(this.timer);
    if (INPUT_COMMANDS.has(command.type) || command.type === 'compact') { this.running = true; this.publish(); }
    try {
      const response = await this.worker.request(json(command));
      if (command.type === 'get_state') this.acceptState(response);
      else if (!command.type.startsWith('get_')) await this.refresh();
      return response;
    } catch (error) {
      // Failed preflight must not leave a permanently 'running' projection.
      await this.refresh().catch(() => {});
      throw error;
    } finally {
      this.calls--;
      this.scheduleUnload();
    }
  }
  async snapshot() {
    this.calls++;
    try {
      const before = this.state.value.sequence;
      const [state, messages] = await Promise.all([this.worker.request({ type: 'get_state' }), this.worker.request({ type: 'get_messages' })]);
      this.acceptState(state);
      return json({ sessionId: this.metadata.id, runtimeId: this.worker.id, state, messages: messages.messages ?? messages,
        before, sequence: this.state.value.sequence, pendingUi: [...this.pendingUi.values()] });
    } finally { this.calls--; this.scheduleUnload(); }
  }
  async reply(response) {
    const request = response && this.pendingUi.get(response.id);
    if (!request) throw invalid('UI request is absent, expired, or already answered');
    const cancelled = response.cancelled === true;
    if (!cancelled && request.method === 'confirm' && typeof response.confirmed !== 'boolean') throw invalid('Confirmation requires a boolean');
    if (!cancelled && request.method !== 'confirm' && typeof response.value !== 'string') throw invalid('Question requires a string');
    if (!cancelled && request.method === 'select' && !request.options.includes(response.value)) throw invalid('Answer is not one of the offered options');
    this.worker.reply(cancelled ? { id: request.id, cancelled: true } : request.method === 'confirm'
      ? { id: request.id, confirmed: response.confirmed } : { id: request.id, value: response.value });
    this.pendingUi.delete(request.id);
    clearTimeout(this.uiTimers.get(request.id)); this.uiTimers.delete(request.id);
    this.publish();
    // Query the runtime after it has accepted the response; never assume replying
    // means its original prompt has already finished.
    await this.refresh();
    return null;
  }
  attachClient() {
    if (this.closed) throw invalid('Runtime is unloading; attach again');
    this.attachments++;
    clearTimeout(this.timer);
    const routed = endpoint([[Control, { state: this.state,
      command: async (command) => this.command(command), snapshot: async () => this.snapshot(), reply: async (value) => this.reply(value) }]]);
    let released = false;
    this.changed();
    return { invokeService: routed.invokeService, release: () => {
      if (released) return;
      released = true; routed.release(); this.attachments--; this.changed(); this.scheduleUnload();
    } };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearTimeout(this.timer);
    this.closePromise = this.worker.stop();
    return this.closePromise;
  }
}

/** Business adapter; the official router alone deduplicates runtime acquisition.
 * handles is a status projection/administrative view, NOT a session registry. */
export function createSessionHost({ sessionsDir, serverId, idleMs = 60000,
  workerFactory = (metadata) => new RpcWorker(metadata), pollMs = 2000, onError = () => {} } = {}) {
  if (idleMs !== null && (!Number.isFinite(idleMs) || idleMs < 0)) throw new TypeError('Invalid idleMs');
  const files = new SessionFiles(sessionsDir);
  const handles = new Map();
  const directory = replicatedState({ revision: 0, sessions: [] });
  let records = [];
  let refreshing;
  let stopped = false;
  const metrics = { runtimeStarts: 0, lists: 0, totalOpenMs: 0 };
  const publish = () => {
    directory.state.sessions = records.map(({ file: _file, id, ...item }) => {
      const handle = handles.get(id);
      return { ...item, sessionId: id, serverId, runtimeId: handle?.closed ? null : handle?.worker.id ?? null,
        status: handle?.closed ? 'stored' : handle?.state.value.status ?? 'stored', attachments: handle?.attachments ?? 0 };
    });
    directory.state.revision++;
    directory.publish(BACKGROUND_CONTEXT);
  };
  const refresh = () => refreshing ??= (async () => { metrics.lists++; records = await files.list(); publish(); return directory.value; })()
    .finally(() => { refreshing = undefined; });
  const host = {
    metrics,
    directory,
    async resolveSession(id) { return files.resolve(id); },
    async openSession(metadata) {
      const began = performance.now();
      const handle = new RuntimeHandle(metadata, workerFactory(metadata), { idleMs, changed: publish });
      try { await handle.start(); } catch (error) { await handle.close(); throw error; }
      metrics.runtimeStarts++; metrics.totalOpenMs += performance.now() - began;
      handles.set(metadata.id, handle);
      handle.terminated.then(() => { if (handles.get(metadata.id) === handle) handles.delete(metadata.id); publish(); });
      publish();
      return handle;
    },
    serverServices: {
      attachClient(presentation) {
        return endpoint([
          [Directory, { state: directory, list: async () => (await refresh()).sessions }],
          [Management, {
            create: async (options) => {
              const created = await files.create(options);
              if (refreshing) await refreshing; // Do not reuse a scan begun before creation.
              await refresh();
              return directory.value.sessions.find((item) => item.sessionId === created.id);
            },
            attach: async (id, context) => { await presentation.attachSession(id, context); return null; },
            detach: async (context) => { await presentation.detachSession(context); return null; },
            unload: async (id) => {
              const handle = handles.get(id);
              if (!handle) { await files.resolve(id); return null; }
              if (handle.running || handle.calls || handle.attachments || handle.pendingUi.size) throw invalid('Only idle, unattached sessions may be unloaded');
              await handle.close(); return null;
            },
          }],
        ]);
      },
    },
    async start() {
      await refresh();
      if (pollMs > 0) { this.poller = setInterval(() => { if (!stopped) void refresh().catch(onError); }, pollMs); this.poller.unref?.(); }
    },
    async close() {
      stopped = true; clearInterval(this.poller);
      await Promise.all([...handles.values()].map((handle) => handle.close()));
    },
  };
  return host;
}

export async function startSessionServer(options) {
  const serverId = options.serverId ?? randomUUID();
  const host = createSessionHost({ ...options, serverId });
  const server = createUnixServer(host, { path: options.socketPath, serverId, mode: 0o600, onError: options.onError,
    maxFrameLength: 32 * 1024 * 1024 });
  try { await host.start(); await server.start(); }
  catch (error) { await server.close().catch(() => {}); await host.close(); throw error; }
  let closing;
  return { host, server, serverId, close: () => closing ??= (async () => { await server.close(); await host.close(); })() };
}
