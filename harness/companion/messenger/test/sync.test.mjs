// The app and Telegram show the same conversation (intent companion-segno rev 6): every text of
// Segno's the app thread shows reaches Telegram once, a run the app hides never does, and the
// person's own app messages are not copied over.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { quietMessages } from '../../../t3-integration/src/quiet-runs.mjs';
import { readState, writeState, messengerPaths } from '../store.mjs';
import { GROUP_CHAT, USER_CHAT, answerEntry, appEntry, channelEntry, noticeEntry, paired, settle, toolEntry, transcript, wakeEntry } from './helpers.mjs';
import { listOutbox } from '../store.mjs';

const RECORDED = new URL('./fixtures/segno-recorded.jsonl', import.meta.url);
const textOf = (content) => (Array.isArray(content) ? content : []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n').trim();
const sentTexts = (box) => box.fake.sent.filter((row) => row.chatId === USER_CHAT).map((row) => row.text);

/** What the app thread shows of Segno, by the app's own rule (t3-integration quiet-runs.mjs). */
function appShows(entries) {
  const messages = entries.map((entry) => entry.type === 'custom_message'
    ? { role: 'custom', customType: entry.customType, display: entry.display, details: entry.details }
    : entry.type === 'message' ? entry.message : undefined).filter(Boolean);
  const quiet = quietMessages(messages);
  const shown = [];
  const hidden = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const text = message.stopReason === 'aborted' || message.stopReason === 'error' ? '' : textOf(message.content);
    if (!text) continue;
    (quiet.has(message) ? hidden : shown).push({ text, final: message.stopReason !== 'toolUse' });
  }
  return { shown, hidden };
}

