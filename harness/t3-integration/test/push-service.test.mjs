import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ACTIVITY_REFRESH_MS, activityCard, alertFor, createPushService, createTelegramSwitch, FRESH_MS, handlePushRequest, phoneSoundFile, readDesktopSounds, replySummary, runLength, THREAD_STACK, threadCollapseId } from '../src/push/service.mjs';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { readMessengerSettings, writeMessengerSettings } from '../../companion/messenger/store.mjs';

const NOW = Date.UTC(2026, 10, 13, 12);
const state = (phase, extra = {}) => ({
  environmentId: 'env-1', threadId: 'thread-1', projectTitle: 'rubato', threadTitle: 'Fix the login bug', phase,
  headline: { completed: 'Agent finished', failed: 'Agent failed', waiting_for_approval: 'Approval needed',
    waiting_for_input: 'Waiting for input', running: 'Agent is working', starting: 'Starting agent' }[phase],
  modelTitle: 'claude-opus-5-5', updatedAt: new Date(NOW - 1000).toISOString(), deepLink: '/threads/env-1/thread-1', ...extra,
});

function service(t, { now = () => NOW, calls = [], telegram, log = () => {}, sounds = { completion: 'builtin:completion', input: 'builtin:input' } } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rubato-push-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sent = [];
  const phones = [];
  const grants = {
    add: entry => { phones.push(entry); return { grantId: entry.grantId }; },
    remove: id => phones.splice(phones.findIndex(item => item.grantId === id), 1).length,
    list: () => phones.map(({ grant: _grant, ...rest }) => rest),
    setPreferences: (deviceId, preferences) => { const phone = phones.find(item => item.deviceId === deviceId); if (!phone) return null; phone.preferences = { ...phone.preferences, ...preferences }; return phone.preferences; },
    pushAll: async (message, { preference }) => { sent.push({ ...message, preference }); return [{ ok: true }]; },
  };
  const onCall = (companion, at) => calls.some(call => call.companion === companion && call.from <= at && at <= call.to);
  // The Live Activity's timers wait for the test to fire them.
  const timers = [];
  const setTimer = (run, ms) => { const timer = { run, ms }; timers.push(timer); return timer; };
  const clearTimer = timer => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); };
  return { push: createPushService({ home, grants, now, onCall, log, companionTitle: id => ({ roo: 'Roo' })[id] ?? id,
    telegram: telegram ?? { read: () => null, write: () => null }, desktopSounds: () => sounds, setTimer, clearTimer }), sent, phones, timers };
}
const ask = (push, action, body = {}) => handlePushRequest(push,
  new Request(`http://mac/rubato/push/${action}`, { method: 'POST', body: JSON.stringify(body) }));

test('a thread that starts needing the person, or finishes, is one alert', async t => {
  const { push, sent } = service(t);
  for (const phase of ['starting', 'running', 'waiting_for_approval', 'waiting_for_approval', 'running', 'completed', 'completed'])
    await push.threadChanged('thread-1', state(phase));
  assert.deepEqual(sent.map(item => item.body), ['Approval needed', 'Agent finished']);
  assert.deepEqual(sent[1], {
    kind: 'alert', title: 'Fix the login bug', subtitle: 'rubato', body: 'Agent finished', threadId: THREAD_STACK,
    collapseId: threadCollapseId('env-1', 'thread-1'),
    category: 'rubato.thread', rubato: { kind: 'thread' }, preference: 'threads', sound: 'rubato-completion.caf',
    data: { environmentId: 'env-1', threadId: 'thread-1', deepLink: '/threads/env-1/thread-1' },
  });
  assert.equal(sent[0].sound, 'rubato-input.caf');
});

