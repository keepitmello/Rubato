// Called only by an isolated harness with scratch HOME/cwd/profile and loopback
// networking. Five REAL source CLI processes, not five in-process fake terminals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { SessionClient } from '../../src/client.mjs';
import { ensureProfileEngine } from '../../src/discovery.mjs';
import { ensureSessionDefaults, sessionDefaultsLookCurrent } from '../../../rubato-pi/src/session-defaults.mjs';

let [root, profile] = process.argv.slice(2);
root = await realpath(root); profile = await realpath(profile);
assert.ok(process.send && process.cwd().startsWith('/private/tmp/rb-common-'));
const legacy = process.env.RUBATO_COMMON_LEGACY === '1';
const count = Number(process.env.RUBATO_COMMON_COUNT ?? 5);
const idleMs = Number(process.env.RUBATO_MEASURE_IDLE_MS ?? 0);
assert.ok([1, 5].includes(count) && Number.isInteger(idleMs) && idleMs >= 0 && idleMs <= 30000);
const requests = [], clients = [];
let gui, descriptor, enginePid;
const origin = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body); requests.push({ body: parsed, auth: req.headers.authorization });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: { role: 'assistant', content: 'loopback-reply' }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` + 'data: [DONE]\n\n');
});
origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
const cwd = path.join(process.cwd(), 'project'); await mkdir(path.join(cwd, '.rubato'), { recursive: true });
await writeFile(path.join(cwd, '.rubato/rubato.jsonc'), JSON.stringify({ memory: { agent: 'process-fixture' } }));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'fixture', defaultModel: 'local' }));
await writeFile(path.join(profile, 'models.json'), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${origin.address().port}/v1`, api: 'openai-completions', apiKey: '$RUBATO_TEST_KEY',
  models: [{ id: 'local', contextWindow: 128000, maxTokens: 2048 }],
} } }));
// Benchmark old workers after a canonical bootstrap, not the unrelated legacy
// truncate/read race. Shared mode deliberately exercises the cold engine owner.
if (legacy) ensureSessionDefaults(profile);
const stage = JSON.parse(await readFile(path.join(root, 'rubato-pi-stage.json')));
await writeFile(path.join(root, 'rubato-install.json'), JSON.stringify({ version: 1, state: 'ready',
  candidateEntry: 'rubato-features/rubato-components/candidate-main.mjs',
  features: legacy ? stage.features.filter(x => !['session-ui', 'session-transport'].includes(x)) : stage.features }));
