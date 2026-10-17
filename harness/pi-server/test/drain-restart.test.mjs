import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serveProfile } from '../src/profile-server.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { SessionClient } from '../src/client.mjs';
import { resumeFilePath, takeResumeFile } from '../src/drain.mjs';

const fixture = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const workers = (metadata) => new RpcWorker(metadata, { cliPath: fixture });
const until = async (predicate, label) => {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await delay(10); }
  throw new Error('timeout: ' + label);
};
/** The gate a hosted build ships (pi-runtime drain-gate), driven by the test. */
const fakeGate = () => ({ quiet: false, began: 0, begin() { this.began++; }, end() {} });
const exists = (file) => access(file).then(() => true, () => false);

test('a restart waits for running work, then the next engine continues it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-drain-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const gate = fakeGate();
  const first = await serveProfile({ agentDir: root, workerFactory: workers, drainGate: gate });
  t.after(() => first.close());
  const client = await new SessionClient(first.descriptor).connect();
  t.after(() => client.close());
  // A: a run in flight. B: a lead idle while its children work. C: idle, nothing to do.
  const running = await client.create({ cwd: root, title: 'Running' });
  const lead = await client.create({ cwd: root, title: 'Lead' });
  const idle = await client.create({ cwd: root, title: 'Idle' });
  await client.attach(lead.sessionId);
  await client.command({ type: 'prompt', message: 'busy-children' });
  await until(async () => (await client.snapshot()).state.isStreaming === false, 'lead settles');
  await client.attach(idle.sessionId);
  await client.attach(running.sessionId);
  const states = [];
  const unsubscribe = await client.subscribeSession((state) => states.push(state));
  await client.command({ type: 'prompt', message: 'background' });

  let closed = false;
  const closing = first.close({ drain: true }).then(() => { closed = true; });
  const resumeFile = resumeFilePath(path.join(root, 'server'));
  await until(() => exists(resumeFile), 'resume file at the start of the drain');
  // The app reads this and keeps the turn open across the restart.
  await until(() => states.some((state) => state.restarting === true), 'presentation told');
  assert.equal(gate.began, 1);
  const early = JSON.parse(await readFile(resumeFile, 'utf8'));
  assert.deepEqual(early.sessions.map(({ sessionId, continue: go }) => [sessionId, go]).sort(),
    [[running.sessionId, true], [lead.sessionId, false]].sort());
  await delay(200);
  assert.equal(closed, false, 'the engine waits while a run has not reached the gate');
  gate.quiet = true;
  await closing;
  await unsubscribe().catch(() => {});

  const second = await serveProfile({ agentDir: root, workerFactory: workers, drainGate: fakeGate() });
  t.after(() => second.close());
  const resumed = await second.resumed;
  assert.deepEqual(resumed.map(({ sessionId, continued }) => [sessionId, continued]).sort(),
    [[running.sessionId, true], [lead.sessionId, false]].sort());
  assert.equal(await exists(resumeFile), false, 'taken once');
  const reader = await new SessionClient(second.descriptor).connect();
  t.after(() => reader.close());
  await until(async () => (await reader.transcript(running.sessionId)).messages
    .some((message) => message.role === 'assistant' && message.content?.[0]?.text === 'resumed after restart'), 'run continued');
  // Only what had work was reopened.
  const listed = await reader.list();
  assert.equal(listed.find((item) => item.sessionId === idle.sessionId).runtimeId, null);
});

test('a run that never reaches the gate is cut when the drain times out', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-drain-timeout-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = await serveProfile({ agentDir: root, workerFactory: workers, drainGate: fakeGate(), drainTimeoutMs: 300 });
  t.after(() => first.close());
  const client = await new SessionClient(first.descriptor).connect();
  t.after(() => client.close());
  const record = await client.create({ cwd: root, title: 'Stuck' });
  await client.attach(record.sessionId);
  await client.command({ type: 'prompt', message: 'background' });
  const started = Date.now();
  await first.close({ drain: true });
  assert.ok(Date.now() - started < 5000);
  const saved = await takeResumeFile(resumeFilePath(path.join(root, 'server')));
  assert.deepEqual(saved, [{ sessionId: record.sessionId, continue: true }]);
});

test('an engine without a gate closes at once and leaves nothing to resume', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-drain-none-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = await serveProfile({ agentDir: root, workerFactory: workers });
  const client = await new SessionClient(first.descriptor).connect();
  t.after(() => client.close());
  const record = await client.create({ cwd: root, title: 'Old build' });
  await client.attach(record.sessionId);
  await client.command({ type: 'prompt', message: 'background' });
  await first.close({ drain: true });
  assert.equal(await exists(resumeFilePath(path.join(root, 'server'))), false);
});

test('a resume file from long ago is dropped, not replayed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-drain-stale-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const file = resumeFilePath(root);
  await writeFile(file, JSON.stringify({ version: 1, writtenAt: Date.now() - 2 * 60 * 60_000, sessions: [{ sessionId: 'x', continue: true }] }));
  assert.deepEqual(await takeResumeFile(file), []);
  assert.equal(await exists(file), false);
  await writeFile(file, JSON.stringify({ version: 1, writtenAt: Date.now(), sessions: [{ sessionId: 'x', continue: true }, { bogus: 1 }] }));
  assert.deepEqual(await takeResumeFile(file), [{ sessionId: 'x', continue: true }]);
});