test("a finish shows the agent's last answer and how long the run took, and replaces the thread's earlier alert", async t => {
  const { push, sent } = service(t);
  const answers = { 'thread-1': '## 결과\n\n원인은 **중계 서버**의 `APNs` 키 누락이야.\n\n| a | b |\n|---|---|\n\n- 키만 넣으면 돼' };
  push.threadReplies(async threadId => answers[threadId] ?? null);
  const run = { startedAt: new Date(NOW - 1000 - 14 * 60_000).toISOString(), lastError: null };
  await push.threadChanged('thread-1', state('running'), run);
  await push.threadChanged('thread-1', state('completed'), run);
  assert.equal(sent[0].subtitle, 'rubato · 14m');
  assert.equal(sent[0].body, '결과 원인은 중계 서버의 APNs 키 누락이야. 키만 넣으면 돼');
  // The next alert from this thread carries the same tag, so the phone keeps one card; another thread its own.
  await push.threadChanged('thread-1', state('waiting_for_approval'), run);
  await push.threadChanged('thread-2', state('completed', { threadId: 'thread-2' }), run);
  assert.equal(sent[1].collapseId, sent[0].collapseId);
  assert.notEqual(sent[2].collapseId, sent[0].collapseId);
  // Both threads' cards sit in the one stack of thread alerts, apart from each companion's stack.
  assert.deepEqual(new Set(sent.map(item => item.threadId)), new Set([THREAD_STACK]));
  assert.ok(sent[0].collapseId.length <= 64);
  // With no answer to show, the headline stands in; the run's start may be unknown.
  assert.equal(sent[2].body, 'Agent finished');
  assert.equal((await push.threadChanged('thread-3', state('completed', { threadId: 'thread-3' }))) !== null, true);
  assert.equal(sent[3].subtitle, 'rubato');
});

test('a failure leads with a warning and the first line of its error, else the last answer', async t => {
  const { push, sent } = service(t);
  push.threadReplies(async () => '여기까지 하다가 멈췄어');
  await push.threadChanged('thread-1', state('failed'), { startedAt: null, lastError: '429 rate_limit_error: slow down\nstack...' });
  await push.threadChanged('thread-2', state('failed', { threadId: 'thread-2' }), { startedAt: null, lastError: null });
  assert.deepEqual(sent.map(item => item.body), ['⚠︎ 429 rate_limit_error: slow down', '⚠︎ 여기까지 하다가 멈췄어']);
});

test("a reader that fails is logged and the alert still goes; 'generic' never reads the answer", async t => {
  const logged = [];
  const { push, sent } = service(t, { log: (message) => logged.push(message) });
  let asked = 0;
  push.threadReplies(async () => { asked += 1; throw new Error('T3 reader not bound'); });
  await push.threadChanged('thread-1', state('completed'));
  assert.equal(sent[0].body, 'Agent finished');
  assert.deepEqual(logged, ['last answer not read']);
  await ask(push, 'settings', { preview: 'generic' });
  await push.threadChanged('thread-2', state('completed', { threadId: 'thread-2' }));
  assert.equal(asked, 1);
  assert.equal(sent[1].body, 'A thread finished');
  assert.equal('subtitle' in sent[1], false);
});

test('an answer becomes plain words for the lock screen, cut to fit', () => {
  assert.equal(replySummary('# 제목\n> 인용\n1. 첫째 [링크](https://x.dev)\n```js\ncode()\n```\n---\n*기울임* 끝'), '제목 인용 첫째 링크 기울임 끝');
  assert.equal(replySummary('file_name 과 push_service 는 그대로'), 'file_name 과 push_service 는 그대로');
  assert.equal(replySummary('가'.repeat(400)).length, 180);
  assert.equal(replySummary('```\nonly code\n```'), '');
  assert.deepEqual([runLength('2026-11-15T00:00:00Z', '2026-11-15T00:00:40Z'), runLength('2026-11-15T00:00:00Z', '2026-11-15T01:05:00Z'),
    runLength('2026-11-15T00:00:00Z', '2026-11-15T02:00:00Z'), runLength('bad', '2026-11-15T00:00:00Z')], ['40s', '1h 5m', '2h', null]);
});

