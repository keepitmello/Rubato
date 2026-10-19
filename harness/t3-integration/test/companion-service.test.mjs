import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionService, handleCompanionRequest } from '../src/companion/service.mjs';
import { writeState } from '../../companion/companion.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rubato-companion-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
  const service = createCompanionService({ env, defaultsDir });
  const post = async (action, body = {}) => {
    const response = await handleCompanionRequest(service, new Request(`http://local/rubato/companion/${action}`,
      { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { env, post };
}

test('status starts off with no conversation, and turning it on is a saved setting', async (t) => {
  const { env, post } = await setup(t);
  const first = await post('status');
  assert.equal(first.status, 200);
  assert.equal(first.body.settings.enabled, false);
  assert.equal(first.body.sessionId, null);
  assert.equal(first.body.home, env.RUBATO_COMPANION_HOME);
  const saved = await post('save-settings', { patch: { enabled: true, heartbeat: { everyMinutes: 30 } } });
  assert.deepEqual(saved.body.settings.heartbeat, { enabled: true, everyMinutes: 30 });
  assert.equal(saved.body.settings.enabled, true);
  writeState({ sessionId: 'segno' }, env);
  assert.equal((await post('status')).body.sessionId, 'segno', 'the conversation the keeper recorded');
  const refused = await post('save-settings', { patch: { heartbeat: { everyMinutes: 3 } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'invalid');
});

test('pieces list every piece with its default, and a saved piece is the person\'s until cleared', async (t) => {
  const { post } = await setup(t);
  const { body } = await post('pieces');
  assert.deepEqual(body.pieces.map((piece) => piece.id), ['preamble', 'soul', 'identity', 'user', 'companion', 'tools']);
  assert.ok(body.pieces.every((piece) => piece.defaultText.length > 0));
  const saved = await post('save-piece', { id: 'user', text: 'I sell shoes.' });
  assert.equal(saved.body.pieces.find((piece) => piece.id === 'user').personalText, 'I sell shoes.');
  const cleared = await post('save-piece', { id: 'user', text: '' });
  assert.equal(cleared.body.pieces.find((piece) => piece.id === 'user').personalText, undefined);
  const tools = await post('save-piece', { id: 'tools', text: 'mine' });
  assert.equal(tools.status, 400);
  assert.equal((await post('nope')).status, 404);
});

test('the Telegram page reads the token masked and asks the engine for a pairing code', async (t) => {
  const { env, post } = await setup(t);
  const store = await import('../../companion/messenger/store.mjs');
  const empty = await post('telegram');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.telegram.bot.masked, null);
  assert.equal(empty.body.telegram.pairing.status, 'unpaired');

  store.writeSecret('123456789:AAaaBBbbCCccDDddEEeeFFffGGhh', env);
  const withBot = await post('telegram');
  assert.doesNotMatch(JSON.stringify(withBot.body.telegram), /AAaaBBbb/);
  assert.equal(withBot.body.telegram.bot.masked, '123456789:…GGhh');

  await post('telegram-pair');
  assert.deepEqual(store.readIntent(env).action, 'pair', 'the page asks; the messenger answers a second later');
  await post('telegram-settings', { patch: { enabled: false } });
  assert.equal(store.readMessengerSettings(env).enabled, false);
  await post('telegram-settings', { patch: { enabled: 'yes' } }).then((answer) => {
    assert.equal(answer.status, 400, 'a field the page cannot offer is refused');
  });
});

test('a held message is approved from the page, and the decision is a file the messenger reads', async (t) => {
  const { env, post } = await setup(t);
  const store = await import('../../companion/messenger/store.mjs');
  const row = store.enqueueMessage({ text: '고칠게요.', target: { chatId: '-1001', name: '버그 리포트' } }, env);
  const shown = await post('telegram');
  assert.deepEqual(shown.body.telegram.waiting.map((message) => message.id), [row.id]);
  assert.deepEqual(shown.body.telegram.waiting[0].target, { chatId: '-1001', name: '버그 리포트' });

  const decided = await post('telegram-decide', { id: row.id, decision: 'approve' });
  assert.equal(decided.status, 200);
  assert.equal(store.readDecision(row.id, env).decision, 'approve');
  const refused = await post('telegram-decide', { id: row.id, decision: 'maybe' });
  assert.equal(refused.status, 400);
});

test("the task panel beside Segno's chat: followed leads, recent endings and held messages, and an edited approval", async (t) => {
  const { env, post } = await setup(t);
  const { writePanel } = await import('../../companion/companion.mjs');
  const { enqueueMessage, listOutbox, updateOutboxRow, readDecision } = await import('../../companion/messenger/store.mjs');
  writePanel({ leads: [{ sessionId: 'run', title: 'Login timeout', cwd: '/w/hash-game', state: 'running', since: 1 }],
    finished: [{ sessionId: 'done', title: 'Payments', cwd: '/w/pay', outcome: 'completed', at: 2 }] }, env);
  const held = enqueueMessage({ text: 'Hi Giron, fixed today.', target: { chatId: '-100', name: 'VaultOne' } }, env);
  updateOutboxRow(held.id, { state: 'held' }, env);
  enqueueMessage({ text: 'to me', target: 'user' }, env);
  const panel = await post('panel');
  assert.equal(panel.status, 200);
  assert.deepEqual(panel.body.leads.map((lead) => lead.title), ['Login timeout']);
  assert.deepEqual(panel.body.finished.map((entry) => entry.outcome), ['completed']);
  assert.deepEqual(panel.body.held.map((row) => [row.id, row.text, row.to.name]), [[held.id, 'Hi Giron, fixed today.', 'VaultOne']]);
  const decided = await post('telegram-decide', { id: held.id, decision: 'approve', text: 'Hi Giron — fixed in today’s release.' });
  assert.equal(decided.status, 200);
  assert.deepEqual(readDecision(held.id, env), { ...readDecision(held.id, env), decision: 'approve', text: 'Hi Giron — fixed in today’s release.' });
  assert.equal((await post('telegram-decide', { id: held.id, decision: 'reject', text: 'x' })).status, 400);
  assert.equal(listOutbox(env).length, 2);
  const art = await post('art');
  assert.match(art.body.art.url, /^data:image\/webp;base64,/);
  // Open inbox items without a lead are rows; one a lead took is that lead's row instead.
  const { openInbox } = await import('../../companion/inbox.mjs');
  const box = openInbox({ env });
  box.add({ title: '앱이 자꾸 죽어요', source: 'telegram', sourceRef: 'telegram:-1:7', reporter: 'Gildong' });
  box.add({ title: '로그인 버그', source: 'telegram', sourceRef: 'telegram:-1:8', leadSessionId: 'run' });
  box.add({ title: '끝난 일', source: 'user' });
  box.update('S-3', { status: 'done' });
  box.close();
  const withInbox = await post('panel');
  assert.deepEqual(withInbox.body.inbox.map((item) => [item.title, item.source, item.reporter]), [['앱이 자꾸 죽어요', 'telegram', 'Gildong']]);
});

test('the Segno space asks the server for the inbox and gets the open work with counts', async (t) => {
  const { env, post } = await setup(t);
  const { openInbox } = await import('../../companion/inbox.mjs');
  const box = openInbox({ env });
  box.add({ title: '로그인이 안 돼요', source: 'telegram', sourceRef: 'telegram:-1:1', reporter: 'Gildong' });
  box.add({ title: '끝난 일', source: 'user' });
  box.update('S-2', { status: 'done' });
  box.close();
  const { status, body } = await post('inbox');
  assert.equal(status, 200);
  assert.deepEqual(body.inbox.items.map((item) => item.title), ['로그인이 안 돼요']);
  assert.equal(body.inbox.counts.open, 1);
  assert.ok(body.inbox.counts.done >= 1);
  assert.equal((await post('inbox', { status: 'done' })).body.inbox.items[0].title, '끝난 일');
  // The Segno space shows the rows no lead holds yet.
  assert.deepEqual((await post('inbox', { unlinked: true })).body.inbox.items.map((item) => item.title), ['로그인이 안 돼요']);
});