const extension = path.join(process.cwd(), 'pid.mjs');
await writeFile(extension, 'export default pi => { pi.rpc.handle("fixture.pid", () => ({ pid: process.pid })); pi.rpc.handle("fixture.cpu", () => process.cpuUsage()); };\n');
const env = { ...process.env, RUBATO_STOCK_ENGINE_DIR: root, RUBATO_CANDIDATE_AGENT_DIR: profile,
  RUBATO_PI_CODING_AGENT_DIR: profile, RUBATO_NO_KIRO_ENSURE: '1', RUBATO_SPEED_INDEX: '0', NO_COLOR: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
// The outer isolated harness observes only descendants it created. It owns the
// engine termination signal because the fixture's sandbox forbids foreign signals.
const outer = phase => new Promise(resolve => {
  const receive = message => { if (message.phase === phase) { process.off('message', receive); resolve(message); } };
  process.on('message', receive); process.send({ phase, enginePid, label: legacy ? 'legacy' : 'shared' });
});
try {
  const began = performance.now();
  for (let i = 0; i < count; i++) {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../../rubato-pi/bin/rubato-pi.mjs'),
      '--mode', 'rpc', '--offline', '--approve', '--provider', 'fixture', '--model', 'local', '--extension', extension],
    { cwd, env: { ...env, RUBATO_TEST_KEY: `key-${i}` }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', x => stderr += x);
    const frames = [], waiters = new Set(); let sequence = 0;
    createInterface({ input: child.stdout }).on('line', line => {
      try { frames.push(JSON.parse(line)); } catch { frames.push({ invalid: line }); }
      for (const notify of waiters) notify();
    });
    const exited = once(child, 'close');
    const wait = predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`CLI${i} timed out: ${stderr}; ${JSON.stringify(frames.slice(-3))}`)); }, 35000);
      const check = () => { const value = predicate(); if (value) { clearTimeout(timer); waiters.delete(check); resolve(value); } };
      waiters.add(check); check();
    });
    const request = async (type, extra = {}) => {
      const id = String(++sequence); child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n');
      const frame = await wait(() => frames.find(x => x.type === 'response' && x.id === id));
      assert.equal(frame.success, true, JSON.stringify(frame)); return frame.data;
    };
    clients.push({ child, frames, wait, request, exited, errors: () => stderr });
  }
  // A GUI cold-open contends with the five source launchers for the SAME lock.
  const discovering = legacy ? undefined : ensureProfileEngine({ descriptorPath: path.join(profile, 'server/connection.json'),
    runtimeRoot: root, env: { ...env, RUBATO_TEST_KEY: 'gui-key' }, requireTerminal: true });
  const states = await Promise.all(clients.map(client => client.request('get_state')));
  const pids = await Promise.all(clients.map(client => client.request('extension_request', { name: 'fixture.pid' })));
  if (!legacy) { enginePid = pids[0].pid; assert.equal(new Set(pids.map(x => x.pid)).size, 1); }
  else assert.equal(new Set(pids.map(x => x.pid)).size, count);
  assert.equal(new Set(states.map(x => x.sessionId)).size, count);
  descriptor = await discovering;
  if (!legacy) {
    assert.equal(sessionDefaultsLookCurrent(profile), true, 'the winning engine owns profile bootstrap');
    const models = JSON.parse(await readFile(path.join(profile, 'models.json')));
    assert.equal(models.providers.fixture.apiKey, '$RUBATO_TEST_KEY', 'concurrent startup preserves user providers');
  }
  if (descriptor) {
    gui = await new SessionClient(descriptor).connect(); await gui.attach(states[0].sessionId);
    await assert.rejects(gui.command({ type: 'prompt', message: 'not-authorized' }), /controlled by a CLI/);
  }
  const readyMs = Math.round(performance.now() - began);
  const idleTree = await outer('measure-owned');
  await Promise.all(clients.map((client, i) => client.request('prompt', { message: `client-marker-${i}` })));
  await Promise.all(clients.map(client => client.wait(() => client.frames.some(x => x.type === 'agent_settled'))));
  for (let i = 0; i < count; i++) {
    const matching = requests.filter(x => JSON.stringify(x.body).includes(`client-marker-${i}`));
    assert.ok(matching.length); assert.ok(matching.every(x => x.auth === `Bearer key-${i}`), `CLI${i} credential isolation`);
  }
  let idleCpu;
  if (idleMs) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const representatives = [...new Map(pids.map((entry, i) => [entry.pid, clients[i]])).values()];
    const before = await Promise.all(representatives.map(client => client.request('extension_request', { name: 'fixture.cpu' })));
    const began = performance.now();
    await new Promise(resolve => setTimeout(resolve, idleMs));
    const after = await Promise.all(representatives.map(client => client.request('extension_request', { name: 'fixture.cpu' })));
    const elapsedMs = performance.now() - began;
    const microseconds = after.reduce((sum, value, i) => sum + value.user + value.system - before[i].user - before[i].system, 0);
    idleCpu = { elapsedMs, microseconds, oneCorePercent: microseconds / (elapsedMs * 10),
      boundary: 'Unique conversation engine PIDs only, not frontend or tool-child CPU; five-second settle then measured idle.' };
  }
  const warmTree = await outer('measure-owned');
  const guiRuntimeId = gui && (await gui.snapshot()).runtimeId;
  clients[0].child.stdin.end(); assert.equal((await clients[0].exited)[0], 0, clients[0].errors());
  if (gui) {
    assert.equal((await gui.snapshot()).runtimeId, guiRuntimeId);
    await gui.command({ type: 'prompt', message: 'gui-after-close' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GUI continuation timeout')), 15000);
      let unsubscribe;
      gui.subscribeSession(state => {
        if (state.status === 'idle' && requests.some(x => JSON.stringify(x.body).includes('gui-after-close'))) {
          clearTimeout(timer); void unsubscribe?.(); resolve();
        }
      }).then(value => { unsubscribe = value; }, reject);
    });
    assert.ok(requests.filter(x => JSON.stringify(x.body).includes('gui-after-close')).every(x => x.auth === 'Bearer key-0'));
    await gui.close(); gui = undefined;
  }
  for (const client of clients.slice(1)) client.child.stdin.end();
  for (const client of clients.slice(1)) assert.equal((await client.exited)[0], 0, client.errors());
  assert.ok(clients.every(client => !client.frames.some(x => x.invalid)));
  process.send({ ok: true, phase: 'source-processes', legacy, readyMs, enginePid, pids, idleTree, warmTree, idleCpu,
    localRequests: requests.length, sessionCount: states.length });
} catch (error) { process.send({ ok: false, error: error.stack, legacy }); process.exitCode = 1; }
finally {
  await gui?.close().catch(() => {});
  for (const client of clients) client.child.stdin.end();
  if (!legacy) await outer('stop-owned-engine');
  origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  process.disconnect();
}
