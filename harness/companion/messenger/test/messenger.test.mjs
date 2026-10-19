import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startCompanionMessenger } from '../service.mjs';
import { fakeTelegram } from './fake-telegram.mjs';
import {
  enqueueMessage, listOutbox, maskToken, pairedChatId, readBot, readHandoff, readIntent, readPairing, readSecret, readState, writeDecision,
  writeIntent, writeSecret, writeState, messengerPaths,
} from '../store.mjs';
import { writeState as writeCompanionState } from '../../companion.mjs';
import { DAILY_REPORT_TEXT, HEARTBEAT_TEXT } from '../../keeper.mjs';
import { buildSessionMessage, parseDelivery } from '../../../pi-runtime/features/session-link/message.mjs';

const TOKEN = '123456789:AAaaBBbbCCccDDddEEeeFFffGGhh';
const USER_CHAT = '777';
const GROUP_CHAT = '-1001234567890';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-messenger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'companion'), HOME: dir };
  const agentDir = path.join(dir, 'agent');
  mkdirSync(agentDir, { recursive: true });
  return { dir, env, agentDir };
}

function start({ env, agentDir, fake, createBot }) {
  const delivered = [];
  const errors = [];
  const service = startCompanionMessenger({
    deliver: async (args) => { delivered.push(args); },
    env, agentDir,
    createApi: () => fake.api,
    ...(createBot ? { createBot } : {}),
    pollMs: 3_600_000, longPollSeconds: 0,
    onError: (error) => errors.push(error),
  });
  return { service, delivered, errors };
}

/** Waits for the pass in flight and runs one more, so everything pushed before is handled. */
async function settle(service) {
  await service.ready;
  await service.poke();
  await service.poke();
}

/** A paired person's messenger, ready to carry messages. */
async function paired(t, { createBot } = {}) {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  // The keeper has already created the companion's conversation; deliveries go there.
  writeCompanionState({ sessionId: 'S1' }, box.env);
  writeIntent({ action: 'pair' }, box.env);
  const fake = fakeTelegram();
  const started = start({ ...box, fake, createBot });
  await settle(started.service);
  const code = readPairing(box.env).code;
  fake.message({ chatId: USER_CHAT, text: code, from: 'Wy' });
  await settle(started.service);
  assert.equal(readPairing(box.env).status, 'paired', 'the code pairs the chat it was sent from');
  return { ...box, fake, ...started };
}

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

