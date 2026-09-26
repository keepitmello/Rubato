import { SessionClient } from '../../pi-server/src/client.mjs';
import { readDescriptor } from '../../pi-server/src/descriptor.mjs';
import { ensureProfileEngine } from '../../pi-server/src/discovery.mjs';
import { EventProjection, importedId, messageKey, textOf, usageModelIdentity, windowFromModels } from './events.mjs';
import { applySelectionOptions, catalogForPicker } from './model-catalog-order.mjs';
import { controlCommandFor, rewriteSkillMentions, surfaceFromPiCommands } from './commands.mjs';
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
function t3BridgeLog(message, extra) {
  try {
    const dir = path.join(os.homedir(), '.rubato-pi', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 't3-bridge.log'), `${new Date().toISOString()} ${message}${extra ? ` ${extra}` : ''}
`);
  } catch { /* ignore */ }
}
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// 소켓이 끊기면 pi-client 는 이 문구들로 던진다. 서버가 다시 떠도 이미 만들어 둔
// 클라이언트는 되살아나지 않으니, 붙잡고 있던 것을 버리고 새 연결로 한 번 더 친다.
const TRANSPORT_FAILURE = /transport closed|not connected|ECONNREFUSED|ECONNRESET|EPIPE|socket (?:closed|hang)|DisconnectedError|Client is disconnected|not supported on Windows/i;
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
t3BridgeLog('t3-bridge loaded');


const copy = (value) => JSON.parse(JSON.stringify(value));
const staleQueue = (state) => state && !state.isStreaming && !state.isCompacting
  && Number(state.pendingMessageCount) > 0;