test('a recorded Segno transcript: what the app shows reaches Telegram once, what it hides never does', async (t) => {
  const box = await paired(t);
  const lines = readFileSync(RECORDED, 'utf8').trim().split('\n');
  const entries = lines.map((line) => JSON.parse(line));
  const { shown, hidden } = appShows(entries);
  assert.ok(shown.length >= 20 && hidden.length >= 20, 'the recording has both app turns and clock turns');

  // The conversation grows while the messenger watches it, a few entries at a time.
  const file = transcript(box, []);
  for (let index = 0; index < lines.length; index += 17) {
    appendFileSync(file, lines.slice(index, index + 17).join('\n') + '\n');
    await settle(box.service);
  }
  await settle(box.service);
  await settle(box.service);

  const sent = box.fake.sent.filter((row) => row.chatId === USER_CHAT && !/연결됐습니다/.test(row.text));
  assert.deepEqual(sent.map((row) => row.text), shown.map((item) => item.text), 'every shown text, once each, in order');
  assert.deepEqual(sent.map((row) => !row.disableNotification), shown.map((item) => item.final),
    'only a run\'s last answer notifies; a text before a tool call arrives silently');
  for (const { text } of hidden) assert.ok(!sentTexts(box).includes(text), `a clock run's text stayed out of Telegram: ${text}`);
  assert.ok(!sentTexts(box).some((text) => /private thought|user says/.test(text)), 'no thinking and no copy of the person\'s app words');

  const recorded = readFileSync(messengerPaths(box.env).sent, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(recorded.filter((row) => row.via === 'auto').length, shown.length, 'sent.jsonl holds each one, as auto');
});

test("an answer to a turn that started in the app goes to Telegram; the person's app words do not", async (t) => {
  const box = await paired(t);
  transcript(box, [appEntry('a1', '앱에서 쓴 말'), answerEntry('a2', '앱에서 물어본 회의는 3시로 옮겼어.')]);
  await settle(box.service);
  assert.deepEqual(sentTexts(box).filter((text) => !/연결됐습니다/.test(text)), ['앱에서 물어본 회의는 3시로 옮겼어.']);
});

test('the answer to a Telegram message goes back to the chat as Roo does: no quote, with a notification', async (t) => {
  const box = await paired(t);
  transcript(box, [channelEntry('e1', { messageId: 501 }), answerEntry('e2', '네, 지금 확인할게요.')]);
  await settle(box.service);
  const reply = box.fake.sent.find((row) => row.text === '네, 지금 확인할게요.');
  assert.equal(reply.chatId, USER_CHAT);
  assert.equal(reply.replyToMessageId, undefined, 'Roo answers in the chat, it does not quote the message');
  assert.equal(reply.disableNotification, false);
  await settle(box.service);
  assert.equal(sentTexts(box).filter((text) => text === '네, 지금 확인할게요.').length, 1);
});

test("Rubato's clock runs stay out of Telegram, whatever the wake: heartbeat, sleep, greeting, the old daily report", async (t) => {
  const box = await paired(t);
  const before = box.fake.sent.length;
  transcript(box, [
    wakeEntry('w1', 'heartbeat', 'tick 3'), answerEntry('w2', '리드 둘 다 아직 돌고 있어.'),
    wakeEntry('w3', 'sleep', 'Time to sleep.'), answerEntry('w4', '오늘 기록 쓰고 잘게.'),
    wakeEntry('w5', 'daily-report', 'It is nine.'), answerEntry('w6', '오늘 리포트.'),
  ]);
  await settle(box.service);
  assert.equal(box.fake.sent.length, before);
});

test('a lead ending wakes Segno visibly in the app, so its answer reaches Telegram too', async (t) => {
  const box = await paired(t);
  transcript(box, [noticeEntry('n1', 'Finished its turn.', { sessionId: 'lead-1', title: '버그 수정', cwd: '/tmp' }), answerEntry('n2', '버그 수정 끝났어.')]);
  await settle(box.service);
  assert.ok(sentTexts(box).includes('버그 수정 끝났어.'));
});

test('a text Segno already sent with telegram_send in the same run is not sent again by the sync', async (t) => {
  const box = await paired(t);
  transcript(box, [
    channelEntry('d1'),
    answerEntry('d2', '잠깐만, 확인해볼게.', { stopReason: 'toolUse', tools: [{ name: 'telegram_send', arguments: { text: '잠깐만, 확인해볼게.' } }] }),
    toolEntry('d3', 'telegram_send', 'sent (id: 900)'),
    answerEntry('d4', '다 확인했어. 둘 다 정상이야.', { stopReason: 'toolUse', tools: [{ name: 'telegram_send', arguments: { text: '다 확인했어. 둘 다 정상이야.' } }] }),
    toolEntry('d5', 'telegram_send'),
    answerEntry('d6', '다 확인했어.'),
  ]);
  await settle(box.service);
  const sent = sentTexts(box);
  assert.ok(!sent.includes('잠깐만, 확인해볼게.'), 'the mid-work text equal to a tool message is not repeated');
  assert.ok(!sent.includes('다 확인했어.'), 'a final answer the tool message already said is not repeated');
});

test('in a quiet run Segno speaks only through telegram_send; its answer stays in the session', async (t) => {
  const box = await paired(t);
  const before = box.fake.sent.length;
  transcript(box, [
    wakeEntry('q1', 'heartbeat', 'tick 1'),
    answerEntry('q2', '', { stopReason: 'toolUse', tools: [{ name: 'telegram_send', arguments: { text: '밥은 먹었어?' } }] }),
    toolEntry('q3', 'telegram_send'),
    answerEntry('q4', '물어봤으니 기다리자.'),
  ]);
  await settle(box.service);
  assert.equal(box.fake.sent.length, before, 'the sync sends nothing for a quiet run (the tool sends its own message)');
});

test("another person's turn: the answer is held for approval, and Segno's mid-work words do not go to them", async (t) => {
  const box = await paired(t);
  transcript(box, [
    channelEntry('o1', { isUser: false, chatId: GROUP_CHAT, name: 'Gildong' }),
    answerEntry('o2', '로그부터 볼게.', { stopReason: 'toolUse', tools: [{ name: 'read', arguments: {} }] }),
    toolEntry('o3', 'read'),
    answerEntry('o4', '재현 방법을 알려주세요.'),
  ]);
  await settle(box.service);
  const held = listOutbox(box.env).filter((row) => row.source === 'reply');
  assert.deepEqual(held.map((row) => [row.state, row.text]), [['held', '재현 방법을 알려주세요.']]);
  assert.equal(box.fake.sent.filter((row) => row.chatId === GROUP_CHAT).length, 0);
});

test('a long answer that fails halfway resumes after the parts that went out, never resending them', async (t) => {
  const box = await paired(t);
  const long = Array.from({ length: 3 }, (_, index) => `${String(index).repeat(3000)}`).join('\n\n');
  const send = box.fake.api.sendMessage;
  let calls = 0;
  box.fake.api.sendMessage = async (args) => { calls += 1; if (calls === 2) throw new Error('telegram hiccup'); return send(args); };
  transcript(box, [appEntry('l1', '길게'), answerEntry('l2', long)]);
  await settle(box.service);
  await settle(box.service);
  const parts = sentTexts(box).filter((text) => /^\d{3000}$/.test(text));
  assert.deepEqual(parts.map((text) => text[0]), ['0', '1', '2'], 'each part once, in order');
  assert.equal(box.errors.length, 1);
});

test('a transcript far past the old 256 KB tail still sends each new answer once', async (t) => {
  const box = await paired(t);
  const filler = Array.from({ length: 400 }, (_, index) => wakeEntry(`f${index}`, 'heartbeat', `tick ${index} ${'.'.repeat(800)}`));
  const file = transcript(box, filler);
  await settle(box.service);
  for (let round = 0; round < 3; round += 1) {
    appendFileSync(file, [appEntry(`u${round}`, `질문 ${round}`), answerEntry(`r${round}`, `답 ${round}`)].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await settle(box.service);
  }
  await settle(box.service);
  assert.deepEqual(sentTexts(box).filter((text) => /^답 /.test(text)), ['답 0', '답 1', '답 2']);
});

test('a cursor from before offsets is taken as read: nothing old is replayed', async (t) => {
  const box = await paired(t);
  const file = transcript(box, [appEntry('p1', '예전'), answerEntry('p2', '예전 답')]);
  writeState({ transcript: { file, seen: 1 } }, box.env);
  await settle(box.service);
  assert.ok(!sentTexts(box).includes('예전 답'));
  appendFileSync(file, [appEntry('p3', '지금'), answerEntry('p4', '지금 답')].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  await settle(box.service);
  assert.deepEqual(sentTexts(box).filter((text) => /답$/.test(text)), ['지금 답']);
  assert.ok(Number.isInteger(readState(box.env).transcript.offset));
});

test('"typing…" shows while Segno works on a Telegram turn and stops at its answer', async (t) => {
  const box = await paired(t, { typingDelay: () => 0 });
  box.fake.message({ chatId: USER_CHAT, text: '이거 좀 봐줘', from: 'Wy' });
  await settle(box.service);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(box.fake.actions.some((row) => row.chatId === USER_CHAT && row.action === 'typing'), 'typing started');
  transcript(box, [channelEntry('y1'), answerEntry('y2', '봤어.')]);
  await settle(box.service);
  const count = box.fake.actions.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(box.fake.actions.length, count, 'no typing after the answer');
});

test('a run that ends without words still stops the typing', async (t) => {
  const box = await paired(t, { typingDelay: () => 60 });
  box.fake.message({ chatId: USER_CHAT, text: '음', from: 'Wy' });
  await settle(box.service);
  transcript(box, [channelEntry('z1'), answerEntry('z2', '', { stopReason: 'aborted' })]);
  await settle(box.service);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(box.fake.actions.length, 0, 'it never started: the run ended first');
});
