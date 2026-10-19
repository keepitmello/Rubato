import test from 'node:test';
import assert from 'node:assert/strict';
import { createFollower, judge, LOST_AFTER_MS, NOTICE_TRIES, noticeText } from '../src/companion-follow.mjs';

/** Conversations whose state the test sets; the follower polls them by hand. */
function world() {
  const state = new Map();
  const notices = [];
  let at = 0;
  const follower = (options = {}) => createFollower({ pollMs: 3_600_000, now: () => at,
    inspect: async (id) => {
      if (!state.has(id)) throw Object.assign(new Error('gone'), { code: 'unknown_session' });
      return { ui: [], ...state.get(id) };
    },
    notify: async (companionId, targetId, text) => { notices.push({ companionId, targetId, text }); },
    ...options });
  return { state, notices, follower, tick: (ms) => { at += ms; } };
}

test('a finished turn is told once with its answer, then the conversation is no longer followed', async (t) => {
  const w = world();
  const f = w.follower();
  t.after(() => f.close());
  f.follow('lead', 'segno');
  w.state.set('lead', { status: 'running' });
  await f.poll();
  assert.deepEqual(w.notices, []);
  w.state.set('lead', { status: 'idle', final: { entryId: 'e1', text: 'done: fixed' } });
  await f.poll();
  assert.deepEqual(w.notices, [{ companionId: 'segno', targetId: 'lead', text: 'Finished its turn.\n\nIts answer:\ndone: fixed' }]);
  assert.deepEqual(f.following(), []);
  await f.poll();
  assert.equal(w.notices.length, 1);
});

test('a stop, an error and a question to the user are each told as what they are', async (t) => {
  const w = world();
  const f = w.follower();
  t.after(() => f.close());
  for (const id of ['stopped', 'failed', 'asking', 'crashed']) f.follow(id, 'segno');
  w.state.set('stopped', { status: 'idle', final: { entryId: 's', text: 'half', stopReason: 'aborted' } });
  w.state.set('failed', { status: 'idle', final: { entryId: 'f', text: '', stopReason: 'error' } });
  w.state.set('asking', { status: 'waiting', latestAssistant: { entryId: 'q', text: 'Deploy now?' }, latestTool: { name: 'ask' } });
  w.state.set('crashed', { status: 'error' });
  await f.poll();
  const text = Object.fromEntries(w.notices.map((notice) => [notice.targetId, notice.text]));
  assert.equal(text.stopped, 'Was stopped before finishing.\n\nIts last words:\nhalf');
  assert.equal(text.failed, 'Ended with an error.');
  assert.equal(text.asking, 'Is waiting for the user to answer it (ask).\n\nWhat it said:\nDeploy now?');
  assert.equal(text.crashed, 'Ended with an error.');
  assert.deepEqual(f.following(), ['asking'], 'a question is not the end: its turn goes on once the user answers');
  await f.poll();
  assert.equal(w.notices.length, 4, 'the same question is not told twice');
  w.state.set('asking', { status: 'idle', final: { entryId: 'a', text: 'deployed' } });
  await f.poll();
  assert.equal(w.notices.at(-1).text, 'Finished its turn.\n\nIts answer:\ndeployed');
});

test('work handed to a conversation mid-turn waits for the turn after the current one', async (t) => {
  const w = world();
  const f = w.follower();
  t.after(() => f.close());
  w.state.set('lead', { status: 'running', final: { entryId: 'old', text: 'old' } });
  f.follow('lead', 'segno', { final: 'old', busy: true });
  w.state.set('lead', { status: 'idle', final: { entryId: 'current', text: 'its own turn' } });
  await f.poll();
  assert.deepEqual(w.notices, []);
  w.state.set('lead', { status: 'idle', final: { entryId: 'mine', text: 'my work' } });
  await f.poll();
  assert.match(w.notices[0].text, /my work/);
});

test('a runtime that went away mid-turn and stays away is told as stopped; a deleted conversation is dropped quietly', async (t) => {
  const w = world();
  const f = w.follower();
  t.after(() => f.close());
  f.follow('lead', 'segno');
  f.follow('deleted', 'segno');
  w.state.set('lead', { status: 'running' });
  await f.poll();
  w.state.set('lead', { status: 'stored' });
  await f.poll();
  w.tick(LOST_AFTER_MS - 1);
  await f.poll();
  assert.deepEqual(w.notices.map((n) => n.targetId), []);
  w.tick(1);
  await f.poll();
  assert.deepEqual(w.notices.map((n) => [n.targetId, n.text]), [['lead', noticeText('lost', {})]]);
  assert.deepEqual(f.following(), []);
});

test('what is followed survives a restart through the store, and a notice that cannot be delivered is retried, then dropped', async (t) => {
  const w = world();
  let saved = {};
  const store = { load: () => saved, save: (records) => { saved = JSON.parse(JSON.stringify(records)); } };
  const first = w.follower({ store });
  first.follow('lead', 'segno');
  await first.close();
  assert.deepEqual(Object.keys(saved), ['lead']);

  let fails = 0;
  const second = w.follower({ store, notify: async () => { fails++; throw new Error('segno is loading'); }, onError: () => {} });
  t.after(() => second.close());
  w.state.set('lead', { status: 'idle', final: { entryId: 'e', text: 'done' } });
  for (let i = 0; i < NOTICE_TRIES; i++) await second.poll();
  assert.equal(fails, NOTICE_TRIES);
  assert.deepEqual(second.following(), []);
  assert.deepEqual(saved, {});
});

test('judge waits while the turn runs', () => {
  const record = { base: { final: null, waiting: false, ui: [] }, skip: 0 };
  assert.equal(judge(record, { status: 'running', ui: [], final: { entryId: 'x' } }, 0), undefined);
  assert.equal(judge(record, { status: 'idle', ui: [] }, 0), undefined);
});
