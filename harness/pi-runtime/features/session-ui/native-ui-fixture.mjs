import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TerminalProcess } from '../../../pi-server/src/terminal-process.mjs';
const root = process.argv[2];
const load = file => import(pathToFileURL(path.join(root, file)).href);
const base = 'node_modules/@earendil-works/pi-coding-agent/dist/';
const sdk = await load(base + 'index.js');
const { AgentSessionRuntime } = await load(base + 'core/agent-session-runtime.js');
const { InteractiveMode } = await load(base + 'modes/interactive/interactive-mode.js');
const { initTheme, stopThemeWatcher } = await load(base + 'modes/interactive/theme/theme.js');
const { createUiScope } = await load('rubato-features/session-ui/context.mjs');
globalThis.fetch = () => { throw new Error('No model/network calls allowed'); };
const stdout = process.stdout.write;
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'uncaughtException'].map(name => process.listenerCount(name));
const entries = [];
try {
  for (let i = 0; i < 2; i++) {
    const cwd = path.join(process.cwd(), `project-${i}`), agentDir = process.env.PI_CODING_AGENT_DIR;
    await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
    const settingsManager = sdk.SettingsManager.inMemory({ quietStartup: true, theme: i ? 'light' : 'dark' });
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await resourceLoader.reload();
    const created = await sdk.createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader, sessionManager: sdk.SessionManager.inMemory(cwd) });
    const runtime = new AgentSessionRuntime(created.session, { cwd, agentDir, settingsManager, modelRuntime, resourceLoader }, async () => { throw new Error('No switch in this fixture'); });
    const frames = []; let exits = 0, mode;
    const terminal = new TerminalProcess({ rows: 24 + i, columns: 80 + i * 20, pid: process.pid, cwd: () => cwd,
      send: frame => { frames.push(frame); }, onExit: () => { exits++; mode.onInputCallback?.(''); } });
    const scope = createUiScope({ process: terminal, env: { ...process.env, TERM: 'xterm-256color' } }); terminal.scope = scope;
    scope.run(() => { initTheme(i ? 'light' : 'dark'); mode = new InteractiveMode(runtime, { tuiMode: 'fullscreen' }); });
    entries.push({ mode, runtime, terminal, scope, frames, exits: () => exits });
    await scope.run(() => mode.init());
  }
  entries[0].terminal.input('first-only'); entries[1].terminal.input('second-only');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(entries[0].mode.editor.getText(), 'first-only');
  assert.equal(entries[1].mode.editor.getText(), 'second-only');
  for (let i = 0; i < 2; i++) {
    const text = entries[i].frames.filter(frame => frame.type === 'output').map(frame => frame.data).join('');
    assert.ok(text.includes(i ? 'second-only' : 'first-only'), 'native renderer paints the input');
    assert.equal(text.includes(i ? 'first-only' : 'second-only'), false);
  }
  // A reset must settle native dialogs even with NO remote-control extension.
  for (const [method, args, expected] of [
    ['select', ['Pick', ['yes', 'no']], undefined], ['confirm', ['Confirm', 'Continue?'], false],
    ['input', ['Input', 'placeholder'], undefined], ['editor', ['Editor', 'prefill'], undefined],
  ]) {
    const pending = entries[0].scope.run(() => entries[0].mode.createExtensionUIContext()[method](...args));
    entries[0].scope.run(() => entries[0].mode.resetExtensionUI());
    assert.equal(await pending, expected);
  }
  let resolveFactory, disposed = 0;
  const component = { render: () => ['custom'], invalidate() {}, dispose() { disposed++; } };
  const pendingCustom = entries[0].scope.run(() => entries[0].mode.showExtensionCustom(
    () => new Promise(resolve => { resolveFactory = resolve; }), { overlay: true }));
  await new Promise(resolve => setImmediate(resolve));
  entries[0].scope.run(() => entries[0].mode.resetExtensionUI());
  assert.equal(await pendingCustom, undefined);
  resolveFactory(component); await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, 1, 'late custom component must be disposed instead of reopening a stale view');
  await assert.rejects(entries[0].scope.run(() => entries[0].mode.showExtensionCustom(() => { throw new Error('custom failure'); })), /custom failure/);
  assert.equal(entries[0].mode.rubatoCustomClosers.size, 0);
  assert.equal(entries[1].mode.editor.getText(), 'second-only');
  await entries[0].scope.run(() => entries[0].mode.shutdown());
  assert.equal(entries[0].exits(), 1); assert.equal(entries[1].exits(), 0);
  entries[1].terminal.input('-alive');
  assert.equal(entries[1].mode.editor.getText(), 'second-only-alive');
  assert.equal(process.stdout.write, stdout);
  assert.deepEqual(['SIGTERM', 'SIGINT', 'SIGHUP', 'uncaughtException'].map(name => process.listenerCount(name)), signals);
  process.stdout.write('NATIVE_UI_ISOLATION_OK\n');
} finally {
  for (const entry of entries) {
    await entry.scope.run(async () => { if (!entry.exits()) await entry.mode.shutdown(); stopThemeWatcher(); });
    entry.terminal.closeStreams();
  }
}
