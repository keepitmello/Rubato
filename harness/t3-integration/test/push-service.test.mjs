import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { alertFor, createPushService, createTelegramSwitch, FRESH_MS, handlePushRequest } from '../src/push/service.mjs';
import { readMessengerSettings, writeMessengerSettings } from '../../companion/messenger/store.mjs';

const NOW = Date.UTC(2026, 10, 13, 12);
const state = (phase, extra = {}) => ({
  environmentId: 'env-1', threadId: 'thread-1', projectTitle: 'rubato', threadTitle: 'Fix the login bug', phase,
  headline: { completed: 'Agent finished', failed: 'Agent failed', waiting_for_approval: 'Approval needed',
    waiting_for_input: 'Waiting for input', running: 'Agent is working', starting: 'Starting agent' }[phase],
  modelTitle: 'claude-opus-5-5', updatedAt: new Date(NOW - 1000).toISOString(), deepLink: '/threads/env-1/thread-1', ...extra,
});

function service(t, { now = () => NOW, calls = [], telegram } = {}) {
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
  return { push: createPushService({ home, grants, now, onCall, companionTitle: id => ({ roo: 'Roo' })[id] ?? id,
    telegram: telegram ?? { read: () => null, write: () => null } }), sent, phones };
}
const ask = (push, action, body = {}) => handlePushRequest(push,
  new Request(`http://mac/rubato/push/${action}`, { method: 'POST', body: JSON.stringify(body) }));

test('a thread that starts needing the person, or finishes, is one alert', async t => {
  const { push, sent } = service(t);
  for (const phase of ['starting', 'running', 'waiting_for_approval', 'waiting_for_approval', 'running', 'completed', 'completed'])
    await push.threadChanged('thread-1', state(phase));
  assert.deepEqual(sent.map(item => item.body), ['Approval needed: rubato', 'Agent finished: rubato']);
  assert.deepEqual(sent[1], {
    kind: 'alert', title: 'Fix the login bug', body: 'Agent finished: rubato', threadId: 'env-1/thread-1',
    category: 'rubato.thread', rubato: { kind: 'thread' }, preference: 'threads',
    data: { environmentId: 'env-1', threadId: 'thread-1', deepLink: '/threads/env-1/thread-1' },
  });
});

test('old news stays quiet: a replayed finish, an idle thread, a phase seen before', () => {
  assert.equal(alertFor(state('completed', { updatedAt: new Date(NOW - FRESH_MS - 1).toISOString() }), undefined, { now: NOW }), null);
  assert.equal(alertFor(null, 'running', { now: NOW }), null);
  assert.equal(alertFor(state('running'), 'starting', { now: NOW }), null);
  assert.equal(alertFor(state('failed'), 'completed', { now: NOW }), null);
  // A fresh finish from a thread this server had not seen yet (it started while the turn ran) still counts.
  assert.equal(alertFor(state('failed'), undefined, { now: NOW }).body, 'Agent failed: rubato');
  // Input after approval is a new ask.
  assert.equal(alertFor(state('waiting_for_input'), 'waiting_for_approval', { now: NOW }).body, 'Waiting for input: rubato');
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
