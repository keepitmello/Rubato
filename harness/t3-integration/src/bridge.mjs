import { SessionClient } from '../../pi-server/src/client.mjs';
import { readDescriptor } from '../../pi-server/src/descriptor.mjs';
import { ensureProfileEngine } from '../../pi-server/src/discovery.mjs';
import { EventProjection, importedId, textOf } from './events.mjs';
import { applySelectionOptions, catalogForPicker } from './model-catalog-order.mjs';
import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// 소켓이 끊기면 pi-client 는 이 문구들로 던진다. 서버가 다시 떠도 이미 만들어 둔
// 클라이언트는 되살아나지 않으니, 붙잡고 있던 것을 버리고 새 연결로 한 번 더 친다.
const TRANSPORT_FAILURE = /transport closed|not connected|ECONNREFUSED|ECONNRESET|EPIPE|socket (?:closed|hang)/i;
// 세션 디렉터리에는 사람이 연 대화만 쌓이지 않는다. 벤치·프로브·스모크가
// 임시 폴더에서 같은 엔진을 돌리고, 그 폴더는 곧 사라진다. T3 는 세션의 cwd
// 로 프로젝트를 만들기 때문에, 그것을 그대로 넘기면 사이드바에 열 수도 없는
// 프로젝트가 생긴다. 사용자가 지웠던 'xai-priority-bench', 'proj-verify',
// 'cwd' 프로젝트가 그렇게 생긴 것이다.
//
// 판단은 구조만 본다. 그 폴더가 아직 있는가, 임시 폴더인가. 첫 메시지 문구로
// 기계를 맞히려 들지 않는다 — 프롬프트가 바뀌면 사람 대화를 지운다.
// 지금 살아 있는 세션과 앱이 방금 만든 세션은 무조건 남긴다.
const LIVE_STATUS = new Set(['running', 'waiting', 'starting']);
const temporaryRoots = () => {
  const roots = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', os.tmpdir()];
  try { roots.push(realpathSync(os.tmpdir())); } catch { /* 없으면 그대로 */ }
  return [...new Set(roots)];
};
const insideTemporary = (cwd) => temporaryRoots().some((root) => cwd === root || cwd.startsWith(`${root}/`));
export function userStartedSession(entry) {
  if (entry?.runtimeId && LIVE_STATUS.has(entry.status)) return true;
  const cwd = entry?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  if (insideTemporary(cwd)) return false;
  // statSync 다. Github-repos/agent-taskforce 와 Rubato 는 심볼릭 링크라서
  // lstat 으로 보면 폴더가 아니고, 실제 대화 146 개가 통째로 사라졌다.
  try { return statSync(cwd).isDirectory(); } catch { return false; }
}
function nodeMajor(bin) {
  try { return Number(String(execFileSync(bin, ['-v'], { encoding: 'utf8' })).replace(/^v/, '').split('.')[0]); }
  catch { return 0; }
}
// Pi 서버는 진짜 Node 로 띄워야 한다. 이 코드가 Electron 안에서 돌 때
// execPath 를 그대로 쓰면 서버는 뜨지만 카탈로그 요청이 30초 타임아웃으로
// 죽는다(같은 요청이 Node 서버에서는 4.6초에 230개를 돌려준다).
// rubato CLI 가 고른 Node 를 먼저 쓰고, 없으면 흔한 자리를 훑는다.
function resolveNode() {
  if (!process.versions.electron) return process.execPath;
  const home = os.homedir();
  const candidates = [];
  try { candidates.push(readFileSync(path.join(home, '.rubato-pi', 'node-path'), 'utf8').trim()); } catch { /* 캐시 없음 */ }
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  try { candidates.push(...readdirSync(nvmRoot).sort().reverse().map((version) => path.join(nvmRoot, version, 'bin', 'node'))); } catch { /* nvm 없음 */ }
  candidates.push('/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node');
  for (const candidate of candidates) if (candidate && nodeMajor(candidate) >= 24) return candidate;
  return process.execPath;
}
const ensureDescriptor = descriptorPath => ensureProfileEngine({ descriptorPath, nodeBin: resolveNode() });

