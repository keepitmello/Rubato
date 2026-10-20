// Segno's hands on Telegram (Roo's telegram_reply, react, edit_message): files, voice notes,
// reactions and edits go out through the messenger, and nothing reaches another chat before the
// person approves it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listOutbox, messengerPaths, writeDecision, writeMessengerSettings } from '../store.mjs';
import { GROUP_CHAT, USER_CHAT, paired, settle } from './helpers.mjs';
import { synthesizeVoice, oggOpusSeconds } from '../voice.mjs';

const sentLog = (box) => {
  try { return readFileSync(messengerPaths(box.env).sent, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); }
  catch { return []; }
};

/** A tiny Ogg/Opus file: OpusHead with a 312-sample pre-skip, last page at 2.5 s of 48 kHz. */
function oggBytes(seconds = 2.5) {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1'); head.writeUInt8(1, 8); head.writeUInt8(1, 9); head.writeUInt16LE(312, 10);
  const page = (granule) => { const b = Buffer.alloc(27); b.write('OggS', 0, 'latin1'); b.writeBigUInt64LE(BigInt(granule), 6); return b; };
  return Buffer.concat([page(0), head, page(Math.round(seconds * 48_000) + 312)]);
}

test('a message with files goes out as text, then each file as a photo or a document, and answers with the ids', async (t) => {
  const box = await paired(t);
  const photo = path.join(box.dir, 'cat.png');
  const doc = path.join(box.dir, 'notes.md');
  writeFileSync(photo, 'png'); writeFileSync(doc, '# 정리');
  const row = await box.service.send({ text: '**정리**해서 보낼게', files: [photo, doc], to: 'user' });
  assert.equal(row.state, 'sent');
  assert.equal(box.fake.sent.at(-1).text, '정리해서 보낼게', 'Markdown emphasis does not reach plain-text Telegram');
  assert.deepEqual(box.fake.uploads.map((upload) => [upload.kind, path.basename(upload.file)]), [['photo', 'cat.png'], ['document', 'notes.md']]);
  assert.equal(row.messageIds.length, 3);
  assert.deepEqual(sentLog(box).at(-1), { at: sentLog(box).at(-1).at, chatId: USER_CHAT, toUser: true, text: '정리해서 보낼게', via: 'tool', media: 'document' });
});

test("the messenger's own files are never sent; a missing file fails the call and nothing is retried", async (t) => {
  const box = await paired(t);
  await assert.rejects(box.service.send({ files: [messengerPaths(box.env).secret], to: 'user' }), /belongs to the messenger/);
  await assert.rejects(box.service.send({ files: [path.join(box.dir, 'gone.pdf')], to: 'user' }), /no such file/);
  assert.deepEqual(listOutbox(box.env).filter((row) => row.source === 'tool').map((row) => row.state), ['failed', 'failed']);
  await settle(box.service);
  assert.equal(box.fake.uploads.length, 0, 'a failed row stays failed: the tool already told Segno');
});

test('with no voice chosen yet, text and voice sends the text and says the voice was skipped; voice-only fails', async (t) => {
  const box = await paired(t);
  const both = await box.service.send({ text: '오늘 고마웠어', voice: true, to: 'user' });
  assert.equal(both.state, 'sent');
  assert.match(both.note, /voice skipped: no voice is chosen for Segno yet/);
  assert.equal(box.fake.uploads.length, 0);
  await assert.rejects(box.service.send({ text: '잘 자', voice: 'only', to: 'user' }), /voice-only reply failed: no voice is chosen/);
});

test('a voice reply: the sanitized words go to the voice, the voice note goes after the text, with its length', async (t) => {
  const spoken = [];
  const box = await paired(t, { synthesize: async (text) => {
    spoken.push(text);
    const file = path.join(messengerPaths(box.env).voice, 'v.ogg');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, oggBytes());
    return { path: file, durationSec: 3 };
  } });
  const row = await box.service.send({ text: '좋아 [laughing] 내일 보자 :)', voice: true, to: 'user' });
  assert.equal(box.fake.sent.at(-1).text, '좋아 내일 보자 :)', 'the text hides the voice tag');
  assert.deepEqual(spoken, ['좋아 [laughing] 내일 보자'], 'the voice keeps the tag and drops the emoticon');
  assert.equal(box.fake.uploads.at(-1).kind, 'voice');
  assert.equal(box.fake.uploads.at(-1).durationSec, 3);
  assert.match(row.note, /\+ voice/);
  const only = await box.service.send({ voiceText: '잘 자', voice: 'only', to: 'user' });
  assert.equal(only.messageIds.length, 1);
  assert.equal(sentLog(box).at(-1).media, 'voice');
});

