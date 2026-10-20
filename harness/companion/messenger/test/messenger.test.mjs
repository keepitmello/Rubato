import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startCompanionMessenger } from '../service.mjs';
import { fakeTelegram } from './fake-telegram.mjs';
import { GROUP_CHAT, TOKEN, USER_CHAT, paired, sandbox, settle, start } from './helpers.mjs';
import {
  enqueueMessage, listOutbox, maskToken, pairedChatId, readBot, readHandoff, readIntent, readPairing, readSecret, readState, writeDecision,
  writeIntent, writeSecret, writeState, messengerPaths,
} from '../store.mjs';
import { writeState as writeCompanionState } from '../../companion.mjs';

test('the token is stored 0600 and Settings only ever sees it masked', async (t) => {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  assert.equal(readSecret(box.env).token, TOKEN);
  assert.equal(maskToken(TOKEN), `123456789:…GGhh`);
  assert.doesNotMatch(JSON.stringify(readBot(box.env)), /AAaaBBbb/);
  const { mode } = await import('node:fs').then(({ statSync }) => ({ mode: statSync(messengerPaths(box.env).secret).mode & 0o777 }));
  assert.equal(mode, 0o600);
});

test('pairing waits for the code, and binds only the chat that sent it', async (t) => {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  // The keeper has already created the companion's conversation; deliveries go there.
  writeCompanionState({ sessionId: 'S1' }, box.env);
  writeIntent({ action: 'pair' }, box.env);
  const fake = fakeTelegram();
  const { service, delivered } = start({ ...box, fake });
  await settle(service);
  const pairing = readPairing(box.env);
  assert.equal(pairing.status, 'pending');
  assert.match(pairing.code, /^[A-HJ-NP-Z2-9]{6}$/);

  // Someone else's chat typing anything but the code changes nothing.
  fake.message({ chatId: '999', text: 'hello' });
  await settle(service);
  assert.equal(readPairing(box.env).status, 'pending');
  assert.equal(delivered.length, 0);

  fake.message({ chatId: USER_CHAT, text: `  ${pairing.code.toLowerCase()} `, from: 'Wy' });
  await settle(service);
  assert.equal(readPairing(box.env).status, 'paired');
  assert.equal(pairedChatId(box.env), USER_CHAT);
  assert.match(fake.sent.at(-1).text, /연결됐습니다/);
});

test("the person's own Telegram message reaches Segno as the user's input, naming the channel", async (t) => {
  const box = await paired(t);
  const update = box.fake.message({ chatId: USER_CHAT, text: '버그 리포트 하나 들어왔어', from: 'Wy' });
  await settle(box.service);
  assert.equal(box.delivered.length, 1);
  const [delivery] = box.delivered;
  assert.equal(delivery.channel, 'telegram');
  assert.equal(delivery.to, 'S1');
  assert.equal(delivery.from.isUser, true);
  assert.equal(delivery.from.chatId, USER_CHAT);
  assert.equal(delivery.text, '버그 리포트 하나 들어왔어');
  assert.equal(delivery.from.messageId, update.message.message_id);
  assert.equal(readState(box.env).offset, update.update_id + 1, 'the offset moves past the update it handled');
  await settle(box.service);
  assert.equal(box.delivered.length, 1, 'the same update is not delivered twice');
});

