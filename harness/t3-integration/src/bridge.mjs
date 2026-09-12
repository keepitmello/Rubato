import { randomUUID } from 'node:crypto';
import { SessionClient } from '../../pi-server/src/client.mjs';
import { readDescriptor } from '../../pi-server/src/profile-server.mjs';
import { EventProjection, importedId, textOf } from './events.mjs';

const copy = (value) => JSON.parse(JSON.stringify(value));
export class RubatoPiBridge {
  constructor({ descriptorPath, instanceId, emit = () => {}, onError = () => {}, projectedMessages = async () => [] }) {
    Object.assign(this, { descriptorPath, instanceId, emit, onError, projectedMessages });
    this.sessions = new Map(); this.openings = new Map(); this.catalogues = new Map(); this.closed = false;
    this.retryTimer = setInterval(() => { void this.recover().catch(onError); }, 1000);
    this.retryTimer.unref?.();
  }
  async connection() {
    if (this.closed) throw new Error('T3 bridge is closed');
    if (this.inventoryClient?.client.connected) return this.inventoryClient;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.inventoryClient?.close();
      this.descriptor = await readDescriptor(this.descriptorPath);
      this.inventoryClient = await new SessionClient({ ...this.descriptor, onError: this.onError }).connect();
      return this.inventoryClient;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async inventory() { return (await this.connection()).list(); }
  async transcript(id) { return (await this.connection()).transcript(id); }
  async catalogue(cwd) {
    const cached = this.catalogues.get(cwd);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const value = (await this.connection()).catalogue(cwd);
    this.catalogues.set(cwd, { at: Date.now(), value });
    try { return await value; } catch (error) { this.catalogues.delete(cwd); throw error; }
  }
  cursor(sessionId) { return { kind: 'rubato-pi', serverId: this.descriptor.serverId, sessionId }; }
  importedMessages(sessionId, messages) {
    return messages.filter((message) => ['user', 'assistant'].includes(message.role)).map((message) => ({
      id: importedId(this.instanceId, sessionId, message), role: message.role, text: textOf(message),
      createdAt: new Date(message.timestamp).toISOString(),
    }));
  }
  async startSession(input) {
    if (input.runtimeMode !== 'full-access') throw new Error('Rubato preserves its existing tool policy; T3 approval modes are not implemented. Select Full access.');
    if (this.sessions.has(input.threadId)) return copy(this.sessions.get(input.threadId).session);
    if (this.openings.has(input.threadId)) return this.openings.get(input.threadId);
    const opening = this.open(input).finally(() => this.openings.delete(input.threadId));
    this.openings.set(input.threadId, opening); return opening;
  }
  async open(input) {
    const inventory = await this.connection();
    let sessionId;
    if (input.resumeCursor !== undefined && input.resumeCursor !== null) {
      const cursor = input.resumeCursor;
      if (cursor.kind !== 'rubato-pi' || cursor.serverId !== this.descriptor.serverId || typeof cursor.sessionId !== 'string')
        throw new Error('Resume cursor does not belong to this Pi server');
      sessionId = cursor.sessionId;
    } else {
      sessionId = (await inventory.create({ cwd: input.cwd, title: input.title })).sessionId;
    }
    const client = await new SessionClient({ ...this.descriptor, onError: this.onError }).connect();
    const context = { client, sessionId, projection: new EventProjection({ threadId: input.threadId, sessionId,
      instanceId: this.instanceId, emit: this.emit }), session: {
      provider: 'rubato-pi', providerInstanceId: this.instanceId, threadId: input.threadId, runtimeMode: input.runtimeMode,
      status: 'connecting', ...(input.cwd ? { cwd: input.cwd } : {}), resumeCursor: this.cursor(sessionId),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, sequence: 0, queue: Promise.resolve(), stopped: false };
    try {
      this.sessions.set(input.threadId, context);
      await client.attach(sessionId);
      await this.synchronize(context);
      if (!input.resumeCursor && input.modelSelection) await this.selectModel(context, input.modelSelection);
      return copy(context.session);
    } catch (error) { this.sessions.delete(input.threadId); context.stopped = true; await client.close(); throw error; }
  }
  async synchronize(context) {
    if (context.syncing) return context.syncing;
    context.syncing = (async () => {
      await context.unsubscribe?.();
      const buffered = [];
      let loading = true;
      context.unsubscribe = await context.client.subscribeSession((state) => {
        if (loading) { buffered.push(state); return; }
        this.applyState(context, state);
      });
      context.projection.seed(await this.projectedMessages(context.session.threadId));
      const snapshot = await context.client.snapshot();
      if (context.runtimeId && context.runtimeId !== snapshot.runtimeId) {
        context.projection.interrupted = true; context.projection.settle();
      }
      context.runtimeId = snapshot.runtimeId;
      context.sequence = snapshot.sequence;
      context.projection.event('session.started', { resume: context.session.resumeCursor });
      if (snapshot.state.isStreaming) context.projection.begin();
      snapshot.messages.forEach((message, index) => context.projection.message(message,
        !(snapshot.state.isStreaming && index === snapshot.messages.length - 1 && !message.stopReason)));
      for (const request of snapshot.pendingUi) context.projection.question(request);
      context.session.status = snapshot.state.isStreaming ? 'running' : 'ready';
      if (snapshot.state.model) context.session.model = `${snapshot.state.model.provider}/${snapshot.state.model.id}`;
      this.stateEvent(context);
      loading = false;
      for (const state of buffered) if (state.sequence > snapshot.sequence) this.applyState(context, state);
      return snapshot;
    })().finally(() => { context.syncing = undefined; });
    return context.syncing;
  }
  stateEvent(context) {
    context.session.updatedAt = new Date().toISOString();
    if (context.projection.turnId) context.session.activeTurnId = context.projection.turnId;
    else delete context.session.activeTurnId;
    context.projection.event('session.state.changed', { state: context.session.status === 'ready' ? 'ready'
      : context.session.status === 'connecting' ? 'starting' : context.session.status === 'closed' ? 'stopped' : context.session.status });
  }
  applyState(context, state) {
    if (context.stopped || state.runtimeId !== context.runtimeId) return;
    const records = state.events.filter((record) => record.sequence > context.sequence);
    if (records.length && records[0].sequence !== context.sequence + 1) {
      context.needsSync = true; return;
    }
    for (const record of records) {
      context.projection.project(record.event); context.sequence = record.sequence;
    }
    for (const request of state.pendingUi) context.projection.question(request);
    const next = ['error', 'unloaded'].includes(state.status) ? 'error' : state.status === 'running' || state.status === 'waiting' ? 'running' : 'ready';
    if (context.session.status !== next || context.session.activeTurnId !== context.projection.turnId) {
      context.session.status = next; this.stateEvent(context);
    }
  }
  async recover() {
    if (this.closed || this.recovering) return;
    this.recovering = true;
    try {
      for (const context of this.sessions.values()) {
        if (context.stopped || context.syncing) continue;
        try {
          if (!context.client.client.connected || !context.client.client.attachment) {
            const descriptor = await readDescriptor(this.descriptorPath);
            if (descriptor.serverId !== context.session.resumeCursor.serverId) throw new Error('Pi server identity changed; refusing automatic redirection');
            await context.client.close();
            context.client = await new SessionClient({ ...descriptor, onError: this.onError }).connect();
            await context.client.attach(context.sessionId);
            await this.synchronize(context);
          } else if (context.needsSync) { context.needsSync = false; await this.synchronize(context); }
        } catch (error) {
          if (context.session.status !== 'error') { context.session.status = 'error'; this.stateEvent(context); }
          this.onError(error);
        }
      }
    } finally { this.recovering = false; }
  }
  require(threadId) {
    const context = this.sessions.get(threadId);
    if (!context || context.stopped) throw new Error(`No Pi attachment for ${threadId}`);
    return context;
  }
  async selectModel(context, selection) {
    const split = selection.model.indexOf('/');
    if (split < 1) throw new Error('Pi model must be provider/modelId');
    const provider = selection.model.slice(0, split); const modelId = selection.model.slice(split + 1);
    if (selection.model !== context.session.model) {
      if (context.session.status === 'running') throw new Error('Wait for this turn to settle before changing its model');
      await context.client.command({ type: 'set_model', provider, modelId });
      context.session.model = selection.model;
    }
    for (const option of selection.options ?? []) {
      if (option.id !== 'thinking' || typeof option.value !== 'string') throw new Error(`Unsupported Pi option: ${option.id}`);
      const { levels } = await context.client.command({ type: 'get_available_thinking_levels' });
      if (!levels.includes(option.value)) throw new Error('Thinking level is not supported by this model');
      await context.client.command({ type: 'set_thinking_level', level: option.value });
    }
    context.projection.event('session.configured', { config: { model: context.session.model } });
  }
  sendTurn(input) {
    const context = this.require(input.threadId);
    const operation = context.queue.then(async () => {
      if (context.stopped) throw new Error('Attachment closed before send');
      if (input.attachments?.length) throw new Error('T3 file/image attachments are not supported by this integration');
      if (!input.input?.trim()) throw new Error('A non-empty prompt is required');
      if (input.interactionMode === 'plan') throw new Error('T3 plan mode is not mapped to Rubato policy');
      if (input.modelSelection) await this.selectModel(context, input.modelSelection);
      const running = context.session.status === 'running';
      const turnId = context.projection.begin();
      context.session.status = 'running'; this.stateEvent(context);
      try { await context.client.command({ type: running ? 'steer' : 'prompt', message: input.input }); }
      catch (error) {
        if (!running) { context.projection.failed = true; context.projection.settle(); context.session.status = 'ready'; this.stateEvent(context); }
        throw error;
      }
      return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
    });
    context.queue = operation.catch(() => {}); return operation;
  }
  async interruptTurn(threadId) {
    const context = this.require(threadId); context.projection.interrupted = true;
    await context.client.command({ type: 'abort' });
    context.projection.settle(); context.session.status = 'ready'; this.stateEvent(context);
  }
  async respondToRequest(threadId, requestId, decision) {
    const context = this.require(threadId);
    const question = context.projection.questions.get(requestId);
    if (question?.method !== 'confirm') throw new Error('No pending confirmation with this ID');
    if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Only one-time approval is supported');
    await context.client.reply(decision === 'cancel' ? { id: requestId, cancelled: true } : { id: requestId, confirmed: decision === 'accept' });
    context.projection.questions.delete(requestId);
    context.projection.event('request.resolved', { requestType: 'mcp_elicitation_approval', decision }, { requestId });
  }
  async respondToUserInput(threadId, requestId, answers) {
    const context = this.require(threadId);
    if (!context.projection.questions.has(requestId)) throw new Error('No pending question with this ID');
    let value = answers[requestId];
    if (Array.isArray(value) && value.length === 1) value = value[0];
    if (value && typeof value === 'object' && Array.isArray(value.answers) && value.answers.length === 1) value = value.answers[0];
    if (typeof value !== 'string') throw new Error('This Pi question expects exactly one text answer');
    await context.client.reply({ id: requestId, value });
    context.projection.questions.delete(requestId);
    context.projection.event('user-input.resolved', { answers }, { requestId });
  }
  listSessions() { return [...this.sessions.values()].map((context) => copy(context.session)); }
  hasSession(threadId) { return this.sessions.has(threadId); }
  async readThread(threadId) {
    const context = this.require(threadId); const snapshot = await context.client.snapshot();
    return { threadId, turns: [{ id: context.projection.turnId ?? `pi-history:${context.sessionId}`, items: snapshot.messages }] };
  }
  async stopSession(threadId) {
    await this.openings.get(threadId)?.catch(() => {});
    const context = this.sessions.get(threadId);
    if (!context) return;
    context.stopped = true; this.sessions.delete(threadId);
    await context.client.close();
    context.projection.event('session.exited', { exitKind: 'graceful', recoverable: true, reason: 'Presentation detached; Pi work is unchanged' });
  }
  async close() {
    this.closed = true; clearInterval(this.retryTimer);
    await Promise.allSettled([...this.openings.values()]);
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId)));
    await this.inventoryClient?.close();
  }
}
export const createBridge = (options) => new RubatoPiBridge(options);
