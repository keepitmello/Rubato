import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { serveProfile } from '../src/profile-server.mjs';
import { SessionFiles } from '../src/session-files.mjs';

// Only the module surface loadHostedRuntime/loadTerminalApi touch. No agent ever runs here:
// this pins that the engine hands its one bound link to every extension factory.
const STUBS = {
  'rubato-features/rubato-components/candidate-main.mjs': `export async function prepareRubatoCandidate() {
    return { createRubatoExtensionFactories: (context) => { (globalThis.__factoryContexts ??= []).push(context); return { extensionFactories: [] }; } };
  }`,
  'rubato-features/session-ui/context.mjs': 'export const uiProcess = { env: {} }; export const createUiScope = () => ({ run: (fn) => fn(), close() {} }); export const bindUiContext = (c) => c;',
  'node_modules/@earendil-works/pi-coding-agent/dist/main.js': 'export const createCliRuntimeFactory = () => {}; export const main = () => {};',
  'node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js': 'export const parseArgs = () => ({});',
  'node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js': 'export const createAgentSessionRuntime = () => {}; export class AgentSessionRuntime {}',
  'node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js': 'export class SettingsManager {}',
  'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js': 'export class SessionManager {}',
  'node_modules/@earendil-works/pi-coding-agent/dist/core/session-cwd.js': 'export const assertSessionCwdExists = () => {};',
  'node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js': 'export const runRpcMode = () => {};',
  'node_modules/@earendil-works/pi-coding-agent/dist/migrations.js': 'export const runMigrations = () => {};',
  'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js': 'export const setThemeJsonValidator = () => {}; export const initTheme = () => {};',
  'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js': 'export const validateThemeJson = () => {};',
  'node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js': 'export const applyHttpProxySettings = () => {}; export const configureHttpDispatcher = () => {}; export const releaseScopedHttpDispatcher = () => {};',
};

test('a hosted engine passes one bound sessionLink to extension factories', async (t) => {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-link-host-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeRoot = path.join(home, 'build');
  for (const [file, source] of Object.entries(STUBS)) {
    await mkdir(path.dirname(path.join(runtimeRoot, file)), { recursive: true });
    await writeFile(path.join(runtimeRoot, file), source + '\n');
  }
  const agentDir = path.join(home, 'agent');
  const stored = await new SessionFiles(path.join(agentDir, 'sessions')).create({ cwd: home, title: 'Stored' });
  const { loadHostedRuntime } = await import('../src/hosted-runtime.mjs');
  const hosted = await loadHostedRuntime({ runtimeRoot, agentDir });
  const api = await hosted.loadTerminalApi();
  api.createExtensionFactories({ cwd: home, agentDir });
  const context = globalThis.__factoryContexts.at(-1);
  assert.equal(context.hosted, true);
  assert.equal(context.sessionLink, hosted.sessionLink.api, 'every factory gets the same engine-wide link');
  assert.deepEqual(Object.keys(context.sessionLink).sort(), ['create', 'fork', 'list', 'read', 'send', 'wait']);
  await assert.rejects(context.sessionLink.list({}), /session link is not available in this process/);

  // The profile's own socket path under a realpath'd temp dir exceeds the UNIX limit.
  const socketPath = path.join('/tmp', `rb-link-${process.pid}.sock`);
  t.after(() => rm(socketPath + '.tty', { force: true }));
  const engine = await serveProfile({ agentDir, runtimeRoot, socketPath });
  t.after(() => engine.close());
  const listed = await context.sessionLink.list({});
  assert.deepEqual(listed.sessions.map((item) => [item.sessionId, item.title]), [[stored.id, 'Stored']]);
  await engine.close();
  await assert.rejects(context.sessionLink.list({}), /not available/, 'a closed engine refuses instead of reading a dead host');
});