test("a group's message arrives as another person's words, without the user's authority", async (t) => {
  const box = await paired(t);
  box.fake.message({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그 리포트', text: '앱이 자꾸 죽어요', from: 'Gildong' });
  await settle(box.service);
  const [delivery] = box.delivered;
  assert.equal(delivery.from.isUser, false);
  assert.equal(delivery.from.chatId, GROUP_CHAT);
  assert.equal(delivery.from.name, 'Gildong');
  assert.match(delivery.text, /앱이 자꾸 죽어요/);
  assert.match(delivery.text, /버그 리포트/);
});

test('a message Segno addresses to the person goes out to the paired chat', async (t) => {
  const box = await paired(t);
  enqueueMessage({ text: '리포트 확인했어요. 둘 다 처리했습니다.', target: 'user' }, box.env);
  await settle(box.service);
  const outgoing = box.fake.sent.filter((row) => row.chatId === USER_CHAT);
  assert.ok(outgoing.some((row) => row.text.includes('리포트 확인했어요')), 'the person got it');
  assert.equal(listOutbox(box.env).find((row) => row.source === 'tool').state, 'sent');
});

test('a message to anyone else waits for the person, who approves it from Telegram', async (t) => {
  const box = await paired(t);
  const row = enqueueMessage({ text: '확인해 볼게요. 재현 경로를 알려주세요.', target: { chatId: GROUP_CHAT, name: '버그 리포트' } }, box.env);
  await settle(box.service);
  assert.equal(listOutbox(box.env).find((item) => item.id === row.id).state, 'held');
  assert.equal(box.fake.sent.filter((sent) => sent.chatId === GROUP_CHAT).length, 0, 'nothing reached the other chat yet');
  const card = box.fake.sent.find((sent) => sent.chatId === USER_CHAT && sent.keyboard);
  assert.ok(card, 'the person gets a card in their own chat');
  assert.match(card.text, /버그 리포트/);
  assert.deepEqual(card.keyboard[0].map((button) => button.callback_data), [`approve:${row.id}`, `reject:${row.id}`]);

  box.fake.press({ chatId: USER_CHAT, data: `approve:${row.id}`, messageId: card.message_id });
  await settle(box.service);
  assert.equal(listOutbox(box.env).find((item) => item.id === row.id).state, 'sent');
  assert.ok(box.fake.sent.some((sent) => sent.chatId === GROUP_CHAT && sent.text.includes('재현 경로')));
  assert.ok(box.fake.edited.some((edit) => /보냄/.test(edit.text)), 'the card says what happened');
});

test('a refused message never reaches the other chat', async (t) => {
  const box = await paired(t);
  const row = enqueueMessage({ text: '곧 고칠게요.', target: { chatId: GROUP_CHAT, name: '버그 리포트' } }, box.env);
  await settle(box.service);
  const card = box.fake.sent.find((sent) => sent.chatId === USER_CHAT && sent.keyboard);
  box.fake.press({ chatId: USER_CHAT, data: `reject:${row.id}`, messageId: card.message_id });
  await settle(box.service);
  assert.equal(listOutbox(box.env).find((item) => item.id === row.id).state, 'rejected');
  assert.equal(box.fake.sent.filter((sent) => sent.chatId === GROUP_CHAT).length, 0);
});

test('the app can approve a held message too', async (t) => {
  const box = await paired(t);
  const row = enqueueMessage({ text: '내일 다시 확인할게요.', target: { chatId: GROUP_CHAT, name: '버그 리포트' } }, box.env);
  await settle(box.service);
  writeDecision(row.id, 'approve', { by: 'app' }, box.env);
  await settle(box.service);
  assert.equal(listOutbox(box.env).find((item) => item.id === row.id).state, 'sent');
  assert.ok(box.fake.sent.some((sent) => sent.chatId === GROUP_CHAT && sent.text.includes('내일')));
});

test('a restart picks up where it stopped, without answering an old update twice', async (t) => {
  const box = await paired(t);
  const first = box.fake.message({ chatId: USER_CHAT, text: '첫 번째', from: 'Wy' });
  await settle(box.service);
  await box.service.close();

  box.fake.message({ chatId: USER_CHAT, text: '두 번째', from: 'Wy' });
  const again = start({ ...box, fake: box.fake });
  await settle(again.service);
  const texts = again.delivered.map((delivery) => delivery.text);
  assert.deepEqual(texts, ['두 번째'], 'the handled update stayed handled');
  assert.equal(readState(box.env).offset, first.update_id + 2);
  await again.service.close();
});

test('turning Telegram off stops the traffic and keeps what arrived', async (t) => {
  const box = await paired(t);
  const { writeMessengerSettings } = await import('../store.mjs');
  writeMessengerSettings({ enabled: false }, box.env);
  box.fake.message({ chatId: USER_CHAT, text: '꺼진 동안 보낸 말', from: 'Wy' });
  await settle(box.service);
  assert.equal(box.delivered.length, 0);
  writeMessengerSettings({ enabled: true }, box.env);
  await settle(box.service);
  assert.equal(box.delivered.length, 1, 'the update was still waiting in Telegram');
});

test('making the bot over MTProto stores its token and never asks the person for one', async (t) => {
  const box = sandbox(t);
  writeIntent({ action: 'create-bot', name: 'Segno', username: 'segno_test_bot' }, box.env);
  const fake = fakeTelegram();
  const { service } = start({ ...box, fake, createBot: async () => ({ token: TOKEN, username: 'segno_test_bot', name: 'Segno' }) });
  await settle(service);
  assert.equal(readSecret(box.env).token, TOKEN);
  assert.equal(readBot(box.env).username, 'segno_test_bot');
  assert.doesNotMatch(JSON.stringify(readBot(box.env)), /AAaaBBbb/);
});

test('a failed delivery keeps the update: the offset does not move past it', async (t) => {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  writeCompanionState({ sessionId: 'S1' }, box.env);
  const store = await import('../store.mjs');
  store.writePairing({ status: 'paired', chat: { chatId: USER_CHAT } }, box.env);
  const fake = fakeTelegram();
  const delivered = [];
  const errors = [];
  let attempts = 0;
  const service = startCompanionMessenger({ env: box.env, agentDir: box.agentDir, createApi: () => fake.api,
    pollMs: 3_600_000, longPollSeconds: 0, onError: (error) => errors.push(error),
    deliver: async (args) => { attempts += 1; if (attempts === 1) throw new Error('engine said no'); delivered.push(args.text); } });
  await service.ready; await service.poke(); await service.poke();
  const update = fake.message({ chatId: USER_CHAT, text: '한 번 실패해도 도착해야 한다' });
  await service.poke(); await service.poke();
  assert.equal(errors.length, 1, 'the failure reached the engine log');
  assert.deepEqual(delivered, ['한 번 실패해도 도착해야 한다'], 'the second pass delivered it');
  assert.equal(readState(box.env).offset, update.update_id + 1);
  await service.close();
});

test('an engine with no conversation host leaves the messenger idle instead of failing the thread', async (t) => {
  const box = sandbox(t);
  const { start } = await import('../service.mjs');
  const logs = [];
  const service = await start({ env: box.env, agentDir: box.agentDir, log: (event) => logs.push(event) });
  assert.deepEqual(logs, ['messenger-idle']);
  await service.ready;
  await service.poke();
  await assert.rejects(service.send({ text: 'x', to: 'user' }), /idle/);
  await service.close();
});

test('the person can edit a held message before approving it; the edited text is what goes out', async (t) => {
  const box = await paired(t);
  const row = enqueueMessage({ text: 'draft: we found it', target: { chatId: GROUP_CHAT, name: '버그 리포트' } }, box.env);
  await settle(box.service);
  assert.throws(() => writeDecision(row.id, 'reject', { by: 'app', text: 'x' }, box.env), /only an approval/);
  assert.throws(() => writeDecision(row.id, 'approve', { by: 'app', text: '  ' }, box.env), /must not be empty/);
  writeDecision(row.id, 'approve', { by: 'app', text: 'Fixed in today’s release.' }, box.env);
  await settle(box.service);
  const sent = listOutbox(box.env).find((item) => item.id === row.id);
  assert.deepEqual([sent.state, sent.text, sent.draft], ['sent', 'Fixed in today’s release.', 'draft: we found it']);
  const out = box.fake.sent.filter((item) => item.chatId === GROUP_CHAT);
  assert.deepEqual(out.map((item) => item.text), ['Fixed in today’s release.']);
});

test("another person's report lands in Segno's inbox, once", async (t) => {
  const box = await paired(t);
  const update = box.fake.message({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그 리포트', text: '앱이 자꾸 죽어요', from: 'Gildong' });
  await settle(box.service);
  const { openInbox } = await import('../../inbox.mjs');
  const inbox = openInbox({ env: box.env });
  t.after(() => inbox.close());
  const items = inbox.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '앱이 자꾸 죽어요');
  assert.equal(items[0].source, 'telegram');
  assert.equal(items[0].reporter, 'Gildong');
  assert.equal(items[0].sourceRef, `telegram:${GROUP_CHAT}:${update.message.message_id}`);

  // The same update delivered again (a restart before the offset moved) is still one item.
  const repeated = box.fake.api.getUpdates;
  box.fake.message({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그 리포트', text: '앱이 자꾸 죽어요', from: 'Gildong', messageId: update.message.message_id });
  await settle(box.service);
  assert.equal(inbox.list().length, 1);
  assert.ok(repeated);
});

test('a pasted token is checked with Telegram before it is kept, and never echoed back', async (t) => {
  const box = sandbox(t);
  writeIntent({ action: 'set-token', token: '987654321:Past edTokenForTheTest1234567890'.replace(' ', '') }, box.env);
  const fake = fakeTelegram();
  const asked = [];
  const api = { ...fake.api, getMe: async () => { asked.push('me'); return { is_bot: true, username: 'segno_abcd_bot', first_name: 'Segno' }; } };
  const { service, errors } = start({ ...box, fake: { api } });
  await settle(service);
  assert.deepEqual(errors, []);
  assert.deepEqual(asked, ['me'], 'the token was checked against the Bot API');
  const secret = readSecret(box.env);
  assert.equal(secret.token, '987654321:Past edTokenForTheTest1234567890'.replace(' ', ''));
  assert.equal(readBot(box.env).username, 'segno_abcd_bot');
  assert.equal(readHandoff(box.env).result, 'token-saved');
  assert.equal(readIntent(box.env).token, undefined, 'the request file does not keep a second copy of the secret');
  await settle(service);
  assert.equal(readHandoff(box.env).result, 'token-saved', 'and it is not handled twice');
});

test('a token Telegram refuses is not kept, and the page is told why', async (t) => {
  const box = sandbox(t);
  writeIntent({ action: 'set-token', token: '987654321:BadTokenForTheTest1234567890' }, box.env);
  const fake = fakeTelegram();
  const api = { ...fake.api, getMe: async () => { throw new Error('Unauthorized'); } };
  const { service, errors } = start({ ...box, fake: { api } });
  await settle(service);
  assert.equal(errors.length, 1);
  assert.equal(readSecret(box.env), undefined, 'no token was stored');
  assert.match(readHandoff(box.env).error ?? '', /Unauthorized/);
});


test('the engine entry maps the host channel to deliveries, hands the tools a send, and reads /context through a client', async (t) => {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  writeCompanionState({ sessionId: 'S1' }, box.env);
  writeIntent({ action: 'pair' }, box.env);
  const fake = fakeTelegram();
  const delivered = [];
  const calls = [];
  const { start: startService } = await import('../service.mjs');
  const service = await startService({ env: box.env, agentDir: box.agentDir, onError: () => {},
    host: { channel: async (args) => delivered.push(args) }, options: { createApi: () => fake.api },
    connect: async () => ({
      attach: async (id) => calls.push(['attach', id]),
      command: async (command) => { calls.push(['command', command.type]); return { contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } }; },
      detach: async () => calls.push(['detach']),
      close: async () => calls.push(['close']),
    }) });
  t.after(() => service.close());
  await service.ready; await service.poke(); await service.poke();
  fake.message({ chatId: USER_CHAT, text: readPairing(box.env).code ?? 'nope' });
  await service.poke(); await service.poke();
  assert.equal(readPairing(box.env).status, 'paired');

  const row = await service.send({ text: '도구가 보낸 말', to: 'user' });
  assert.equal(row.state, 'sent');
  assert.ok(fake.sent.some((sent) => sent.text === '도구가 보낸 말'));

  fake.message({ chatId: USER_CHAT, text: '/context' });
  await service.poke(); await service.poke();
  assert.deepEqual(calls, [['attach', 'S1'], ['command', 'get_session_stats'], ['detach'], ['close']], 'the client is let go at once');
  assert.match(fake.sent.at(-1).text, /남은 컨텍스트: 99%/);
  assert.equal(delivered.length, 0);
});