function transcript(box, entries, { append = false, sessionId = 'S1' } = {}) {
  writeCompanionState({ sessionId }, box.env);
  const dir = path.join(box.agentDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-19T10-00-00-000Z_${sessionId}.jsonl`);
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  if (append) appendFileSync(file, body);
  else writeFileSync(file, body);
  return file;
}

const channelEntry = (id, { isUser = true, chatId = USER_CHAT, messageId = 501, text = '안녕', name } = {}) => ({
  type: 'custom_message', customType: 'rubato-session-message', id,
  details: { kind: 'channel', from: { channel: 'telegram', chatId, isUser, ...(name ? { name } : {}), messageId }, text },
  content: `<channel_message via="telegram">${text}</channel_message>`,
});
const noticeEntry = (id, text, from = { sessionId: 'rubato' }) => ({
  type: 'custom_message', customType: 'rubato-session-message', id,
  details: { kind: 'notice', from, text }, content: `<session_notice>${text}</session_notice>`,
});
const answerEntry = (id, text) => ({
  type: 'message', id, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] },
});
const appEntry = (id, text) => ({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } });

test("Segno's answer to a Telegram message goes back to that chat, as a reply", async (t) => {
  const box = await paired(t);
  transcript(box, [channelEntry('e1', { messageId: 501 }), answerEntry('e2', '네, 지금 확인할게요.')]);
  await settle(box.service);
  const reply = box.fake.sent.find((row) => row.text.includes('지금 확인할게요'));
  assert.ok(reply, 'the answer reached Telegram');
  assert.equal(reply.chatId, USER_CHAT);
  assert.equal(reply.replyToMessageId, 501, 'it threads under the message it answers');
  await settle(box.service);
  assert.equal(box.fake.sent.filter((row) => row.text.includes('지금 확인할게요')).length, 1, 'a restart does not send it twice');
});

test('an answer in the app is not mirrored to Telegram', async (t) => {
  const box = await paired(t);
  transcript(box, [appEntry('e1', '앱에서 쓴 말'), answerEntry('e2', '앱에서 답한 말')]);
  await settle(box.service);
  assert.equal(box.fake.sent.filter((row) => row.text.includes('앱에서 답한 말')).length, 0);
  assert.equal(readState(box.env).transcript.seen, 2, 'the transcript position moved past it');
});

test('the daily report and a lead ending reach the person; a heartbeat answer does not', async (t) => {
  const box = await paired(t);
  transcript(box, [
    noticeEntry('e1', 'Daily report time. Send the user today\'s report.'),
    answerEntry('e2', '오늘 리포트: 들어온 것 3건.'),
  ]);
  await settle(box.service);
  assert.ok(box.fake.sent.some((row) => row.chatId === USER_CHAT && row.text.includes('오늘 리포트')));

  transcript(box, [
    channelEntry('e3'),
    answerEntry('e4', '네.'),
    noticeEntry('e5', 'Finished its turn.', { sessionId: 'lead-1', title: '버그 수정', cwd: '/tmp' }),
    answerEntry('e6', '버그 수정 끝났어요.'),
  ], { append: true });
  await settle(box.service);
  assert.ok(box.fake.sent.some((row) => row.text.includes('버그 수정 끝났어요')));

  transcript(box, [
    channelEntry('e7'),
    answerEntry('e8', '네.'),
    noticeEntry('e9', 'Heartbeat. Look over the conversations you follow.'),
    answerEntry('e10', '아직 진행 중인 리드 하나 있어요.'),
  ], { append: true });
  await settle(box.service);
  assert.equal(box.fake.sent.filter((row) => row.text.includes('진행 중인 리드')).length, 0,
    'a heartbeat answer stays in the app: thinking on a timer is not a message to the phone');
});

// Rubato's clock as the session link writes it (kind `wake`, not shown in the app).
const wakeEntry = (id, what, text) => ({ type: 'custom_message', id,
  ...buildSessionMessage(parseDelivery({ v: 1, messageId: id, kind: 'wake', what, text })) });

test("from Rubato's clock as a wake, the daily report reaches the person and a heartbeat answer does not", async (t) => {
  const box = await paired(t);
  transcript(box, [
    wakeEntry('w1', 'daily-report', DAILY_REPORT_TEXT),
    answerEntry('w2', '오늘 리포트: 들어온 것 2건.'),
    wakeEntry('w3', 'heartbeat', HEARTBEAT_TEXT),
    answerEntry('w4', '리드 둘 다 아직 돌고 있어.'),
  ]);
  await settle(box.service);
  assert.ok(box.fake.sent.some((row) => row.chatId === USER_CHAT && row.text.includes('오늘 리포트')));
  assert.equal(box.fake.sent.filter((row) => row.text.includes('아직 돌고')).length, 0);
});

test("Segno's answer to another person is held, not sent", async (t) => {
  const box = await paired(t);
  transcript(box, [channelEntry('e1', { isUser: false, chatId: GROUP_CHAT, name: 'Gildong' }), answerEntry('e2', '재현 방법을 알려주세요.')]);
  await settle(box.service);
  const held = listOutbox(box.env).filter((row) => row.source === 'reply');
  assert.equal(held.length, 1);
  assert.equal(held[0].state, 'held');
  assert.equal(held[0].target.chatId, GROUP_CHAT);
  assert.equal(box.fake.sent.filter((row) => row.chatId === GROUP_CHAT).length, 0);
  assert.ok(box.fake.sent.some((row) => row.chatId === USER_CHAT && row.keyboard), 'the person is asked to approve it');
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


test('the engine entry maps the host channel to deliveries and hands the tools a send', async (t) => {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  writeCompanionState({ sessionId: 'S1' }, box.env);
  writeIntent({ action: 'pair' }, box.env);
  const fake = fakeTelegram();
  const delivered = [];
  const { start } = await import('../service.mjs');
  const service = await start({ env: box.env, agentDir: box.agentDir, onError: () => {},
    host: { channel: async (args) => delivered.push(args) }, options: { createApi: () => fake.api } });
  assert.equal(typeof service.send, 'function');
  await service.ready; await service.poke(); await service.poke();
  fake.message({ chatId: USER_CHAT, text: readPairing(box.env).code ?? 'nope' });
  await service.poke(); await service.poke();
  assert.equal(readPairing(box.env).status, 'paired');

  const row = service.send({ text: '도구가 큐에 넣은 말', to: 'user' });
  assert.equal(row.target, 'user');
  assert.equal(row.state, 'queued');
  await service.poke(); await service.poke();
  assert.ok(fake.sent.some((sent) => sent.text.includes('도구가 큐에 넣은 말')));
  await service.close();
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

test('a failed Telegram send is not remembered as answered, and goes out next time', async (t) => {
  const box = sandbox(t);
  writeSecret(TOKEN, box.env);
  const store = await import('../store.mjs');
  store.writePairing({ status: 'paired', chat: { chatId: USER_CHAT } }, box.env);
  writeCompanionState({ sessionId: 'S1' }, box.env);
  const fake = fakeTelegram();
  const send = fake.api.sendMessage;
  let attempts = 0;
  fake.api.sendMessage = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('telegram hiccup');
    return send(...args);
  };
  const errors = [];
  const service = startCompanionMessenger({ env: box.env, agentDir: box.agentDir, createApi: () => fake.api,
    pollMs: 3_600_000, longPollSeconds: 0, onError: (error) => errors.push(error), deliver: async () => {} });
  await service.ready; await service.poke(); await service.poke();
  transcript(box, [channelEntry('e1', { isUser: true }), answerEntry('e2', '실패해도 살아남는 답')]);
  await service.poke(); await service.poke();
  assert.equal(errors.length, 1);
  assert.equal(fake.sent.filter((row) => row.text === '실패해도 살아남는 답').length, 1);
  assert.equal(readState(box.env).transcript.seen, 2, 'the cursor moved only after the answer went out');
  await service.close();
});

test('two answers that ended between polls both go out, oldest first', async (t) => {
  const box = await paired(t);
  transcript(box, [
    channelEntry('e1', { messageId: 601 }), answerEntry('e2', '첫 번째 답'),
    channelEntry('e3', { messageId: 602 }), answerEntry('e4', '두 번째 답'),
  ]);
  await settle(box.service);
  const texts = box.fake.sent.map((row) => row.text).filter((text) => /번째 답/.test(text));
  assert.deepEqual(texts, ['첫 번째 답', '두 번째 답']);
});

test('a long transcript is sent once and never replayed: the ledger is a position, not a list', async (t) => {
  const box = await paired(t);
  const count = 200;
  transcript(box, Array.from({ length: count }, (_, index) => [
    channelEntry(`incoming-${index}`, { messageId: 1000 + index }), answerEntry(`final-${index}`, `답 ${index}`),
  ]).flat());
  const replies = () => box.fake.sent.filter((row) => /^답 /.test(row.text)).length;
  await settle(box.service);
  assert.equal(replies(), count, 'every answer went out exactly once');
  await settle(box.service);
  assert.equal(replies(), count, 'later polls send nothing again');
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

test('on a heartbeat, Segno speaks to the phone only when it decides to', async (t) => {
  const box = await paired(t);
  transcript(box, [
    channelEntry('h1'),
    answerEntry('h2', '네.'),
    noticeEntry('h3', 'Heartbeat. Look over the conversations you follow.'),
    answerEntry('h4', '아직 조용해. 내 노트만 남긴다.'),
  ], { append: true });
  // What telegram_send does during that same turn when something does need the user.
  enqueueMessage({ text: '확인할 게 하나 있어요. 잠깐 봐줄래요?', target: 'user', source: 'tool' }, box.env);
  await settle(box.service);
  const sent = box.fake.sent.map((row) => row.text);
  assert.equal(sent.filter((text) => text.includes('확인할 게 하나')).length, 1, 'the tool message went out once');
  assert.equal(sent.filter((text) => text.includes('내 노트만')).length, 0, 'the heartbeat note did not ride along');
});

test('a heartbeat answer never goes out on its own, even when nothing else does', async (t) => {
  const box = await paired(t);
  const before = box.fake.sent.length;
  transcript(box, [
    noticeEntry('i3', 'Heartbeat. Look over the conversations you follow.'),
    answerEntry('i4', 'Heartbeat: same as before. No leads of mine and nothing new came in.'),
  ]);
  await settle(box.service);
  assert.equal(box.fake.sent.length, before, 'silence: the phone gets nothing');
});

test("a wake is classified by what it is, not by the words it carries", async (t) => {
  const box = await paired(t);
  // Same wake kind, words that do not start with the product texts: a reworded clock still lands
  // the daily report and still keeps the heartbeat quiet.
  transcript(box, [
    wakeEntry('x1', 'daily-report', 'It is nine. Give them the day.'),
    answerEntry('x2', '오늘 리포트: 들어온 것 1건.'),
    wakeEntry('x3', 'heartbeat', 'An hour passed.'),
    answerEntry('x4', '조용해.'),
  ]);
  await settle(box.service);
  assert.ok(box.fake.sent.some((row) => row.text.includes('오늘 리포트')), 'the daily report reached the person');
  assert.equal(box.fake.sent.filter((row) => row.text.includes('조용해')).length, 0, 'the heartbeat stayed in the app');
});
