// What arrives with a Telegram message besides words (Roo's daemon: message:photo … message:voice)
// and the commands answered without a Segno turn (Roo's /context, /heartbeat).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readSettings as readCompanionSettings } from '../../companion.mjs';
import { buildSessionMessage, parseDelivery } from '../../../pi-runtime/features/session-link/message.mjs';
import { messengerPaths } from '../store.mjs';
import { GROUP_CHAT, USER_CHAT, paired, settle } from './helpers.mjs';
import { parseControlCommand } from '../commands.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** What the model gets for one delivery, built by the session link as the engine would. */
const modelSees = (delivery) => buildSessionMessage(parseDelivery({ v: 1, messageId: 'm', kind: 'channel', from: delivery.from,
  text: delivery.text, ...(delivery.attachments ? { attachments: delivery.attachments } : {}) }));

test('a photo is saved in the companion home and Segno sees it as an image, with the caption as the words', async (t) => {
  const box = await paired(t);
  box.fake.addFile('ph-big', 'photos/file_9.jpg', JPEG);
  box.fake.raw({ chatId: USER_CHAT, caption: '이거 우리 집 고양이', photo: [
    { file_id: 'ph-small', file_unique_id: 'small', file_size: 10 }, { file_id: 'ph-big', file_unique_id: 'big', file_size: JPEG.length }] });
  await settle(box.service);
  const [delivery] = box.delivered;
  assert.equal(delivery.text, '이거 우리 집 고양이');
  assert.equal(delivery.attachments.length, 1);
  const [photo] = delivery.attachments;
  assert.equal(photo.kind, 'photo');
  assert.ok(photo.path.startsWith(messengerPaths(box.env).received), 'saved under the companion home');
  assert.deepEqual(readFileSync(photo.path), JPEG, 'the largest size Telegram offered');
  const seen = modelSees(delivery);
  assert.equal(seen.content[1].type, 'image');
  assert.equal(seen.content[1].data, JPEG.toString('base64'));
});

test('a photo without a caption reads "(photo)", as in Roo', async (t) => {
  const box = await paired(t);
  box.fake.addFile('p1', 'photos/a.jpg', JPEG);
  box.fake.raw({ chatId: USER_CHAT, photo: [{ file_id: 'p1', file_unique_id: 'p1u' }] });
  await settle(box.service);
  assert.equal(box.delivered[0].text, '(photo)');
});

test('a document is saved where Segno can open it and named in the message', async (t) => {
  const box = await paired(t);
  box.fake.addFile('d1', 'documents/file_3.pdf', Buffer.from('%PDF-1.7'));
  box.fake.raw({ chatId: USER_CHAT, document: { file_id: 'd1', file_unique_id: 'd1u', file_name: '견적서.pdf', mime_type: 'application/pdf', file_size: 8 } });
  await settle(box.service);
  const [delivery] = box.delivered;
  assert.equal(delivery.text, '(document: 견적서.pdf)');
  assert.equal(delivery.attachments[0].name, '견적서.pdf');
  assert.match(delivery.attachments[0].path, /\.pdf$/);
  assert.equal(readFileSync(delivery.attachments[0].path, 'utf8'), '%PDF-1.7');
  const seen = modelSees(delivery);
  assert.equal(typeof seen.content, 'string', 'a document is a path, not an image');
  assert.ok(seen.content.includes(delivery.attachments[0].path));
});

