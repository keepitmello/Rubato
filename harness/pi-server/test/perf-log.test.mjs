import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSessionHost } from '../src/host.mjs';
import { SessionFiles } from '../src/session-files.mjs';
import { SLOW_OPEN_MS, watchStalls, withOperation, operations, describeStall } from '../src/perf-log.mjs';
import { startSessionServer } from '../src/host.mjs';
import { SessionClient } from '../src/client.mjs';

test('a held engine thread is logged with how long it was held, a turning one is not', () => {
  const lines = [];
  let clock = 0; let tick;
  const stop = watchStalls({ log: (line) => lines.push(line), now: () => clock, every: (fn) => { tick = fn; return {}; }, stop: () => { tick = undefined; },
    sample: false });
  clock += 200; tick();
  clock += 900; tick();
  clock += 1700; tick();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^engine stalled 1500ms — no sample/);
  stop();
  assert.equal(tick, undefined);
});

test('a conversation that takes long to open is logged with its id and time', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-perf-log-'));
  let started = 0;
  class Worker extends EventEmitter {
    constructor(metadata) { super(); this.id = 'w'; this.metadata = metadata; this.terminated = new Promise((resolve) => { this.finish = resolve; }); }
    async start() { started += 1; if (started === 1) await new Promise((resolve) => setTimeout(resolve, SLOW_OPEN_MS + 50)); return { sessionId: this.metadata.id, isStreaming: false }; }
    stop() { this.finish(); return this.terminated; }
    request() { return this.start(); }
    reply() {}
  }
  const lines = [];
  const files = new SessionFiles(root);
  const slow = await files.create({ cwd: root });
  const quick = await files.create({ cwd: root });
  const host = createSessionHost({ sessionsDir: root, serverId: 'test', pollMs: 0, idleMs: null,
    workerFactory: (value) => new Worker(value), log: (line) => lines.push(line) });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  await host.openSession(await host.resolveSession(slow.id));
  await host.openSession(await host.resolveSession(quick.id));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^session ${slow.id} opened in \\d+ms$`));
});

const SEGNO = '01a19761-0000-7000-8000-000000000001';
// Named so the stall line can be checked for it.
function holdTheThread(ms) { const end = performance.now() + ms; let spin = 0; while (performance.now() < end) spin += Math.sqrt(spin + 1); return spin; }

test('a stall line names the operation, the conversation and the code that held the thread', async () => {
  const lines = [];
  const stop = watchStalls({ log: (line) => lines.push(line), thresholdMs: 600, title: (id) => (id === SEGNO ? '세그노' : undefined) });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await withOperation({ op: 'rubato.session-control.v1.snapshot', session: SEGNO }, async () => { await null; holdTheThread(1200); });
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally { stop(); }
  // A loaded machine can add a stall of its own (a late timer); the held one is the line that names it.
  const held = lines.find((line) => line.includes('snapshot')) ?? lines.join('\n');
  assert.match(held, new RegExp(`^engine stalled \\d+ms — rubato\\.session-control\\.v1\\.snapshot · session ${SEGNO} "세그노" \\(\\d+/\\d+\\) · at holdTheThread test/perf-log\\.test\\.mjs:\\d+`));
});

test('the share of each operation and the code it ran are summarized from the samples', () => {
  const scan = { label: { op: 'directory scan' }, frames: ['list session-files.mjs:80'] };
  const open = { label: { op: 'open', session: SEGNO }, frames: ['SessionManager.open core/session-manager.js:120', 'createRuntime src/hosted-runtime.mjs:110'] };
  assert.equal(describeStall([open, scan, open], { title: () => 'Segno' }),
    `open · session ${SEGNO} "Segno" (2/3), directory scan (1/3) · at SessionManager.open core/session-manager.js:120 < createRuntime src/hosted-runtime.mjs:110`);
  assert.equal(describeStall([{ label: undefined, frames: [] }]), 'outside JavaScript (1/1)');
});

test('an app request runs under its service member and conversation, through the real socket server', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-perf-label-'));
  const seen = [];
  const serverId = randomUUID();
  class Worker extends EventEmitter {
    constructor(metadata) { super(); this.id = 'w'; this.metadata = metadata; this.terminated = new Promise((resolve) => { this.finish = resolve; }); }
    async start() { seen.push(operations.getStore()); return { sessionId: this.metadata.id, isStreaming: false }; }
    stop() { this.finish(); return this.terminated; }
    async request(command) { return command.type === 'get_state' ? { sessionId: this.metadata.id, isStreaming: false } : {}; }
    reply() {}
  }
  const service = await startSessionServer({ sessionsDir: path.join(root, 's'), socketPath: path.join(root, 'pi.sock'), serverId,
    pollMs: 0, idleMs: null, workerFactory: (metadata) => new Worker(metadata) });
  const client = await new SessionClient({ socketPath: path.join(root, 'pi.sock'), serverId }).connect();
  t.after(async () => { await client.close(); await service.close(); await rm(root, { recursive: true, force: true }); });
  await client.catalogue(root);
  const created = await client.create({ cwd: root });
  await client.attach(created.sessionId);
  assert.deepEqual(seen, [{ op: 'rubato.session-directory.v1.catalogue', session: undefined },
    { op: 'rubato.session-management.v1.attach', session: created.sessionId }]);
});
