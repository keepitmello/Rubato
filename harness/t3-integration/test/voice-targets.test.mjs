import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/voice/targets.mjs';
import { fixture } from './voice-fixture.mjs';

test('pins one recent mobile subscription, but never picks the latest of two', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view();
  const session = await f.service.startSession();
  assert.equal(session.threadId, 'a');
  assert.equal(session.label, 'Conversation A');
  f.view('b');
  assert.equal(resolveTarget({ presence: f.presence.snapshot(), now: f.now() }).target, 'ambiguous');
  assert.equal(f.service.status(session.voiceSessionId).threadId, 'a');
});

test('foreground loss during recording does not retarget; stale foreground creates new only at submit', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  f.view();
  f.presence.noteActivity({ ...f.mobile, visible: false, focused: false, appState: 'background' });
  const recent = await f.service.startSession();
  assert.equal(recent.threadId, 'a');
  f.advance(60_001);
  const absent = await f.service.startSession();
  assert.equal(absent.target, 'new-thread');
  assert.equal(f.commands.length, 0);
  assert.equal(f.service.status(recent.voiceSessionId).threadId, 'a');
});

test('lost subscription is unknown, not no target; selection pins a named candidate', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const disconnect = f.view(); disconnect();
  const session = await f.service.startSession();
  assert.equal(session.target, 'ambiguous');
  assert.equal(session.candidates[0].label, 'Conversation A');
  await assert.rejects(f.service.select(session.voiceSessionId, 'not-listed'), /Choose/);
  await f.service.select(session.voiceSessionId, 'a');
  await assert.rejects(f.service.select(session.voiceSessionId, 'a'), /already pinned/);
  assert.equal(f.service.status(session.voiceSessionId).threadId, 'a');
});

test('two phones are ambiguous even on the same thread; device future timestamps cannot prolong recency', () => {
  const f = fixture();
  f.view();
  const other = { ...f.mobile, clientId: 'other', rpcClientId: 2 };
  f.presence.noteSubscription({ ...other, threadId: 'a' });
  f.presence.noteActivity({ ...other, observedAt: '2999-01-01T00:00:00Z' });
  assert.equal(resolveTarget({ presence: f.presence.snapshot(), now: f.now() }).target, 'ambiguous');
  f.advance(60_001);
  assert.equal(resolveTarget({ presence: f.presence.snapshot(), now: f.now() }).target, 'new-thread');
});
