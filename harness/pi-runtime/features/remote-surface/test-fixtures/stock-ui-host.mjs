import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startLocalHub, HOST_ID, LIVE_SESSION_ID } from '../local-hub.mjs';
import { SessionActionQueue } from '../../../../../packages/rubato-remote-hub/src/action-queue.ts';

const [root, scratch] = process.argv.slice(2);
const sdkRoot = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist');
const load = (file) => import(pathToFileURL(file));
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await load(join(sdkRoot, 'index.js'));
const { AgentSessionRuntime } = await load(join(sdkRoot, 'core/agent-session-runtime.js'));
const { InteractiveMode } = await load(join(sdkRoot, 'modes/interactive/interactive-mode.js'));
const { createRemoteSurfaceExtension } = await load(join(root, 'rubato-features/remote-surface/index.mjs'));
const { getInstalledRemoteSurface } = await load(join(root, 'rubato-features/remote-surface/surface.mjs'));
const protocol = await load(join(root, 'rubato-features/remote-surface/protocol.mjs'));
const hubRoot = await mkdtemp(join(scratch, 'hub-'));
const hub = await startLocalHub(hubRoot);
const surfaceToken = hub.issueToken(LIVE_SESSION_ID);
const remoteOptions = { protocol, socketPath: hub.socketPath, hostId: HOST_ID, liveSessionId: LIVE_SESSION_ID, surfaceToken };
const queue = new SessionActionQueue(hub, () => 0);
const send = (action, payload = {}) => queue.enqueue({ protocol: protocol.REMOTE_PROTOCOL_NAME,
  requestId: randomUUID(), hostId: HOST_ID, liveSessionId: LIVE_SESSION_ID, action, payload });
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Local control roundtrip timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const cwd = join(scratch, 'cwd');
const agentDir = join(scratch, 'agent');
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });
let current;
let askBeforeNew = false;
let controlEnabled = true;
const events = [];
const errors = [];
let starts = 0;
async function createRuntime(options = {}) {
  starts++;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'stock-host-test', async factory(pi) {
      if (controlEnabled) await createRemoteSurfaceExtension(remoteOptions)(pi);
      pi.events.on('interactive.ui.request', (value) => events.push(['request', value]));
      pi.events.on('interactive.ui.dismiss', (value) => events.push(['dismiss', value]));
      pi.on('session_start', (_event, ctx) => { current = { control: pi.getInteractiveControl?.(), ctx }; });
      pi.on('session_before_switch', async (event, ctx) => {
        if (askBeforeNew && event.reason === 'new') return { cancel: !await ctx.ui.confirm('New conversation?', 'Keep the original history?') };
      });
    } }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: options.sessionManager ?? SessionManager.create(cwd, join(agentDir, 'sessions')),
    sessionStartEvent: options.sessionStartEvent, noTools: 'all' });
  session.agent.streamFunction = () => { throw new Error('Model calls are forbidden in this fixture'); };
  return { session, services: { cwd, agentDir }, diagnostics: [] };
}
const initial = await createRuntime();
const runtime = new AgentSessionRuntime(initial.session, initial.services, createRuntime);
const mode = new InteractiveMode(runtime);
// Real mode, runtime, extension runner and dialog components; only terminal IO
// is suppressed here. This is not a rendered PTY or CLI/T3 end-to-end claim.
mode.renderer.requestRender = () => {};
mode.renderer.terminal.setTitle = () => {};
mode.showExtensionError = (...args) => errors.push(args);
try {
  await mode.bindCurrentSessionExtensions();
  await until(() => getInstalledRemoteSurface(remoteOptions)?.registered);
  if (process.env.RUBATO_TEST_UI_REPLY_DISABLED === '1') current.control.respondToUiRequest = () => false;
  assert.equal(current.control.snapshot().sessionFile, runtime.session.sessionFile);
  const originalSession = runtime.session;
  const originalFile = originalSession.sessionFile;
  const user = originalSession.sessionManager.appendMessage({ role: 'user', content: 'preserved', timestamp: Date.now() });
  originalSession.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'local fixture' }],
    api: 'openai-completions', provider: 'local-test', model: 'no-network', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const originalBytes = await readFile(originalFile);
  const select = current.ctx.ui.select('Choose', ['A', 'B']);
  const id = current.control.snapshot().uiRequest.requestId;
  assert.match(mode.extensionSelector.render(80).join('\n'), /Choose/);
  assert.equal(current.control.respondToUiRequest(id, 'invalid'), false);
  assert.equal((await send('ui.respond', { requestId: id, value: 'B' })).accepted, true);
  assert.equal(current.control.respondToUiRequest(id, 'A'), false);
  assert.equal(await select, 'B');
  assert.equal(current.control.snapshot().uiRequest, undefined);
  const confirm = current.ctx.ui.confirm('Confirm', 'Message');
  assert.equal(current.control.respondToUiRequest(current.control.snapshot().uiRequest.requestId, false), true);
  assert.equal(await confirm, false);
  const input = current.ctx.ui.input('Text', 'placeholder');
  mode.extensionInput.input.setValue('terminal answer');
  mode.extensionInput.handleInput('\n');
  assert.equal(await input, 'terminal answer');
  const cancelled = current.ctx.ui.select('Cancel', ['A']);
  mode.extensionSelector.handleInput('\x1b');
  assert.equal(await cancelled, undefined);
  const abort = new AbortController();
  const aborted = current.ctx.ui.input('Abort', '', { signal: abort.signal });
  abort.abort();
  assert.equal(await aborted, undefined);
  assert.equal(await current.ctx.ui.select('Already aborted', ['A'], { signal: abort.signal }), undefined);
  assert.equal(current.control.snapshot().uiRequest, undefined);
  assert.equal(await current.ctx.ui.input('Timeout', '', { timeout: 20 }), undefined);
  const replaced = current.ctx.ui.input('Old');
  const oldId = current.control.snapshot().uiRequest.requestId;
  const replacing = current.ctx.ui.input('New');
  assert.equal(await replaced, undefined);
  assert.equal(current.control.respondToUiRequest(oldId, 'late'), false);
  current.control.respondToUiRequest(current.control.snapshot().uiRequest.requestId, 'new answer');
  assert.equal(await replacing, 'new answer');
  // Native new/fork/resume paths, not extension-event-context approximations.
  const oldControl = current.control;
  await current.control.fork(user);
  assert.notEqual(runtime.session, originalSession);
  assert.throws(() => oldControl.snapshot(), /stale/);
  await assert.rejects(oldControl.newSession(), /stale/);
  assert.deepEqual(await readFile(originalFile), originalBytes);
  await mode.handleResumeSession(originalFile);
  assert.equal(runtime.session.sessionFile, originalFile);
  const beforeReloadControl = current.control;
  const beforeReloadSession = runtime.session;
  const pendingReload = current.ctx.ui.input('Dismiss on reload');
  const reloadRequestId = current.control.snapshot().uiRequest.requestId;
  await current.control.reload();
  assert.equal(await pendingReload, undefined);
  assert.equal(runtime.session, beforeReloadSession, 'stock reload keeps AgentSession but replaces its extension runner');
  await assert.rejects(beforeReloadControl.newSession(), /stale/);
  assert.throws(() => beforeReloadControl.snapshot(), /stale/);
  assert.equal(current.control.respondToUiRequest(reloadRequestId, 'late reply'), false);
  assert.throws(() => beforeReloadControl.respondToUiRequest(reloadRequestId, 'late reply'), /stale/);
  const afterReload = current.ctx.ui.input('After reload');
  current.control.respondToUiRequest(current.control.snapshot().uiRequest.requestId, 'works');
  assert.equal(await afterReload, 'works');
  await current.control.newSession();
  assert.notEqual(runtime.session.sessionFile, originalFile);
  assert.deepEqual(await readFile(originalFile), originalBytes);
  // Both production queues + Unix transport + actual native before-switch UI.
  // A FIFO-only reply path deadlocks this command until the test timeout.
  await until(() => getInstalledRemoteSurface(remoteOptions)?.pi.getInteractiveControl() === current.control);
  askBeforeNew = true;
  const beforeQuestion = runtime.session;
  const denied = send('session.new');
  await until(() => current.control.snapshot().uiRequest?.kind === 'confirm');
  assert.equal((await send('ui.respond', { requestId: current.control.snapshot().uiRequest.requestId, value: false })).accepted, true);
  assert.equal((await denied).accepted, true);
  assert.equal(runtime.session, beforeQuestion, 'denied native switch keeps the same engine');
  const allowed = send('session.new');
  await until(() => current.control.snapshot().uiRequest?.kind === 'confirm');
  await send('ui.respond', { requestId: current.control.snapshot().uiRequest.requestId, value: true });
  assert.equal((await allowed).accepted, true);
  assert.notEqual(runtime.session, beforeQuestion);
  assert.deepEqual(await readFile(originalFile), originalBytes);
  const beforeDisable = current.control;
  controlEnabled = false;
  await beforeDisable.reload();
  assert.equal(current.control, undefined);
  const eventsBeforeDisabledUi = events.length;
  const nativeOnly = current.ctx.ui.select('Native after disabling the factory', ['unchanged']);
  mode.extensionSelector.handleInput('\n');
  assert.equal(await nativeOnly, 'unchanged');
  assert.equal(events.length, eventsBeforeDisabledUi, 'disabled factory restores the unwrapped native UI');
  await assert.rejects(beforeDisable.newSession(), /stale/);
  assert.deepEqual(errors, []);
  assert.equal(events.filter(([kind]) => kind === 'request').length, events.filter(([kind]) => kind === 'dismiss').length);
  console.log('STOCK_UI_HOST_OK ' + JSON.stringify({ starts, dialogs: events.filter(([kind]) => kind === 'request').length, preserved: true }));
} finally {
  mode.resetExtensionUI();
  runtime.session.dispose();
  mode.footerDataProvider.dispose();
  mode.themeController.dispose();
  getInstalledRemoteSurface(remoteOptions)?.stop();
  await hub.close();
  await rm(hubRoot, { recursive: true, force: true });
}
