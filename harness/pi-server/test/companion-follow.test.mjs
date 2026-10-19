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

test('a lead that dies mid-turn with the engine is reported lost by the next engine', async () => {
  const w = world();
  let saved = {};
  const store = { load: () => JSON.parse(JSON.stringify(saved)), save: (records) => { saved = JSON.parse(JSON.stringify(records)); } };
  const before = w.follower({ store });
  before.follow('lead', 'segno');
  w.state.set('lead', { status: 'running' });
  await before.poll();
  assert.equal(saved.lead.started, true, 'seeing the turn run is saved');
  // The engine is killed: no close(), and the lead's runtime died with it.
  w.state.set('lead', { status: 'stored' });
  const after = w.follower({ store });
  await after.poll();
  w.tick(LOST_AFTER_MS);
  await after.poll();
  await after.close();
  assert.deepEqual(w.notices.map((notice) => [notice.targetId, notice.text]), [['lead', noticeText('lost', {})]]);
  assert.deepEqual(after.following(), []);
});

test('work handed to a busy lead whose turn is then stopped or fails is told at once: the held message starts no turn', async () => {
  for (const [stopReason, outcome] of [['aborted', 'Was stopped before finishing.'], ['error', 'Ended with an error.']]) {
    const w = world();
    const f = w.follower();
    w.state.set('lead', { status: 'running', final: { entryId: 'old', text: 'old' } });
    f.follow('lead', 'segno', { final: 'old', busy: true });
    w.state.set('lead', { status: 'idle', final: { entryId: 'cur', text: 'half', stopReason } });
    await f.poll();
    await f.close();
    assert.equal(w.notices.length, 1, stopReason);
    assert.match(w.notices[0].text, new RegExp(`^${outcome.replace('.', '\\.')}`));
  }
});

test('work handed to a busy lead is told when the turn that read it ends, even when both turns end between two looks', async () => {
  // The lead's transcript in write order; the inspector says where the handoff message stands
  // relative to the newest final, as session-link does from the file.
  const transcript = [];
  let status = 'running';
  const notices = [];
  const f = createFollower({ pollMs: 3_600_000,
    inspect: async (_id, record) => {
      const final = transcript.findLast((entry) => entry.final);
      const message = transcript.findIndex((entry) => entry.messageId === record.messageId);
      return { status, ui: [], ...(final ? { final, handoff: message >= 0 && message < transcript.indexOf(final) ? 'before' : 'after' } : {}) };
    },
    notify: async (_companion, _target, text) => { notices.push(text); } });
  transcript.push({ entryId: 'old', final: true, text: 'earlier' });
  f.follow('lead', 'segno', { final: 'old', busy: true, messageId: 'm1' });
  // The current turn ends; the held message is not written yet: not the handed work.
  transcript.push({ entryId: 'f1', final: true, text: 'the turn it was in' });
  status = 'idle';
  await f.poll();
  assert.deepEqual(notices, []);
  // The message is written, its turn runs and ends — all before the next look.
  transcript.push({ entryId: 'msg', messageId: 'm1' }, { entryId: 'f2', final: true, text: 'handed work done' });
  await f.poll();
  assert.deepEqual(notices, ['Finished its turn.\n\nIts answer:\nhanded work done']);
  assert.deepEqual(f.following(), []);
  await f.close();
});

test('a handed message written after a stopped turn, with no turn of its own, is told as stopped', async () => {
  const notices = [];
  const f = createFollower({ pollMs: 3_600_000,
    inspect: async () => ({ status: 'idle', ui: [], final: { entryId: 'f1', text: 'half', stopReason: 'aborted' }, handoff: 'after' }),
    notify: async (_companion, _target, text) => { notices.push(text); } });
  f.follow('lead', 'segno', { final: 'old', busy: true, messageId: 'm1' });
  await f.poll();
  await f.close();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^Was stopped before finishing\./);
});

test('the follower records when work was handed over, that a lead asked the user, and what finished', async () => {
  const w = world();
  const finished = [];
  let saved = {};
  const store = { load: () => saved, save: (records) => { saved = JSON.parse(JSON.stringify(records)); }, finished: (entry) => finished.push(entry) };
  const f = w.follower({ store });
  w.tick(5000);
  f.follow('lead', 'segno');
  assert.equal(saved.lead.since, 5000);
  // A question asked mid-turn: the turn still reads running, the runtime holds it unanswered.
  w.state.set('lead', { status: 'running', title: 'Deploy', cwd: '/w/ops', ui: ['q1'], pending: ['q1'] });
  await f.poll();
  assert.equal(saved.lead.asked, true, 'asked the user');
  await f.poll();
  assert.equal(saved.lead.asked, true, 'still unanswered on the next look');
  w.state.set('lead', { status: 'running', title: 'Deploy', cwd: '/w/ops', ui: ['q1'], pending: [] });
  await f.poll();
  assert.equal(saved.lead.asked, undefined, 'answered: nothing pending');
  w.state.set('lead', { status: 'idle', title: 'Deploy', cwd: '/w/ops', final: { entryId: 'e1', text: 'deployed' }, ui: ['q1'], pending: [] });
  w.tick(1000);
  await f.poll();
  await f.close();
  assert.deepEqual(finished, [{ sessionId: 'lead', outcome: 'completed', at: 6000, title: 'Deploy', cwd: '/w/ops' }]);
});

test('a runtime lost mid-turn is still told as lost when the inspector reports pending questions', async () => {
  const w = world();
  const f = w.follower();
  f.follow('lead', 'segno');
  w.state.set('lead', { status: 'running', pending: [] });
  await f.poll();
  w.state.set('lead', { status: 'stored', pending: [] });
  await f.poll();
  w.tick(LOST_AFTER_MS);
  await f.poll();
  await f.close();
  assert.deepEqual(w.notices.map((notice) => notice.text), [noticeText('lost', {})]);
});
