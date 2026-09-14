// Full installed candidate + native TUI + real Unix hub protocol, no model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadHostedRuntime } from '../../src/hosted-runtime.mjs';
import { SessionWorker } from '../../src/session-worker.mjs';
import { startSessionServer } from '../../src/host.mjs';
import { startTerminalSession } from '../../src/terminal-session.mjs';
import { SessionClient } from '../../src/client.mjs';
import { buildStockPiArgs } from '../../../rubato-pi/src/launch.mjs';
import { startLocalHub } from '../../../pi-runtime/features/remote-surface/local-hub.mjs';

const [root, profile] = process.argv.slice(2);
assert.ok(process.send && process.cwd().startsWith('/private/tmp/rb-common-'));
const load = file => import(pathToFileURL(path.join(root, file)));
const { getInstalledRemoteSurface } = await load('rubato-features/remote-surface/surface.mjs');
const protocol = await load('rubato-features/remote-surface/protocol.mjs');
const loaded = await loadHostedRuntime({ runtimeRoot: root, agentDir: profile });
const api = await loaded.loadTerminalApi();
const options = await loaded.createWorkerOptions();
let fetches = 0;
globalThis.fetch = async () => { fetches++; throw new Error('Model/network forbidden'); };
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ quietStartup: true, lastChangelogVersion: '0.85.1' }));
const terminals = [], starts = new Map(), failures = [], views = [];
let server, hub, gui;
const until = async check => {
  const end = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() > end) throw new Error('Managed presentation timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
try {
  hub = await startLocalHub(path.join(process.cwd(), 'hub'));
  server = await startSessionServer({ sessionsDir: path.join(profile, 'sessions'), socketPath: path.join(process.cwd(), 'engine.sock'),
    idleMs: null, pollMs: 0, onError: e => failures.push(e.message),
    workerFactory: (metadata, creation) => new SessionWorker(metadata, options(metadata, creation)) });
  loaded.bindHost(server.host);
  const descriptor = { serverId: server.serverId, socketPath: path.join(process.cwd(), 'engine.sock') };
  const instrumented = { ...api, createExtensionFactories: async ctx => [
    ...await api.createExtensionFactories(ctx), { name: 'startup-counter', factory(pi) {
      pi.on('session_start', (_event, ctx) => {
        const id = ctx.sessionManager.getSessionId(); starts.set(id, (starts.get(id) ?? 0) + 1);
      });
    } },
  ] };
  const start = async (cwd, args = []) => {
    const liveSessionId = `019955aa-bbcc-7dde-8abc-${String(terminals.length + 1).padStart(12, '0')}`;
    const token = hub.issueToken(liveSessionId);
    const env = { ...process.env, TERM: 'xterm-256color', RUBATO_LIVE_SESSION_ID: liveSessionId,
      RUBATO_HOST_ID: hub.hostId, RUBATO_HUB_SOCKET: hub.socketPath, RUBATO_SURFACE_TOKEN: token };
    let enter, ready = false;
    const terminal = startTerminalSession({ host: server.host, descriptor, api: instrumented,
      open: { cwd, args: buildStockPiArgs(['--offline', ...args]), rows: 28, columns: 100, env },
      send(frame) { if (frame.type === 'error') failures.push(frame.message); },
      onMode(mode) {
        enter = api.bindUiCallback(fn => fn());
        const init = mode.init.bind(mode);
        mode.init = async () => { await init(); ready = true; };
      } });
    terminals.push(terminal);
    terminal.run = fn => enter(fn);
    void terminal.done.finally(() => { enter = undefined; terminal.run = undefined; });
    await until(() => ready && getInstalledRemoteSurface({ liveSessionId })?.registered);
    terminal.liveSessionId = liveSessionId;
    return terminal;
  };
  const send = (terminal, action, payload = {}) => hub.dispatch({ protocol: protocol.REMOTE_PROTOCOL_NAME,
    requestId: randomUUID(), hostId: hub.hostId, liveSessionId: terminal.liveSessionId, action, payload });
  const cwdA = path.join(process.cwd(), 'a'), cwdB = path.join(process.cwd(), 'b');
  await mkdir(cwdA); await mkdir(cwdB);
  const a = await start(cwdA), b = await start(cwdB);
  const aId = a.cursor.session.sessionId, bId = b.cursor.session.sessionId, aFile = a.cursor.session.sessionFile;
  const surfaceA = getInstalledRemoteSurface(a), surfaceB = getInstalledRemoteSurface(b);
  assert.notEqual(surfaceA, surfaceB);
  assert.equal(surfaceA.summary().managed, true); assert.equal(surfaceB.summary().managed, true);
  assert.equal(surfaceA.summary().pi.sessionId, aId); assert.equal(surfaceB.summary().pi.sessionId, bId);
  assert.equal((await hub.list()).length, 2, 'two real tokens register separate managed panes');
  gui = await new SessionClient(descriptor).connect(); await gui.attach(aId);
  b.receive({ type: 'input', data: 'b-stays-here' });
  assert.equal((await send(a, 'session.new')).accepted, true);
  await until(() => a.cursor.session.sessionId !== aId && surfaceA.summary().pi.sessionId === a.cursor.session.sessionId);
  assert.equal(surfaceB.summary().pi.sessionId, bId);
  assert.equal((await gui.snapshot()).state.sessionId, aId);
  await a.run(() => a.cursor.switchSession(aFile));
  assert.equal(getInstalledRemoteSurface(a), surfaceA, 'pane keeps its connection across /new and resume');
  assert.equal(surfaceA.summary().pi.sessionId, aId);
  assert.equal(starts.get(aId), 1, 'presentation rebind does not replay extension startup');
  // Hub response reaches the new binding, not the invalidated native UI port.
  const question = a.run(() => a.cursor.session.extensionRunner.createContext().ui.input('Managed question'));
  const request = surfaceA.controlSnapshot().uiRequest;
  assert.ok(request);
  assert.equal((await send(a, 'ui.respond', { requestId: request.requestId, value: 'correct-pane' })).accepted, true);
  assert.equal(await question, 'correct-pane');
  assert.equal(b.mode.editor.getText(), 'b-stays-here');
  views.push(new WeakRef(a.mode)); await a.close(); await a.done;
  assert.equal(surfaceA.stopped, true); assert.equal(getInstalledRemoteSurface(a), undefined);
  assert.equal(surfaceB.registered, true);
  const resumed = await start(cwdA, ['--session', aFile]);
  const resumedSurface = getInstalledRemoteSurface(resumed);
  assert.notEqual(resumedSurface, surfaceA);
  assert.equal(resumedSurface.summary().pi.sessionId, aId);
  assert.equal(starts.get(aId), 1);
  // Old actor unloading cannot emit live.exited for its former pane.
  assert.equal((await send(resumed, 'session.new')).accepted, true);
  await until(() => resumed.cursor.session.sessionId !== aId);
  await gui.detach(); await gui.close(); gui = undefined;
  await server.host.getSessionWorker(aId)?.stop();
  assert.equal(resumedSurface.registered, true);
  assert.equal(surfaceB.registered, true);
  views.push(new WeakRef(resumed.mode)); await resumed.close(); await resumed.done;
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 20)); global.gc(); }
  assert.deepEqual(views.map(v => Boolean(v.deref())), [false, false]);
  assert.equal(fetches, 0); assert.deepEqual(failures, []);
  process.send({ ok: true, phase: 'managed-pane-native-hub', panes: 3, sessionStarts: [...starts], fetches,
    retainedViews: views.map(v => Boolean(v.deref())), enginePid: process.pid });
} catch (error) {
  process.send({ ok: false, error: error.stack, failures, fetches }); process.exitCode = 1;
} finally {
  for (const terminal of terminals) { await terminal.close(); await terminal.done; }
  await gui?.close(); await server?.close(); await hub?.close();
}