test("the bridge answers with the thread's last agent answer as T3 shows it", async () => {
  let reader;
  const push = { companionRuns: () => () => {}, threadReplies: (read) => { reader = read; return () => { reader = null; }; } };
  const bridge = new RubatoPiBridge({ descriptorPath: '/nonexistent/connection.json', instanceId: 'rubato-push', push,
    projectedThread: async threadId => threadId === 'thread-1' ? { messages: [
      { id: 'm1', role: 'user', text: '고쳐줘' }, { id: 'm2', role: 'assistant', text: '고쳤어' },
      { id: 'm3', role: 'assistant', text: '  ' }, { id: 'm4', role: 'user', text: 'wake' }] } : null });
  assert.equal(await reader('thread-1'), '고쳤어');
  assert.equal(await reader('thread-9'), null);
  await bridge.close();
  assert.equal(reader, null);
});

test('old news stays quiet: a replayed finish, an idle thread, a phase seen before', () => {
  assert.equal(alertFor(state('completed', { updatedAt: new Date(NOW - FRESH_MS - 1).toISOString() }), undefined, { now: NOW }), null);
  assert.equal(alertFor(null, 'running', { now: NOW }), null);
  assert.equal(alertFor(state('running'), 'starting', { now: NOW }), null);
  assert.equal(alertFor(state('failed'), 'completed', { now: NOW }), null);
  // A fresh finish from a thread this server had not seen yet (it started while the turn ran) still counts.
  assert.equal(alertFor(state('failed'), undefined, { now: NOW }).body, '⚠︎ Agent failed');
  // Input after approval is a new ask.
  assert.equal(alertFor(state('waiting_for_input'), 'waiting_for_approval', { now: NOW }).body, 'Waiting for input');
});

test("'generic' keeps thread and project names off the lock screen", async t => {
  const { push, sent } = service(t);
  assert.equal((await ask(push, 'settings', { preview: 'generic' })).status, 200);
  await push.threadChanged('thread-1', state('running'));
  await push.threadChanged('thread-1', state('completed'));
  assert.equal(sent[0].title, 'Rubato');
  assert.equal(sent[0].body, 'A thread finished');
  assert.ok(!JSON.stringify(sent[0]).includes('Fix the login bug') && !JSON.stringify(sent[0]).includes('rubato:'));
  assert.equal(sent[0].data.deepLink, '/threads/env-1/thread-1');
  assert.equal((await (await ask(push, 'status')).json()).preview, 'generic');
  assert.equal((await ask(push, 'settings', { preview: 'everything' })).status, 400);
});

test('the route keeps and forgets a phone grant and never lists the grant itself', async t => {
  const { push, phones } = service(t);
  const entry = { relay: 'https://push.example.dev', grant: 'rpg_secret', grantId: 'g1', deviceId: 'd1', label: 'iPhone' };
  assert.equal((await ask(push, 'register', entry)).status, 200);
  assert.equal(phones.length, 1);
  const status = await (await ask(push, 'status')).json();
  assert.deepEqual(status.phones.map(item => item.grantId), ['g1']);
  assert.ok(!JSON.stringify(status).includes('rpg_secret'));
  assert.deepEqual(await (await ask(push, 'unregister', { grantId: 'g1' })).json(), { removed: 1 });
  assert.equal((await ask(push, 'nope')).status, 404);
  const get = await handlePushRequest(push, new Request('http://mac/rubato/push/status'));
  assert.equal(get.status, 405);
});

test('a bad grant is refused with the reason', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rubato-push-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const push = createPushService({ home });
  const response = await ask(push, 'register', { relay: 'http://evil.example', grant: 'g', grantId: 'g', deviceId: 'd' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /https/);
});