test('Fish Audio is asked for Opus in the chosen voice, and the key never leaves the request header', async (t) => {
  const box = await paired(t);
  writeMessengerSettings({ voice: { voiceId: 'fixturevoice0001' } }, box.env);
  const asked = [];
  const env = { ...box.env, FISH_API_KEY: 'fish-secret' };
  const voice = await synthesizeVoice('안녕', { env, fetch: async (url, init) => { asked.push({ url, init }); return new Response(oggBytes()); } });
  const body = JSON.parse(asked[0].init.body);
  assert.deepEqual([body.reference_id, body.format, body.latency, body.temperature], ['fixturevoice0001', 'opus', 'balanced', 0.3]);
  assert.equal(asked[0].init.headers.authorization, 'Bearer fish-secret');
  assert.equal(asked[0].init.headers.model, 's2.1-pro-free');
  assert.equal(voice.durationSec, 3);
  assert.equal(oggOpusSeconds(readFileSync(voice.path)), 3);
  await assert.rejects(synthesizeVoice('안녕', { env, fetch: async () => new Response('nope', { status: 402 }) }),
    (error) => /HTTP 402/.test(error.message) && !/fish-secret/.test(error.message));
  await assert.rejects(synthesizeVoice('안녕', { env, fetch: async () => new Response('ID3notogg') }), /Ogg\/Opus/);
});

test("a reaction lands on the person's latest message unless Segno names one; an edit changes Segno's own", async (t) => {
  const box = await paired(t);
  const incoming = box.fake.message({ chatId: USER_CHAT, text: '이거 봐', from: 'Wy' });
  await settle(box.service);
  await box.service.send({ op: 'react', emoji: '👍', to: 'user' });
  assert.deepEqual(box.fake.reactions.at(-1), { chatId: USER_CHAT, messageId: incoming.message.message_id, emoji: '👍' });
  const sent = await box.service.send({ text: '3시야', to: 'user' });
  await box.service.send({ op: 'edit', messageId: sent.messageIds[0], text: '*4시*야', to: 'user' });
  assert.deepEqual(box.fake.edited.at(-1), { chatId: USER_CHAT, messageId: sent.messageIds[0], text: '4시야' });
});

test('files, voice notes, reactions and edits to another chat all wait for the person', async (t) => {
  const box = await paired(t);
  const doc = path.join(box.dir, 'fix.md');
  writeFileSync(doc, '고친 내용');
  const rows = [
    await box.service.send({ text: '고쳤어요', files: [doc], to: GROUP_CHAT, name: '버그 리포트' }),
    await box.service.send({ op: 'react', emoji: '🙏', messageId: 12, to: GROUP_CHAT }),
    await box.service.send({ op: 'edit', messageId: 13, text: '정정합니다', to: GROUP_CHAT }),
  ];
  assert.deepEqual(rows.map((row) => row.state), ['held', 'held', 'held']);
  await settle(box.service);
  assert.equal(box.fake.sent.filter((row) => row.chatId === GROUP_CHAT).length, 0);
  assert.equal(box.fake.uploads.length + box.fake.reactions.length + box.fake.edited.length, 0, 'nothing reached the group');
  const cards = box.fake.sent.filter((row) => row.chatId === USER_CHAT && row.keyboard).map((row) => row.text);
  assert.equal(cards.length, 3);
  assert.match(cards[0], /고쳤어요[\s\S]*파일: fix\.md/);
  assert.match(cards[1], /반응 🙏 — 메시지 12/);
  assert.match(cards[2], /메시지 13 고치기:\n정정합니다/);

  writeDecision(rows[0].id, 'approve', { by: 'app' }, box.env);
  writeDecision(rows[1].id, 'reject', { by: 'app' }, box.env);
  await settle(box.service);
  assert.ok(box.fake.sent.some((row) => row.chatId === GROUP_CHAT && row.text === '고쳤어요'));
  assert.deepEqual(box.fake.uploads.map((row) => [row.chatId, path.basename(row.file)]), [[GROUP_CHAT, 'fix.md']]);
  assert.equal(box.fake.reactions.length, 0, 'the refused reaction never happened');
  assert.equal(box.fake.edited.filter((row) => row.chatId === GROUP_CHAT).length, 0, 'the edit still waits');
});

test('before Telegram is connected a tool message waits, and goes out once the chat is paired', async (t) => {
  const box = await paired(t);
  const { writePairing } = await import('../store.mjs');
  writePairing({ status: 'unpaired' }, box.env);
  const row = await box.service.send({ text: '연결되면 보내줘', to: 'user' });
  assert.equal(row.state, 'queued');
  assert.match(row.note, /not connected/);
  writePairing({ status: 'paired', chat: { chatId: USER_CHAT } }, box.env);
  await settle(box.service);
  assert.ok(box.fake.sent.some((sent) => sent.text === '연결되면 보내줘'));
});
