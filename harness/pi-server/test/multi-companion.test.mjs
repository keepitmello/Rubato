// Real engine/socket/session journal and keepers; only model execution is deterministic RPC.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { companionEnv } from '../../companion/registry.mjs';
import { readState, writeSettings, writeState } from '../../companion/companion.mjs';
import { startCompanionKeeper } from '../../companion/keeper.mjs';
import { SessionClient } from '../src/client.mjs';
import { workerEnv } from '../src/hosted-runtime.mjs';
import { serveProfile } from '../src/profile-server.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { SessionFiles } from '../src/session-files.mjs';

test('two native keepers retain a legacy companion and a second private home over engine restart', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mci-'));
  const env = { HOME: root, PATH: process.env.PATH,
    RUBATO_COMPANIONS_FILE: path.join(root, 'companions.json') };
  const home = path.join(root, 'original');
  mkdirSync(home);
  writeFileSync(path.join(home, 'permanent-note.md'), 'untouched material');
  writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify({ companions: [
    { id: 'other', title: 'Other', home, memoryAgent: 'other', layout: { resident: 'MEMORY.md' } },
  ] }));
  const segno = companionEnv('segno', env);
  const other = companionEnv('other', env);
  mkdirSync(segno.RUBATO_COMPANION_HOME, { recursive: true });
  writeSettings({ enabled: true, greetings: { enabled: false }, heartbeat: { enabled: false } }, segno);
  writeSettings({ enabled: true, greetings: { enabled: false }, heartbeat: { enabled: false } }, other);
  const beforeSettings = readFileSync(path.join(segno.RUBATO_COMPANION_HOME, 'settings.json'));
  const agentDir = path.join(root, 'agent');
  const sessions = path.join(agentDir, 'sessions');
  const files = new SessionFiles(sessions);
  const old = await files.create({ cwd: segno.RUBATO_COMPANION_HOME, title: 'Segno', companion: true });
  writeState({ sessionId: old.id, woke: { boundary: null } }, segno);
  const cliPath = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
  const defaultsDir = path.resolve(import.meta.dirname, '../../prompts/companion');
  const errors = [];
  const wakes = [];
  let engine, keepers = [];
  async function start() {
    engine = await serveProfile({ agentDir, socketPath: path.join(root, 's'),
      workerFactory: metadata => new RpcWorker(metadata, { cliPath, env: workerEnv(metadata, undefined, env) }),
      onError: error => errors.push(error) });
    keepers = [segno, other].map(scoped => startCompanionKeeper({ env: scoped, defaultsDir, pollMs: 60_000,
      connect: async () => new SessionClient(engine.descriptor).connect(),
      notify: async (to, text, what) => wakes.push({ to, text, what }), onError: error => errors.push(error) }));
    await Promise.all(keepers.map(keeper => keeper.ready));
  }
  async function stop() {
    await Promise.all(keepers.map(keeper => keeper.close()));
    keepers = [];
    await engine?.close(); engine = undefined;
  }
  t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
  await start();
  assert.deepEqual(errors, []);
  const first = [readState(segno).sessionId, readState(other).sessionId];
  assert.equal(first[0], old.id, 'existing Segno conversation is not recreated');
  assert.notEqual(first[0], first[1]);
  const rows = engine.host.directory.value.sessions;
  assert.equal(rows.find(row => row.sessionId === first[0]).companionId, 'segno');
  assert.equal(rows.find(row => row.sessionId === first[1]).companionId, 'other');
  assert.equal(rows.find(row => row.sessionId === first[1]).cwd, realpathSync(home));
  const firstWake = wakes.find(item => item.to === first[1] && item.what === 'wake');
  assert.match(firstWake.text, /나야, Other/);
  assert.doesNotMatch(firstWake.text, /세뇨|Segno|memory\/MEMORY.md/);
  await stop();
  await start();
  assert.deepEqual([readState(segno).sessionId, readState(other).sessionId], first);
  assert.equal(engine.host.directory.value.sessions.length, 2, 'restart creates no duplicate conversation');
  assert.deepEqual(readFileSync(path.join(segno.RUBATO_COMPANION_HOME, 'settings.json')), beforeSettings);
  assert.equal(readFileSync(path.join(home, 'permanent-note.md'), 'utf8'), 'untouched material');
  assert.deepEqual(errors, []);
});