test('a file Telegram will not hand over arrives as words that say so, never as a fake image', async (t) => {
  const box = await paired(t);
  box.fake.raw({ chatId: USER_CHAT, photo: [{ file_id: 'gone', file_unique_id: 'g' }] });
  box.fake.raw({ chatId: USER_CHAT, document: { file_id: 'huge', file_name: 'movie.mov', file_size: 50 * 1024 * 1024 } });
  await settle(box.service);
  assert.match(box.delivered[0].text, /^\(photo\)\n\(photo could not be downloaded: .*invalid file_id/);
  assert.equal(box.delivered[0].attachments, undefined);
  assert.match(box.delivered[1].text, /too large for a bot to download/);
});

test('a voice message is transcribed into words tagged [voice], and its audio and transcript are kept', async (t) => {
  const heard = [];
  const box = await paired(t, { transcribe: async (audio) => { heard.push(audio); return { text: '내일 아침에 깨워줘', engine: 'fixture' }; } });
  box.fake.addFile('v1', 'voice/file_5.oga', Buffer.from('OggS-voice'));
  box.fake.raw({ chatId: USER_CHAT, voice: { file_id: 'v1', file_unique_id: 'v1u', mime_type: 'audio/ogg', duration: 2 } });
  await settle(box.service);
  assert.equal(box.delivered[0].text, '[voice]\n내일 아침에 깨워줘');
  assert.equal(heard[0].ext, 'ogg');
  const [dir] = readdirSync(messengerPaths(box.env).stt);
  const record = JSON.parse(readFileSync(path.join(messengerPaths(box.env).stt, dir, 'transcription.json'), 'utf8'));
  assert.deepEqual([record.status, record.transcript, record.audioFile, record.engine], ['transcribed', '내일 아침에 깨워줘', 'audio.ogg', 'fixture']);
});

test("a voice message that cannot be heard arrives with Roo's failure tag, and the reason is kept without secrets", async (t) => {
  const box = await paired(t, { transcribe: async () => { throw new Error('rejected key sk-abcdef123456'); } });
  box.fake.addFile('v2', 'voice/file_6.oga', Buffer.from('OggS'));
  box.fake.raw({ chatId: USER_CHAT, voice: { file_id: 'v2', file_unique_id: 'v2u' } });
  await settle(box.service);
  assert.equal(box.delivered[0].text, '[voice:전사 실패]\n음성 내용을 전사하지 못했어.');
  const [dir] = readdirSync(messengerPaths(box.env).stt);
  const record = readFileSync(path.join(messengerPaths(box.env).stt, dir, 'transcription.json'), 'utf8');
  assert.match(record, /"status": "failed"/);
  assert.doesNotMatch(record, /sk-abcdef/);
});

test("another person's photo reaches Segno too, still without the user's authority", async (t) => {
  const box = await paired(t);
  box.fake.addFile('g1', 'photos/g.jpg', JPEG);
  box.fake.raw({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그 리포트', from: 'Gildong', caption: '이 화면이 떠요',
    photo: [{ file_id: 'g1', file_unique_id: 'g1u' }] });
  await settle(box.service);
  const [delivery] = box.delivered;
  assert.equal(delivery.from.isUser, false);
  assert.equal(delivery.attachments[0].kind, 'photo');
  assert.match(delivery.text, /이 화면이 떠요/);
});

test("Roo's command forms: /context, /heartbeat on|start, off|stop, bare off, a @bot suffix", () => {
  assert.deepEqual(parseControlCommand('/context'), { command: 'context' });
  assert.deepEqual(parseControlCommand('/context@segno_bot'), { command: 'context' });
  assert.deepEqual(parseControlCommand('/heartbeat on'), { command: 'heartbeat', enable: true });
  assert.deepEqual(parseControlCommand('/heartbeat START'), { command: 'heartbeat', enable: true });
  assert.deepEqual(parseControlCommand('/heartbeat stop'), { command: 'heartbeat', enable: false });
  assert.deepEqual(parseControlCommand('/heartbeat'), { command: 'heartbeat', enable: false });
  assert.equal(parseControlCommand('/heartbeat maybe'), undefined);
  assert.equal(parseControlCommand('context 알려줘'), undefined);
});

test('/context answers from the engine at once, and Segno never gets a turn for it', async (t) => {
  const asked = [];
  const box = await paired(t, { sessionStats: async (id) => { asked.push(id); return { contextUsage: { tokens: 412_000, contextWindow: 1_000_000, percent: 41.2 } }; } });
  box.fake.message({ chatId: USER_CHAT, text: '/context', from: 'Wy' });
  await settle(box.service);
  assert.deepEqual(asked, ['S1']);
  assert.equal(box.delivered.length, 0, 'no Segno turn');
  assert.equal(box.fake.sent.at(-1).text, '[Rubato] 세뇨 컨텍스트\n남은 컨텍스트: 58.8%\n사용 중: 41.2%\n토큰: 412,000 / 1,000,000\n기준: Rubato 엔진 세션 통계');
});

test('/context says why when the engine cannot tell', async (t) => {
  const box = await paired(t, { sessionStats: async () => ({ contextUsage: { tokens: null, contextWindow: 1_000_000, percent: null } }) });
  box.fake.message({ chatId: USER_CHAT, text: '/context', from: 'Wy' });
  await settle(box.service);
  assert.match(box.fake.sent.at(-1).text, /확인하지 못했어요\.\n이유: 압축 직후/);
});

test("/heartbeat off and on switch Segno's heartbeat setting and answer directly", async (t) => {
  const box = await paired(t);
  box.fake.message({ chatId: USER_CHAT, text: '/heartbeat off', from: 'Wy' });
  await settle(box.service);
  assert.equal(readCompanionSettings(box.env).heartbeat.enabled, false);
  assert.match(box.fake.sent.at(-1).text, /heartbeat: 꺼짐[\s\S]*다시 켜려면 \/heartbeat on/);
  box.fake.message({ chatId: USER_CHAT, text: '/heartbeat on', from: 'Wy' });
  await settle(box.service);
  assert.equal(readCompanionSettings(box.env).heartbeat.enabled, true);
  assert.equal(box.delivered.length, 0);
});

test('in another chat the commands are ordinary words and change nothing', async (t) => {
  const box = await paired(t);
  box.fake.message({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그', text: '/heartbeat off', from: 'Gildong' });
  await settle(box.service);
  assert.equal(readCompanionSettings(box.env).heartbeat.enabled, true);
  assert.equal(box.delivered.length, 1, 'it reached Segno as their words');
});

test("the person's message waits in Telegram while Segno's conversation is not running yet, then arrives once", async (t) => {
  const box = await paired(t);
  const { writeState: writeCompanion } = await import('../../companion.mjs');
  const { readState } = await import('../store.mjs');
  writeCompanion({ sessionId: '' }, box.env);
  const update = box.fake.message({ chatId: USER_CHAT, text: '부팅 중에 보낸 말', from: 'Wy' });
  await settle(box.service);
  assert.equal(box.delivered.length, 0);
  assert.ok((readState(box.env).offset ?? 0) <= update.update_id, 'the offset did not move past it');
  for (let pass = 0; pass < 60; pass += 1) await box.service.poke();
  assert.equal(box.errors.length, 0, 'waiting is not a failure, and nothing is given up after many passes');
  writeCompanion({ sessionId: 'S1' }, box.env);
  await settle(box.service);
  assert.deepEqual(box.delivered.map((delivery) => delivery.text), ['부팅 중에 보낸 말']);
});

test("the person's own chat has no burst cap, as in Roo; other chats keep theirs", async (t) => {
  const box = await paired(t);
  for (let index = 0; index < 35; index += 1) box.fake.message({ chatId: USER_CHAT, text: `메시지 ${index}`, from: 'Wy' });
  await settle(box.service);
  assert.equal(box.delivered.length, 35);
});

test("another person's report is filed at once even before Segno runs, and reaches Segno once it does", async (t) => {
  const box = await paired(t);
  const { writeState: writeCompanion } = await import('../../companion.mjs');
  const { openInbox } = await import('../../inbox.mjs');
  writeCompanion({ sessionId: '' }, box.env);
  box.fake.message({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그', text: '앱이 꺼져요', from: 'Gildong' });
  await settle(box.service);
  const inbox = openInbox({ env: box.env });
  try { assert.equal(inbox.list().length, 1, 'filed while waiting'); } finally { inbox.close(); }
  writeCompanion({ sessionId: 'S1' }, box.env);
  await settle(box.service);
  assert.equal(box.delivered.length, 1);
  const again = openInbox({ env: box.env });
  try { assert.equal(again.list().length, 1, 'still one item'); } finally { again.close(); }
});

test("a report waiting for Segno's conversation is retried without using up its chat's cap, and still arrives", async (t) => {
  const box = await paired(t);
  const { writeState: writeCompanion } = await import('../../companion.mjs');
  writeCompanion({ sessionId: '' }, box.env);
  box.fake.message({ chatId: GROUP_CHAT, chatType: 'supergroup', title: '버그', text: '오래 기다린 신고', from: 'Gildong' });
  for (let pass = 0; pass < 40; pass += 1) await box.service.poke();
  writeCompanion({ sessionId: 'S1' }, box.env);
  await settle(box.service);
  assert.deepEqual(box.delivered.map((delivery) => delivery.text.split('\n')[0]), ['오래 기다린 신고']);
});
