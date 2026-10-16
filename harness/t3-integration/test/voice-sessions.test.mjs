import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VOICE_DISPATCH_MODE, VOICE_AUTHOR, voiceMessageId } from '../src/voice/submit.mjs';
import { VOICE_SESSION_TTL_MS } from '../src/voice/sessions.mjs';
import { fixture } from './voice-fixture.mjs';

test('a send to a busy thread goes into T3\'s queue at once, answers queued, and runs after the turn', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view(); f.busy();
  const s = await f.service.startSession();
  const input = { voiceSessionId: s.voiceSessionId, text: 'after this turn' };
  assert.equal((await f.service.submit(input)).status, 'queued');
  assert.equal(f.sent().length, 1);
  assert.deepEqual(f.sent()[0].dispatchMode, VOICE_DISPATCH_MODE);
  assert.equal(f.sent()[0].messageId, voiceMessageId(s.voiceSessionId));
  assert.equal(f.sent()[0].createdBy, VOICE_AUTHOR.createdBy);
  assert.equal(f.sent()[0].creationSource, VOICE_AUTHOR.creationSource);
  // The same text again answers from the session, never a second message.
  assert.equal((await f.service.submit(input)).status, 'queued');
  assert.equal(f.sent().length, 1);
  assert.equal(f.runOf(voiceMessageId(s.voiceSessionId)).status, 'queued');
  f.finishTurn();
  assert.equal(f.runOf(voiceMessageId(s.voiceSessionId)).status, 'running');
  assert.equal(f.service.status(s.voiceSessionId).deepLink, 't3code://threads/env/a');
});

test('an idle thread starts the message as sent; the text leaves private state', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view();
  const s = await f.service.startSession();
  const result = await f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'now' });
  assert.equal(result.status, 'sent');
  assert.equal(f.runOf(voiceMessageId(s.voiceSessionId)).status, 'running');
  assert.equal(f.store.get(s.voiceSessionId).text, undefined);
});

test('concurrent different text is rejected even before the first send completes', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ beforeDispatch: () => gate }); t.after(() => f.service.close());
  f.view();
  const s = await f.service.startSession();
  const first = f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'one' });
  await assert.rejects(f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'two' }), /different text/);
  release(); await first;
  assert.deepEqual(f.sent().map((c) => c.text), ['one']);
});

test('cancel takes a queued message back out of T3\'s queue, but not once its turn began', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view(); f.busy();
  const first = await f.service.startSession();
  await f.service.submit({ voiceSessionId: first.voiceSessionId, text: 'never mind' });
  assert.equal((await f.service.cancel(first.voiceSessionId)).status, 'cancelled');
  const withdraw = f.commands.find((c) => c.type === 'queued-run.cancel');
  const queuedRun = f.runOf(voiceMessageId(first.voiceSessionId));
  assert.deepEqual([withdraw.threadId, withdraw.runId], ['a', queuedRun.id]);
  assert.equal(queuedRun.status, 'cancelled');

  const second = await f.service.startSession();
  await f.service.submit({ voiceSessionId: second.voiceSessionId, text: 'keep this' });
  f.finishTurn();
  await assert.rejects(f.service.cancel(second.voiceSessionId), /already being sent/);
  assert.equal(f.service.status(second.voiceSessionId).status, 'queued');
});

test('an expired session sends nothing', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view();
  const s = await f.service.startSession();
  f.advance(VOICE_SESSION_TTL_MS + 1);
  await assert.rejects(f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'late' }), /expired/);
  assert.equal(f.sent().length, 0);
});

test('new thread is lazy, submitted once, titled like a composer message, with the environment deep link', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const s = await f.service.startSession();
  assert.equal(f.threads.size, 1);
  const input = { voiceSessionId: s.voiceSessionId, text: '새 대화' };
  const result = await f.service.submit(input);
  await f.service.submit(input);
  assert.equal(f.threads.size, 2);
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].titleSeed, '새 대화');
  const create = f.commands.find((c) => c.type === 'thread.create');
  assert.deepEqual(create.modelSelection, f.projects.get('p').defaultModelSelection);
  assert.equal(result.status, 'sent');
  assert.ok(result.deepLink.startsWith('t3code://threads/env/voice-thread-'));
});

test('a project without a default model fails visibly before creating a thread', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.projects.get('p').defaultModelSelection = null;
  const s = await f.service.startSession();
  const result = await f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'hello' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'no-project-model');
  assert.equal(f.threads.size, 1);
});

test('draft mode can transcribe but cannot submit; cancellation while transcribing discards the result', async (t) => {
  let release;
  const f = fixture({ transcriber: () => new Promise((resolve) => { release = resolve; }) });
  t.after(() => f.service.close());
  const s = await f.service.startSession({ mode: 'draft' });
  const pending = f.service.transcribe({ voiceSessionId: s.voiceSessionId, audio: Buffer.from('audio') });
  await f.service.cancel(s.voiceSessionId);
  release({ text: 'too late' });
  await assert.rejects(pending, /no longer open/);
  const draft = await f.service.startSession({ mode: 'draft' });
  await assert.rejects(f.service.submit({ voiceSessionId: draft.voiceSessionId, text: 'no auto-send' }), /cannot send/);
  assert.equal(f.sent().length, 0);
});

test('a claim a restart interrupted is sent once at startup; the state file stays private and textless', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'voice-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.json');
  const f = fixture({ filename });
  f.view();
  const s = await f.service.startSession();
  // The claim is durable before dispatch; the process stops here.
  f.store.update(s.voiceSessionId, { fingerprint: 'x', text: 'persisted claim', state: 'pending' });
  await f.service.close();
  const resumed = fixture({ filename }); t.after(() => resumed.service.close());
  await resumed.service.wake();
  assert.equal(resumed.sent().length, 1);
  assert.equal(resumed.service.status(s.voiceSessionId).status, 'sent');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(filename, 'utf8')).includes('persisted claim'));
});

test('a message the old voice queue was still holding is handed to T3 after the update', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'voice-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.json');
  await writeFile(filename, JSON.stringify({ version: 1, lastMobileProject: 'p', sessions: [
    { voiceSessionId: 'held', target: 'existing-thread', threadId: 'a', projectId: 'p', label: 'A',
      createdAt: 100_000, expiresAt: 100_000 + VOICE_SESSION_TTL_MS, state: 'queued', fingerprint: 'x', text: 'held text' },
    { voiceSessionId: 'done', target: 'existing-thread', threadId: 'a', projectId: 'p', label: 'A',
      createdAt: 100_000, expiresAt: 100_000 + VOICE_SESSION_TTL_MS, state: 'sent', fingerprint: 'y' },
  ] }));
  const f = fixture({ filename }); t.after(() => f.service.close());
  await f.service.wake();
  assert.deepEqual(f.sent().map((c) => c.text), ['held text']);
  assert.equal(f.service.status('held').status, 'sent');
});

test('a missing target fails visibly instead of silently creating another thread', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view(); const s = await f.service.startSession();
  f.threads.delete('a');
  const result = await f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'hello' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'thread-unavailable');
  assert.equal(f.sent().length, 0);
});