function queuedMessagesInOrder(state, cleared) {
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
/** 확장 명령으로 보낼 때의 슬래시 문장. 남은 인자는 그대로 명령 인자가 된다. */
const slashText = (control) => `/${control.name}${control.args ? ` ${control.args}` : ''}`;
export class RubatoPiBridge {
  constructor({ descriptorPath, instanceId, emit = () => {}, onError = () => {}, projectedMessages = async () => [],
    shows = userStartedSession }) {
    Object.assign(this, { descriptorPath, instanceId, emit, onError, projectedMessages, shows });
    this.sessions = new Map(); this.openings = new Map(); this.catalogues = new Map(); this.claimed = new Set(); this.closed = false;
    this.skillNames = new Set();
    this.retryTimer = setInterval(() => { void this.recover().catch(onError); }, 1000);
    this.retryTimer.unref?.();
  }
  async connection() {
    if (this.closed) throw new Error('T3 bridge is closed');
    if (this.inventoryClient?.client.connected) return this.inventoryClient;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.inventoryClient?.close();
      t3BridgeLog('ensureDescriptor', this.descriptorPath);
      this.descriptor = await ensureDescriptor(this.descriptorPath);
      t3BridgeLog('connect', this.descriptor?.socketPath);
      this.inventoryClient = await new SessionClient({ ...this.descriptor, onError: this.onError }).connect();
      t3BridgeLog('connected');
      return this.inventoryClient;
    })().catch((error) => { t3BridgeLog('connection failed', String(error?.message ?? error)); throw error; }).finally(() => { this.connecting = undefined; });
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
      this.rememberWindows(raw.models ?? []);
      const surface = surfaceFromPiCommands(raw.commands ?? []);
      this.skillNames = surface.skillNames;
      return { ...raw, models: catalogForPicker(raw.models ?? [], raw.model),
        slashCommands: surface.slashCommands, skills: surface.skills };
    })();
    this.catalogues.set(cwd, { at: Date.now(), value: pending });
    try { const value = await pending; t3BridgeLog('catalogue ok', String((value.models ?? []).length)); return value; } catch (error) { t3BridgeLog('catalogue fail', String(error?.message ?? error)); this.catalogues.delete(cwd); throw error; }
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
    }, sequence: 0, queue: Promise.resolve(), stopped: false,
    // T3 paints the Fast toggle off on every attach (model-catalog-order.mjs
    // `optionDescriptorsFor`), so an unknown belief here made the first selection
    // differ from `false` and sent a `/fast off` nobody asked for: on a model Pi
    // cannot serve fast that surfaced as a warning each session, and on one it can
    // it overwrote the remembered tier with "auto". Start from what the toggle shows.
    fastMode: false };
    try {
      this.sessions.set(input.threadId, context);
      await client.attach(sessionId);
      const snapshot = await this.synchronize(context);
      if (!input.resumeCursor && input.modelSelection) await this.selectModel(context, input.modelSelection);
      this.mirrorSessionTitle(context, snapshot?.state?.sessionName, input.title);
      return copy(context.session);
    } catch (error) { this.sessions.delete(input.threadId); context.stopped = true; await client.close(); throw error; }
  }
  /**
   * 세션 이름이 스레드 제목과 갈라졌으면 그 이름을 T3 에 알린다. 세션을 만들 때
   * Pi 의 이름은 스레드 제목으로 시작하므로(pi-server 가 create 로 그 이름을
   * 남긴다), 달라졌다는 것은 제목 확장이 주제를 보고 새로 지었다는 뜻이다.
   * 앱이 꺼져 있던 사이에 지어진 제목을 다시 붙여 주는 자리이기도 하다.
   */
  mirrorSessionTitle(context, sessionName, threadTitle) {
    const name = typeof sessionName === 'string' ? sessionName.trim() : '';
    if (!name || name === String(threadTitle ?? '').trim()) return;
    context.projection.event('thread.metadata.updated', { name });
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
      await this.drainStrandedQueue(context, snapshot.state);
      context.session.status = snapshot.state.isStreaming ? 'running' : 'ready';
      if (!snapshot.state.isStreaming && context.projection.turnId) {
        context.projection.interrupted = true;
        context.projection.settle();
      }
      // 모델을 먼저 적는다. configureUsage 는 session.model 로 창 크기를 찾는데,
      // 대입이 뒤에 있으면 새 대화(assistant 메시지가 아직 없는 세션)에서는 식별자가
      // 없어 replaceWindow 가 창을 지운다. 그 다음 selectModel 은 고른 모델이
      // 세션 모델과 같으면 통째로 건너뛰므로 — T3 기본 선택과 pi 기본 모델이 같은
      // 흔한 경우다 — 창은 그 세션 내내 비어 있고 미터에 퍼센트가 안 뜬다.
      if (snapshot.state.model) context.session.model = `${snapshot.state.model.provider}/${snapshot.state.model.id}`;
      await this.configureUsage(context, snapshot.state, snapshot.messages);
      this.replayUsage(context, snapshot.messages);
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
    // Host status lags agent_settled (refresh is async). A settled projection
    // with no turn is ready; trusting host 'running' here made rewind/sendTurn
    // see a live turn and steer a fixture that never settles.
    const next = ['error', 'unloaded'].includes(state.status) ? 'error'
      : context.projection.turnId ? 'running' : 'ready';
    if (context.session.status !== next || context.session.activeTurnId !== context.projection.turnId) {
      context.session.status = next; this.stateEvent(context);
    }
  }
  recover() {
    if (this.closed) return Promise.resolve();
    if (this.recovering) return this.recovering;
    const recovery = (async () => {
      await Promise.all([...this.sessions.values()].map((context) => {
        if (this.closed || context.stopped || context.syncing) return;
        const operation = context.queue.then(() => this.restoreSession(context));
        context.queue = operation.catch(() => {});
        return operation;
      }));
    })();
    this.recovering = recovery;
    const clear = () => { if (this.recovering === recovery) this.recovering = undefined; };
    recovery.then(clear, clear);
    return recovery;
  }
  // Reattach on the session queue so recover cannot detach while sendTurn is
  // mid-RPC. That race was "No session is attached" on a live astra turn.
  async restoreSession(context) {
    if (this.closed || context.stopped) return;
    try {
      if (context.client.client && (!context.client.client.connected || !context.client.client.attachment)) {
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
  require(threadId) {
    const context = this.sessions.get(threadId);
    if (!context || context.stopped) throw new Error(`No Pi attachment for ${threadId}`);
    return context;
  }
  // Nothing of the user's should sit in Pi's queue. A queued message waits in
  // T3, where it stays visible, editable and cancellable, and the row's Send
  // now arrow promotes it to a steer. An abort can still strand a steer Pi had
  // not read yet; drain it and write the text into the thread instead of
  // letting it surface inside an unrelated turn later.
  async drainStrandedQueue(context, state) {
    if (!staleQueue(state)) return;
    const cleared = await context.client.command({ type: 'clear_queue' });
    const messages = queuedMessagesInOrder(state, cleared);
    if (!messages.length) return;
    context.projection.event('runtime.warning', { message:
      `${messages.length} message${messages.length === 1 ? '' : 's'} never reached the model before the turn stopped:\n${
        messages.map((text, index) => `${index + 1}. ${text}`).join('\n')}` });
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
      const applied = await context.client.command({ type: 'set_model', provider, modelId });
      context.session.model = selection.model;
      context.usageModel = selection.model;
      context.projection.configureUsage({ maxTokens: applied?.contextWindow });
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
      await this.restoreSession(context);
      if (input.continuation === true) {
        const state = await context.client.command({ type: 'get_state' });
        if (!state.isStreaming) {
          // Engine restart cuts the turn. T3 still asks to continue; leaving
          // the projection open shows thinking with no stream behind it.
          if (context.projection.turnId) {
            context.projection.interrupted = true;
            context.projection.settle();
          }
          context.session.status = 'ready';
          this.stateEvent(context);
          throw new Error('Pi has no running turn to reattach; send a new message explicitly');
        }
        const turnId = context.projection.begin();
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      }
      // Send only needs live state. A full snapshot serializes the transcript
      // (astra thinking/notes) and was aborting at 30s on every follow-up.
      const beforeSend = await context.client.command({ type: 'get_state' });
      await this.drainStrandedQueue(context, beforeSend);
      const images = await imagesFromAttachments(input.attachments);
      if (!input.input?.trim() && images.length === 0) throw new Error('A non-empty prompt is required');
      if (input.interactionMode === 'plan') throw new Error('T3 plan mode is not mapped to Rubato policy');
      if (input.modelSelection) await this.selectModel(context, input.modelSelection);
      const message = rewriteSkillMentions(input.input ?? '', this.skillNames);
      const control = controlCommandFor(message);
      const running = context.session.status === 'running';
      if (control && running) throw new Error(`Interrupt the current turn before /${control.name}`);
      const turnId = context.projection.begin();
      context.session.status = 'running'; this.stateEvent(context);
      try {
        if (control) {
          context.projection.sawCompaction = false;
          if (control.name === 'compact' && await this.compactCommandAvailable(context)) {
            // 정리 방식은 확장이 모드를 보고 고른다. 완료는 실제 컷이 만드는
            // compaction_end 가 알리므로 여기서 'compacted' 를 지어내지 않는다.
            await context.client.command({ type: 'prompt', message: slashText(control) });
            await this.requireCutStarted(context);
          } else {
            await context.client.command(control.rpc);
            this.reportControl(context, control);
          }
        } else {
          // 대기열은 T3 가 쥔다: 큐에 든 말은 턴이 끝나야 나오는 팔로업이고,
          // 그 행의 Send now 화살표가 승격이다. 그러니 턴이 도는 중에 여기까지
          // 온 말은 승격된 말뿐이라 지금 턴에 끼어드는 steer 로 보낸다. 예전처럼
          // Pi 의 follow_up 큐에 맡기면 T3 가 못 보는 두 번째 대기열이 생기고,
          // 턴을 멈췄을 때 거기 남은 말을 되돌려줄 자리가 없었다.
          await context.client.command({
            type: running ? 'steer' : 'prompt',
            message,
            ...(images.length ? { images } : {}),
          });
        }
      }
      catch (error) {
        if (!running) { context.projection.failed = true; context.projection.settle(); context.session.status = 'ready'; this.stateEvent(context); }
        throw error;
      }
      if (control) { context.projection.settle(); context.session.status = 'ready'; this.stateEvent(context); }
      return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
    });
    context.queue = operation.catch(() => {}); return operation;
  }
  reportControl(context, control) {
    if (control.name === 'name') context.projection.event('thread.metadata.updated', { name: control.args });
    if (control.name === 'compact' && !context.projection.sawCompaction)
      context.projection.event('thread.state.changed', { state: 'compacted' });
  }
  /**
   * 노트 모드의 수동 정리는 요약이 아니라 새 문맥 창이다. 그 컷은 session_before_compact
   * 훅 안에서 돌릴 수 없어서(엔진이 그 구간에 applyCompaction 을 거부한다) 확장의
   * compact 명령으로 보낸다. 명령이 없는 런타임 — 확장을 안 싣는 빌드 — 에서는 예전
   * compact RPC 로 떨어진다. 명령 목록은 부착 동안 고정이라 한 번만 묻는다.
   */
  async compactCommandAvailable(context) {
    if (context.compactCommand !== undefined) return context.compactCommand;
    try {
      const { commands } = await context.client.command({ type: 'get_commands' });
      context.compactCommand = (commands ?? [])
        .some((command) => command?.name === 'compact' && command.source === 'extension');
    } catch { context.compactCommand = false; }
    return context.compactCommand;
  }
  /**
   * 노트 모드의 컷은 즉시 끝나거나(노트가 신선할 때), 체크포인트 전용 턴이 노트를
   * 저장한 뒤에 끝난다. 둘 다 아니면 컷이 시작되지 않은 것이므로 T3 가 완료 이벤트를
   * 10분 기다리다 세션을 타임아웃으로 잠그게 두지 않고 여기서 끊는다.
   */
  async requireCutStarted(context) {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (context.projection.sawCompaction) return;
      const state = await context.client.command({ type: 'get_state' });
      if (state?.isStreaming === true || state?.isCompacting === true) return;
      await delay(250);
    }
    throw new Error('The new context window did not start. Check the conversation for a blocked working-notes save.');
  }
  compact(threadId, customInstructions) {
    const context = this.require(threadId);
    const operation = context.queue.then(async () => {
      if (context.stopped) throw new Error('Attachment closed before compact');
      if (context.session.status === 'running') throw new Error('Interrupt the current turn before compacting');
      context.projection.sawCompaction = false;
      if (await this.compactCommandAvailable(context)) {
        await context.client.command({
          type: 'prompt',
          message: `/compact${customInstructions ? ` ${customInstructions}` : ''}`,
        });
        await this.requireCutStarted(context);
        return;
      }
      await context.client.command({ type: 'compact', ...(customInstructions ? { customInstructions } : {}) });
      if (!context.projection.sawCompaction)
        context.projection.event('thread.state.changed', { state: 'compacted' });
    });
    context.queue = operation.catch(() => {});
    return operation;
  }
  async interruptTurn(threadId) {
    const context = this.require(threadId); context.projection.interrupted = true;
    await context.client.command({ type: 'abort' });
    context.projection.settle(); context.session.status = 'ready'; this.stateEvent(context);
    const state = await context.client.command({ type: 'get_state' });
    await this.drainStrandedQueue(context, state);
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
  // T3 drops N completed turns from the end. Pi fork(entryId, before) targets that
  // user message's parent and writes a new session file. Rebind this attachment
  // onto the forked id so resumeCursor/recover/listSessions follow it.
  rollbackThread(threadId, numTurns) {
    const context = this.require(threadId);
    const operation = context.queue.then(async () => {
      if (context.stopped) throw new Error('Attachment closed before rewind');
      if (!Number.isInteger(numTurns) || numTurns < 1) throw new Error('numTurns must be an integer >= 1');
      if (context.syncing) await context.syncing;
      if (context.session.status === 'running') throw new Error('Interrupt the current turn before rewinding');
      const listed = await context.client.command({ type: 'get_fork_messages' });
      const messages = listed?.messages ?? listed;
      if (!Array.isArray(messages) || messages.length === 0) throw new Error('This conversation has no user messages to rewind');
      if (numTurns > messages.length) throw new Error('Cannot rewind more turns than this conversation has');
      const target = messages[messages.length - numTurns];
      if (typeof target?.entryId !== 'string') throw new Error('Pi fork boundary is missing');
      await context.unsubscribe?.();
      context.unsubscribe = undefined;
      try {
        const result = await context.client.command({ type: 'fork', entryId: target.entryId });
        if (result?.cancelled) throw new Error('Rewind was cancelled');
        const buffered = [];
        let loading = true;
        context.unsubscribe = await context.client.subscribeSession((state) => {
          if (loading) { buffered.push(state); return; }
          this.applyState(context, state);
        });
        const snapshot = await context.client.snapshot();
        await this.adoptFork(context, snapshot);
        loading = false;
        for (const state of buffered) if (state.sequence > snapshot.sequence) this.applyState(context, state);
        return { threadId, turns: [{ id: context.projection.turnId ?? `pi-history:${context.sessionId}`, items: snapshot.messages }] };
      } catch (error) {
        if (!context.unsubscribe) {
          try { context.unsubscribe = await context.client.subscribeSession((state) => this.applyState(context, state)); }
          catch { /* rewind failed; recover() will resubscribe */ }
        }
        throw error;
      }
    });
    context.queue = operation.catch(() => {});
    return operation;
  }
  async adoptFork(context, snapshot) {
    const sessionId = snapshot.state?.sessionId ?? snapshot.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Pi fork did not return a session identity');
    this.claimed.add(sessionId);
    context.sessionId = sessionId;
    context.session.resumeCursor = this.cursor(sessionId);
    context.projection.reset(sessionId);
    for (const message of snapshot.messages ?? []) {
      if (message?.role !== 'assistant') continue;
      const itemId = messageKey(sessionId, message);
      context.projection.text.set(itemId, textOf(message));
      context.projection.completed.add(itemId);
    }
    context.runtimeId = snapshot.runtimeId;
    context.sequence = snapshot.sequence;
    context.session.status = snapshot.state?.isStreaming ? 'running' : 'ready';
    context.session.updatedAt = new Date().toISOString();
    await this.configureUsage(context, snapshot.state, snapshot.messages);
    this.replayUsage(context, snapshot.messages);
    this.stateEvent(context);
  }
  rememberWindows(models) {
    this.modelWindows ??= new Map();
    for (const item of models ?? []) {
      const identity = item?.provider && item?.id ? `${item.provider}/${item.id}` : undefined;
      const window = windowFromModels(identity, [item]);
      if (identity && window) this.modelWindows.set(identity, window);
    }
  }
  async resolveUsageWindow(context, messages) {
    const identity = usageModelIdentity({
      usageModel: context.usageModel, sessionModel: context.session.model, messages,
    });
    if (!identity) return;
    if (this.modelWindows?.has(identity)) return this.modelWindows.get(identity);
    try { await this.catalogue(context.session.cwd); } catch { return; }
    return this.modelWindows?.get(identity);
  }
  async configureUsage(context, state, messages) {
    context.projection.configureUsage({
      maxTokens: await this.resolveUsageWindow(context, messages),
      replaceWindow: true,
      ...(typeof state?.autoCompactionEnabled === 'boolean' ? { compactsAutomatically: state.autoCompactionEnabled } : {}),
    });
  }
  replayUsage(context, messages) {
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === 'compactionSummary') return;
      if (message?.role !== 'assistant') continue;
      context.projection.usage(message.usage, message);
      return;
    }
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
export const createBridge = (options) => { t3BridgeLog('createBridge', options?.descriptorPath); return new RubatoPiBridge(options); };
