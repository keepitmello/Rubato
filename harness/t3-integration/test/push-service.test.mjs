import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { alertFor, createPushService, FRESH_MS, handlePushRequest } from '../src/push/service.mjs';

const NOW = Date.UTC(2026, 10, 13, 12);
const state = (phase, extra = {}) => ({
  environmentId: 'env-1', threadId: 'thread-1', projectTitle: 'rubato', threadTitle: 'Fix the login bug', phase,
  headline: { completed: 'Agent finished', failed: 'Agent failed', waiting_for_approval: 'Approval needed',
    waiting_for_input: 'Waiting for input', running: 'Agent is working', starting: 'Starting agent' }[phase],
  modelTitle: 'claude-opus-5-5', updatedAt: new Date(NOW - 1000).toISOString(), deepLink: '/threads/env-1/thread-1', ...extra,
});

function service(t, { now = () => NOW } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rubato-push-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sent = [];
  const phones = [];
  const grants = {
    add: entry => { phones.push(entry); return { grantId: entry.grantId }; },
    remove: id => phones.splice(phones.findIndex(item => item.grantId === id), 1).length,
    list: () => phones.map(({ grant: _grant, ...rest }) => rest),
    pushAll: async message => { sent.push(message); return [{ ok: true }]; },
  };
  return { push: createPushService({ home, grants, now }), sent, phones };
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