const copy = (value) => JSON.parse(JSON.stringify(value));
async function imagesFromAttachments(attachments) {
  const images = [];
  for (const attachment of attachments ?? []) {
    if (attachment?.type !== 'image' || typeof attachment.mimeType !== 'string') continue;
    if (typeof attachment.dataUrl === 'string') {
      const comma = attachment.dataUrl.indexOf(',');
      const data = comma >= 0 ? attachment.dataUrl.slice(comma + 1) : attachment.dataUrl;
      if (data) images.push({ type: 'image', data, mimeType: attachment.mimeType });
      continue;
    }
    if (typeof attachment.path === 'string' && attachment.path.startsWith('/')) {
      const data = Buffer.from(await readFile(attachment.path)).toString('base64');
      images.push({ type: 'image', data, mimeType: attachment.mimeType });
    }
  }
  return images;
}
export class RubatoPiBridge {
  constructor({ descriptorPath, instanceId, emit = () => {}, onError = () => {}, projectedMessages = async () => [],
    shows = userStartedSession }) {
    Object.assign(this, { descriptorPath, instanceId, emit, onError, projectedMessages, shows });
    this.sessions = new Map(); this.openings = new Map(); this.catalogues = new Map(); this.claimed = new Set(); this.closed = false;
    this.retryTimer = setInterval(() => { void this.recover().catch(onError); }, 1000);
    this.retryTimer.unref?.();
  }
  async connection() {
    if (this.closed) throw new Error('T3 bridge is closed');
    if (this.inventoryClient?.client.connected) return this.inventoryClient;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.inventoryClient?.close();
      this.descriptor = await ensureDescriptor(this.descriptorPath);
      this.inventoryClient = await new SessionClient({ ...this.descriptor, onError: this.onError }).connect();
      return this.inventoryClient;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  // 끊긴 소켓은 첫 요청에서야 드러난다. connected 플래그는 그 시점까지 참이라
  // 요청 하나가 통째로 실패하고, 화면에는 모델 목록이 통째로 빈 채로 남았다.
  // 그 한 번을 새 연결로 되받는다. 서버가 다시 떠야 하면 ensureDescriptor 가 띄운다.
  async viaInventory(call) {
    try { return await call(await this.connection()); }
    catch (error) {
      if (this.closed || !TRANSPORT_FAILURE.test(String(error?.message ?? error))) throw error;
      const stale = this.inventoryClient;
      this.inventoryClient = undefined;
      await stale?.abandon().catch(() => {});
      return call(await this.connection());
    }
  }
  // 앱에 실어 보내는 목록. 앱이 만든 세션은 정책과 무관하게 앱의 것이다.
  async inventory() {
    const sessions = await this.viaInventory((client) => client.list());
    return sessions.filter((entry) => this.claimed.has(entry.sessionId) || this.shows(entry));
  }
  async transcript(id) { return this.viaInventory((client) => client.transcript(id)); }
  async catalogue(cwd) {
    const cached = this.catalogues.get(cwd);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const pending = (async () => {
      const raw = await this.viaInventory((client) => client.catalogue(cwd));
      return { ...raw, models: catalogForPicker(raw.models ?? [], raw.model) };
    })();
    this.catalogues.set(cwd, { at: Date.now(), value: pending });
    try { return await pending; } catch (error) { this.catalogues.delete(cwd); throw error; }
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
    if (this.openings.has(input.threadId)) return this.openings.get(input.threadId);
    if (this.sessions.has(input.threadId)) return copy(this.sessions.get(input.threadId).session);
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
    this.claimed.add(sessionId);
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
  recover() {
    if (this.closed) return Promise.resolve();
    if (this.recovering) return this.recovering;
    const recovery = (async () => {
      for (const context of this.sessions.values()) {
        if (this.closed || context.stopped || context.syncing) continue;
        try {
          if (!context.client.client.connected || !context.client.client.attachment) {
            const descriptor = await readDescriptor(this.descriptorPath);
            if (descriptor.serverId !== context.session.resumeCursor.serverId) throw new Error('Pi server identity changed; refusing automatic redirection');
            this.descriptor = descriptor;
            if (context.client.socketPath !== descriptor.socketPath) {
              await context.client.abandon();
              context.client = await new SessionClient({ ...descriptor, onError: this.onError }).connect();
              await context.client.attach(context.sessionId);
            } else if (context.client.client.connected) {
              await context.client.attach(context.sessionId);
            } else {
              await context.client.reconnect(context.sessionId);
            }
            await this.synchronize(context);
          } else if (context.needsSync) { context.needsSync = false; await this.synchronize(context); }
        } catch (error) {
          if (context.session.status !== 'error') { context.session.status = 'error'; this.stateEvent(context); }
          this.onError(error);
        }
      }
    })();
    this.recovering = recovery;
    const clear = () => { if (this.recovering === recovery) this.recovering = undefined; };
    recovery.then(clear, clear);
    return recovery;
  }
  require(threadId) {
    const context = this.sessions.get(threadId);
    if (!context || context.stopped) throw new Error(`No Pi attachment for ${threadId}`);
    return context;
  }
  async selectModel(context, selection) {
    if (selection.model === 'rubato:select-model') {
      if (context.session.model) return;
      throw new Error('Select a real model from the provider list before sending a prompt');
    }
    const split = selection.model.indexOf('/');
    if (split < 1) throw new Error('Pi model must be provider/modelId');
    const provider = selection.model.slice(0, split); const modelId = selection.model.slice(split + 1);
    if (selection.model !== context.session.model) {
      if (context.session.status === 'running') throw new Error('Wait for this turn to settle before changing its model');
      await context.client.command({ type: 'set_model', provider, modelId });
      context.session.model = selection.model;
    }
    const { thinking, fast } = applySelectionOptions(selection.options);
    if (thinking !== undefined && thinking !== context.thinkingLevel) {
      const { levels } = await context.client.command({ type: 'get_available_thinking_levels' });
      if (!levels.includes(thinking)) throw new Error('Thinking level is not supported by this model');
      await context.client.command({ type: 'set_thinking_level', level: thinking });
      context.thinkingLevel = thinking;
    }
    if (fast !== undefined && fast !== context.fastMode) {
      await context.client.command({ type: 'prompt', message: fast ? '/fast on' : '/fast off' });
      context.fastMode = fast;
    }
    context.projection.event('session.configured', { config: { model: context.session.model } });
  }
  sendTurn(input) {
    const context = this.require(input.threadId);
    const operation = context.queue.then(async () => {
      if (context.stopped) throw new Error('Attachment closed before send');
      if (input.continuation === true) {
        const snapshot = await context.client.snapshot();
        if (!snapshot.state.isStreaming) throw new Error('Pi has no running turn to reattach; send a new message explicitly');
        const turnId = context.projection.begin();
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      }
      const images = await imagesFromAttachments(input.attachments);
      if (!input.input?.trim() && images.length === 0) throw new Error('A non-empty prompt is required');
      if (input.interactionMode === 'plan') throw new Error('T3 plan mode is not mapped to Rubato policy');
      if (input.modelSelection) await this.selectModel(context, input.modelSelection);
      const running = context.session.status === 'running';
      const turnId = context.projection.begin();
      context.session.status = 'running'; this.stateEvent(context);
      try {
        await context.client.command({
          type: running ? 'steer' : 'prompt',
          message: input.input ?? '',
          ...(images.length ? { images } : {}),
        });
      }
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
  ownsSession(sessionId) {
    return this.claimed.has(sessionId) || [...this.sessions.values()].some((context) => context.sessionId === sessionId);
  }
  async readThread(threadId) {
    const context = this.require(threadId); const snapshot = await context.client.snapshot();
    return { threadId, turns: [{ id: context.projection.turnId ?? `pi-history:${context.sessionId}`, items: snapshot.messages }] };
  }
  async stopSession(threadId) {
    await this.openings.get(threadId)?.catch(() => {});
    const context = this.sessions.get(threadId);
    if (!context) return;
    context.stopped = true; this.sessions.delete(threadId);
    if (![...this.sessions.values()].some((open) => open.sessionId === context.sessionId)) this.claimed.delete(context.sessionId);
    await context.client.close();
    context.projection.event('session.exited', { exitKind: 'graceful', recoverable: true, reason: 'Presentation detached; Pi work is unchanged' });
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.retryTimer);
    await this.recovering?.catch(() => {});
    await Promise.allSettled([...this.openings.values()]);
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId)));
    await this.inventoryClient?.close();
  }
}
export const createBridge = (options) => new RubatoPiBridge(options);
