import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionHost } from '../src/host.mjs';
import { SessionFiles } from '../src/session-files.mjs';
import { SLOW_OPEN_MS, watchStalls } from '../src/perf-log.mjs';

test('a held engine thread is logged with how long it was held, a turning one is not', () => {
  const lines = [];
  let clock = 0; let tick;
  const stop = watchStalls({ log: (line) => lines.push(line), now: () => clock, every: (fn) => { tick = fn; return {}; }, stop: () => { tick = undefined; } });
  clock += 200; tick();
  clock += 900; tick();
  clock += 1700; tick();
  assert.deepEqual(lines, ['engine stalled 1500ms']);
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