test('a companion outcome is optional, unlike requests for the person and their own runs', async t => {
  const { push, sent } = service(t);
  const opened = { 'thread-1': true };
  const forget = push.companionRuns(async threadId => opened[threadId] === true);
  for (const phase of ['running', 'completed', 'running', 'waiting_for_approval', 'running', 'failed']) await push.threadChanged('thread-1', state(phase));
  assert.deepEqual(sent.map(item => [item.preference, item.body]), [
    ['companionThreads', 'Agent finished'],
    ['threads', 'Approval needed'],
    ['companionThreads', '⚠︎ Agent failed'],
  ]);
  assert.deepEqual(await (await ask(push, 'desktop-thread-muted', { threadId: 'thread-1' })).json(), { muted: false });
  await ask(push, 'desktop-companion-threads', { enabled: false });
  await ask(push, 'settings', { preview: 'generic' });
  assert.deepEqual(await (await ask(push, 'desktop-thread-muted', { threadId: 'thread-1' })).json(), { muted: true });
  await ask(push, 'settings', { preview: 'full' });
  opened['thread-1'] = false;
  for (const phase of ['running', 'completed']) await push.threadChanged('thread-1', state(phase));
  assert.deepEqual(await (await ask(push, 'desktop-thread-muted', { threadId: 'thread-1' })).json(), { muted: false });
  assert.deepEqual([sent.at(-1).preference, sent.at(-1).body], ['threads', 'Agent finished']);
  // An answer that cannot be had counts as the person's run, and a forgotten answer is not asked.
  const failing = push.companionRuns(async () => { throw new Error('engine away'); });
  for (const phase of ['running', 'completed']) await push.threadChanged('thread-1', state(phase));
  assert.equal(sent.length, 5);
  failing();
  opened['thread-1'] = true;
  forget();
  for (const phase of ['running', 'completed']) await push.threadChanged('thread-1', state(phase));
  assert.equal(sent.length, 6);
});

test("a companion's words arrive as a message from it; its room's runs are never thread alerts", async t => {
  const { push, sent } = service(t);
  push.companionRoom('room-roo', 'roo');
  for (const phase of ['running', 'completed']) await push.threadChanged('room-roo', state(phase, { threadId: 'room-roo' }));
  assert.deepEqual(sent, []);
  await push.companionSaid({ id: 'said-1', threadId: 'room-roo', text: '첫 통화 끝 📞\n목소리로 들으니까  좋더라', at: NOW });
  await push.companionSaid({ id: 'said-1', threadId: 'room-roo', text: '첫 통화 끝 📞', at: NOW });
  assert.deepEqual(sent, [{
    kind: 'alert', title: 'Roo', body: '첫 통화 끝 📞 목소리로 들으니까 좋더라', threadId: 'companion:roo',
    category: 'rubato.companion.message', mutableContent: true, preference: 'companionMessages',
    rubato: { kind: 'companion-message', companionId: 'roo', threadId: 'room-roo' },
  }]);
  await push.companionSaid({ id: 'said-2', threadId: 'room-roo', text: '가'.repeat(500), at: NOW });
  assert.equal(sent[1].body.length, 200);
  assert.equal(await push.companionSaid({ id: 'said-3', threadId: 'some-thread', text: 'not a room' }), null);
});

test('what a companion says while it is on a call with the person stays in the call card', async t => {
  const { push, sent } = service(t, { calls: [{ companion: 'roo', from: NOW - 60_000, to: NOW + 60_000 }] });
  push.companionRoom('room-roo', 'roo');
  push.companionRoom('room-segno', 'segno');
  await push.companionSaid({ id: 'a', threadId: 'room-roo', text: '통화 중', at: NOW });
  await push.companionSaid({ id: 'b', threadId: 'room-roo', text: '통화 끝나고', at: NOW + 120_000 });
  await push.companionSaid({ id: 'c', threadId: 'room-segno', text: '세뇨는 통화 중이 아님', at: NOW });
  assert.deepEqual(sent.map(item => item.body), ['통화 끝나고', '세뇨는 통화 중이 아님']);
});

test('a phone turns each kind on or off on this Mac; the route says when it is not paired', async t => {
  const { push, phones } = service(t);
  await ask(push, 'register', { relay: 'https://r.dev', grant: 'g', grantId: 'g1', deviceId: 'd1', preferences: { threads: false } });
  assert.deepEqual(phones[0].preferences, { threads: false });
  const changed = await ask(push, 'preferences', { deviceId: 'd1', preferences: { companionCalls: false } });
  assert.deepEqual(await changed.json(), { preferences: { threads: false, companionCalls: false } });
  assert.equal((await ask(push, 'preferences', { deviceId: 'nobody', preferences: {} })).status, 404);
  assert.equal((await ask(push, 'preferences', { deviceId: 'd1' })).status, 400);
});

