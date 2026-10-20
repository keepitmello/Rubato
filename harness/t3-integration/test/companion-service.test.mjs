import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionService, handleCompanionRequest } from '../src/companion/service.mjs';
import { PIECES, readPersonaReviewRequest, seedPromptPieces, writeState } from '../../companion/companion.mjs';

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
  assert.deepEqual(body.pieces.map((piece) => piece.id), ['preamble', 'soul', 'identity', 'user', 'companion', 'tools', 'memory', 'coda']);
  assert.ok(body.pieces.every((piece) => piece.defaultText.length > 0));
  const saved = await post('save-piece', { id: 'user', text: 'I sell shoes.' });
  assert.equal(saved.body.pieces.find((piece) => piece.id === 'user').personalText, 'I sell shoes.');
  const cleared = await post('save-piece', { id: 'user', text: '' });
  assert.equal(cleared.body.pieces.find((piece) => piece.id === 'user').personalText, undefined);
  const tools = await post('save-piece', { id: 'tools', text: 'mine' });
  assert.equal(tools.status, 400);
  assert.equal((await post('nope')).status, 404);
});

test('a home set up for the first time shows who Segno is as the person\'s own version', async (t) => {
  const { env, post } = await setup(t);
  seedPromptPieces({ defaultsDir, env });
  const { body } = await post('pieces');
  // Settings › Companion marks a piece "Yours" when it has a personal text and lets it be edited;
  // all four seeded pieces read that way from the first day, with no edit by the person.
  for (const id of ['preamble', 'soul', 'identity', 'user']) {
    const piece = body.pieces.find((entry) => entry.id === id);
    assert.equal(piece.personalText, piece.defaultText, `${id} is the person's copy`);
    assert.equal(piece.baseText, piece.defaultText, `${id} remembers the default it was copied from`);
    assert.equal(piece.editable, true);
  }
  for (const id of ['companion', 'tools']) {
    const piece = body.pieces.find((entry) => entry.id === id);
    assert.equal(piece.personalText, undefined, `${id} still follows Rubato`);
    assert.equal(piece.baseText, undefined);
  }
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
  // Once the person has answered, the row leaves the panel; the messenger sends or drops it later.
  assert.equal(listOutbox(env).find((row) => row.id === held.id).state, 'held');
  assert.deepEqual((await post('panel')).body.held, []);
  const art = await post('art');
  assert.match(art.body.art.url, /^data:image\/webp;base64,/);
  const working = await post('art', { state: 'working' });
  assert.notEqual(working.body.art.url, art.body.art.url, 'each expression is its own picture');
  assert.equal((await post('art', { state: 'dancing' })).status, 400);
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

test('a pasted token is handed to the messenger, and the page learns whether a tg client can make one', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rubato-companion-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
  const service = createCompanionService({ env, defaultsDir,
    tg: { probeTg: async () => ({ available: false, reason: 'no tg client on this Mac' }) } });
  const post = async (action, body = {}) => {
    const response = await handleCompanionRequest(service, new Request(`http://local/rubato/companion/${action}`,
      { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const store = await import('../../companion/messenger/store.mjs');

  const status = await post('telegram');
  assert.deepEqual(status.body.telegram.botCreation, { available: false, reason: 'no tg client on this Mac' },
    'the make-it-for-me button knows there is no tg here');

  const saved = await post('telegram-set-token', { token: '123456789:AAaaBBbbCCccDDddEEeeFFffGGhh' });
  assert.equal(saved.status, 200);
  assert.equal(store.readIntent(env).action, 'set-token');
  assert.equal(store.readIntent(env).token, '123456789:AAaaBBbbCCccDDddEEeeFFffGGhh',
    'the service checks it and stores it; the page never keeps it');
  assert.equal((await post('telegram-set-token', { token: '  ' })).status, 400);
});

test('the page marks a default that moved and asks Segno to look at it', async (t) => {
  const { env, post } = await setup(t);
  seedPromptPieces({ defaultsDir, env });
  // The defaults folder an update would leave behind: one piece moved.
  const after = mkdtempSync(path.join(tmpdir(), 'rubato-companion-defaults-'));
  t.after(() => rmSync(after, { recursive: true, force: true }));
  for (const { id } of PIECES) copyFileSync(path.join(defaultsDir, `${id}.pi.md`), path.join(after, `${id}.pi.md`));
  writeFileSync(path.join(after, 'soul.pi.md'), '# A new default soul\n');
  const service = createCompanionService({ env, defaultsDir: after });
  const ask = async (action, body = {}) => {
    const response = await handleCompanionRequest(service, new Request(`http://local/rubato/companion/${action}`,
      { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };

  const pieces = (await ask('pieces')).body.pieces;
  const soul = pieces.find((piece) => piece.id === 'soul');
  assert.equal(soul.defaultChanged, true);
  assert.equal(soul.defaultChanged, true, 'the page shows the mark');
  assert.equal(soul.baseText, soul.personalText, 'the copy came from the default it is compared with');
  assert.equal(pieces.find((piece) => piece.id === 'identity').defaultChanged, undefined);

  const asked = await ask('review-persona');
  assert.equal(asked.status, 200);
  assert.ok(asked.body.reviewRequested, 'the keeper has something to read');
  assert.equal(readPersonaReviewRequest(env), asked.body.reviewRequested);
  assert.equal(asked.body.pieces.find((piece) => piece.id === 'soul').defaultChanged, true,
    'the mark stays until the engine moves the base under it');
});

test('the Fish Audio key is pasted here, kept 0600, and only ever shown as set or not', async (t) => {
  const { env, post } = await setup(t);
  assert.equal((await post('telegram')).body.telegram.voiceKey.set, false);
  const saved = await post('voice-key', { key: 'fishfishfishfish1234' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.telegram.voiceKey.set, true);
  assert.doesNotMatch(JSON.stringify(saved.body), /fishfishfish/);
  const { statSync } = await import('node:fs');
  const { messengerPaths } = await import('../../companion/messenger/store.mjs');
  assert.equal(statSync(messengerPaths(env).fishKey).mode & 0o777, 0o600);
  assert.equal((await post('voice-key', { key: 'no' })).status, 400);
  assert.equal((await post('voice-key', { key: null })).body.telegram.voiceKey.set, false);
});
