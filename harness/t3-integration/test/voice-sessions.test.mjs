import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './voice-fixture.mjs';

test('busy submit acknowledges queue; a turn event releases it once without steering', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view(); f.threads.get('a').session.status = 'running';
  const s = await f.service.startSession();
  const input = { voiceSessionId: s.voiceSessionId, text: 'after this turn' };
  assert.equal((await f.service.submit(input)).status, 'queued');
  assert.equal(f.sent().length, 0);
  assert.equal(f.commands[0].activity.payload.state, 'queued');
  assert.equal((await f.service.submit(input)).status, 'queued');
  f.threads.get('a').session.status = 'ready';
  await f.service.wake();
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].onlyWhenIdle, true);
  assert.equal((await f.service.submit(input)).status, 'sent');
  assert.equal(f.sent().length, 1);
  assert.equal(f.service.status(s.voiceSessionId).deepLink, 't3code://threads/env/a');
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
  assert.deepEqual(f.sent().map((c) => c.message.text), ['one']);
});

test('cancel and expiry prevent queued sends after the thread becomes idle', async (t) => {
  for (const action of ['cancel', 'expire']) {
    const f = fixture(); t.after(() => f.service.close());
    f.view(); f.threads.get('a').session.status = 'running';
    const s = await f.service.startSession();
    await f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'never send' });
    if (action === 'cancel') await f.service.cancel(s.voiceSessionId);
    else f.advance(600_001);
    f.threads.get('a').session.status = 'ready';
    await f.service.wake();
    assert.equal(f.sent().length, 0);
    assert.equal(f.service.status(s.voiceSessionId).status, action === 'cancel' ? 'cancelled' : 'expired');
  }
});

test('new thread is lazy, submitted once, and returns the environment—not project—deep link', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const s = await f.service.startSession();
  assert.equal(f.threads.size, 1);
  const input = { voiceSessionId: s.voiceSessionId, text: '새 대화' };
  const result = await f.service.submit(input);
  await f.service.submit(input);
  assert.equal(f.threads.size, 2);
  assert.equal(f.sent().length, 1);
  assert.ok(result.deepLink.startsWith('t3code://threads/env/voice-thread-'));
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

test('queued claim survives restart, private state removes text after successful send', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'voice-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'state.json');
  const f = fixture({ filename });
  f.view(); f.threads.get('a').session.status = 'running';
  const s = await f.service.startSession();
  await f.service.submit({ voiceSessionId: s.voiceSessionId, text: 'persisted queue' });
  await f.service.close();
  const resumed = fixture({ filename }); t.after(() => resumed.service.close());
  await resumed.service.wake();
  assert.equal(resumed.sent().length, 1);
  assert.equal(resumed.service.status(s.voiceSessionId).status, 'sent');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(filename, 'utf8')).includes('persisted queue'));
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