test("the Telegram switch writes every companion's messenger setting here and leaves the rest of it alone", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rubato-push-telegram-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roo = path.join(dir, 'roo');
  const registry = path.join(dir, 'companions.json');
  writeFileSync(registry, JSON.stringify({ companions: [{ id: 'roo', title: 'Roo', home: roo, memoryAgent: 'roo' }] }));
  const env = { HOME: dir, RUBATO_COMPANIONS_FILE: registry };
  const telegram = createTelegramSwitch({ env });
  assert.equal(telegram.read(), null, 'no companion here uses Telegram yet');
  writeMessengerSettings({ approvalRequired: false }, { ...env, RUBATO_COMPANION_HOME: roo });
  assert.deepEqual(telegram.read(), { enabled: true });
  const { push } = service(t, { telegram });
  assert.deepEqual(await (await ask(push, 'telegram', { enabled: false })).json(), { telegram: { enabled: false } });
  const settings = readMessengerSettings({ ...env, RUBATO_COMPANION_HOME: roo });
  assert.equal(settings.outbound, false);
  assert.equal(settings.enabled, true, 'Telegram still brings messages in');
  assert.equal(settings.approvalRequired, false, 'other settings stay');
  assert.equal(existsSync(path.join(dir, '.rubato', 'companion', 'messenger')), false, 'a companion without a messenger is not given one');
  assert.deepEqual((await (await ask(push, 'status')).json()).telegram, { enabled: false });
  assert.equal((await ask(push, 'telegram', { enabled: 'no' })).status, 400);
});

test("a thread alert rings with the chime the desktop plays for it, which the phone keeps as a file", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rubato-desktop-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'client-settings.json');
  assert.deepEqual(readDesktopSounds(file), { completion: 'builtin:completion', input: 'builtin:input' });
  writeFileSync(file, JSON.stringify({ notificationCompletionSound: 'mac:system/Glass.aiff', notificationInputSound: '../etc/passwd' }));
  assert.deepEqual(readDesktopSounds(file), { completion: 'mac:system/Glass.aiff', input: 'builtin:input' });
  assert.match(phoneSoundFile('mac:system/Glass.aiff'), /^rubato-mac-[0-9a-f]{12}\.caf$/);
  assert.equal(phoneSoundFile('nope'), null);

  const { push, sent } = service(t, { sounds: { completion: 'mac:system/Glass.aiff', input: 'builtin:input' } });
  await push.threadChanged('thread-1', state('running'));
  await push.threadChanged('thread-1', state('failed'));
  assert.equal(sent[0].sound, phoneSoundFile('mac:system/Glass.aiff'));
  // The phone asks which chimes to keep.
  assert.deepEqual(await (await ask(push, 'sounds')).json(), { sounds: [
    { kind: 'completion', id: 'mac:system/Glass.aiff', file: phoneSoundFile('mac:system/Glass.aiff') },
    { kind: 'input', id: 'builtin:input', file: 'rubato-input.caf' },
  ] });
});

const row = (threadId, phase, minutesAgo = 0, extra = {}) =>
  state(phase, { threadId, threadTitle: `Thread ${threadId}`, updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(), deepLink: `/threads/env-1/${threadId}`, ...extra });

test("the Live Activity card puts what needs the person first, keeps a recent finish, and drops what went quiet", () => {
  const card = activityCard([
    row('a', 'running', 1), row('b', 'waiting_for_approval', 3), row('c', 'completed', 5),
    row('d', 'completed', 30), row('e', 'running', 3 * 60), row('f', 'waiting_for_input', 3 * 60),
  ], { now: NOW });
  assert.equal(card.title, 'Rubato');
  assert.equal(card.subtitle, 'Agent work in progress');
  assert.equal(card.environmentId, 'env-1');
  assert.equal(card.activeCount, 3);
  assert.deepEqual(card.activities.map(item => [item.threadId, item.status]), [['b', 'Approval'], ['f', 'Input'], ['a', 'Working'], ['c', 'Done']]);
  assert.deepEqual(Object.keys(card.activities[0]).sort(),
    ['deepLink', 'environmentId', 'modelTitle', 'phase', 'projectTitle', 'status', 'threadId', 'threadTitle', 'updatedAt']);
  assert.equal(activityCard([row('c', 'completed', 5)], { now: NOW }).subtitle, 'Agent work completed');
  assert.equal(activityCard([row('c', 'completed', 5)], { now: NOW }).activeCount, 0);
  assert.equal(activityCard([row('d', 'completed', 30)], { now: NOW }), null);
  // However long the titles, the card fits what APNs carries.
  const long = activityCard(Array.from({ length: 9 }, (_, i) => row(`t${i}`, 'running', 0, { threadTitle: '긴 제목 '.repeat(40), projectTitle: '프로젝트 '.repeat(20) })), { now: NOW });
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(long))) <= 3000);
  assert.ok(long.activities.length >= 1 && long.activities.length <= 5);
});

test('the card goes out once a burst settles, again only when it says something new, and ends when work stops', async t => {
  let clock = NOW;
  const { push, sent, timers } = service(t, { now: () => clock });
  const cards = () => sent.filter(item => item.kind === 'activity');
  await push.threadChanged('a', row('a', 'starting'));
  await push.threadChanged('a', row('a', 'running'));
  assert.equal(timers.length, 1, 'one settle timer for the burst');
  await push.flushActivity();
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].preference, 'liveActivity');
  assert.equal(cards()[0].state.activeCount, 1);
  assert.equal(cards()[0].urgent, undefined);

  // The same card again (only times moved) is not sent; a thread needing the person is, at once.
  await push.threadChanged('a', row('a', 'running', -1));
  await push.flushActivity();
  assert.equal(cards().length, 1);
  await push.threadChanged('b', row('b', 'waiting_for_approval'));
  await push.flushActivity();
  assert.equal(cards().length, 2);
  assert.equal(cards()[1].urgent, true);

  // Before iOS would dim it, the card hears again while work runs.
  clock += ACTIVITY_REFRESH_MS;
  await push.flushActivity();
  assert.equal(cards().length, 3);

  // Everything done: the card ends, showing how it ended; nothing more after that.
  await push.threadChanged('a', row('a', 'completed', -9));
  await push.threadChanged('b', row('b', 'completed', -9));
  await push.flushActivity();
  assert.equal(cards().length, 4);
  assert.equal(cards()[3].end, true);
  assert.equal(cards()[3].state.activeCount, 0);
  await push.flushActivity();
  assert.equal(cards().length, 4);
});

test("a companion's room never shows on the card, and the phone can read the card as it is now", async t => {
  const { push } = service(t);
  push.threadSeen('a', row('a', 'running'));
  push.threadSeen('room', row('room', 'running'));
  push.companionRoom('room', 'roo');
  await push.threadChanged('room', row('room', 'running'));
  const { state: card } = await (await ask(push, 'activity')).json();
  assert.deepEqual(card.activities.map(item => item.threadId), ['a']);
});

test('a state the server found on start shows on the card but never rings', async t => {
  const { push, sent } = service(t);
  push.threadSeen('a', row('a', 'waiting_for_approval'));
  await push.threadChanged('a', row('a', 'waiting_for_approval'));
  assert.equal(sent.filter(item => item.kind === 'alert').length, 0);
  assert.equal((await (await ask(push, 'activity')).json()).state.activities[0].threadId, 'a');
});

test('with thread names hidden, the card says only that threads run', () => {
  const card = activityCard([row('a', 'running')], { now: NOW, preview: 'generic' });
  assert.equal(card.activities[0].threadTitle, 'A thread');
  assert.equal(card.activities[0].projectTitle, '');
});
