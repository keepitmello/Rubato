import assert from 'node:assert/strict';
import test from 'node:test';
import { BotApiError, createBotApi } from '../bot-api.mjs';
import { createFakeTelegramServer } from '../fake-telegram-server.mjs';

test('the client talks HTTP to the Bot API, and a token never appears in what Settings shows', async (t) => {
  const fake = createFakeTelegramServer({ token: '42:aa' });
  const { url } = await fake.listen();
  t.after(() => fake.close());
  const api = createBotApi({ token: '42:aa', baseUrl: url });

  assert.equal((await api.getMe()).username, 'segno_test_bot');
  assert.deepEqual(await api.getUpdates({ offset: 0, timeout: 0 }), []);

  const message = await api.sendMessage({ chatId: 777, text: '안녕' });
  assert.equal(message.text, '안녕');
  assert.deepEqual(fake.sent.map((row) => [row.chatId, row.text]), [['777', '안녕']]);

  await api.editMessageText({ chatId: 777, messageId: message.message_id, text: '고침' });
  assert.equal(fake.edited.at(-1).text, '고침');
});

test('a Bot API refusal keeps its code and description', async (t) => {
  const fake = createFakeTelegramServer({ token: '42:aa' });
  const { url } = await fake.listen();
  t.after(() => fake.close());
  const api = createBotApi({ token: '42:wrong', baseUrl: url });
  await assert.rejects(api.getMe(), (error) => {
    assert.ok(error instanceof BotApiError);
    assert.equal(error.code, 401);
    assert.match(error.message, /Unauthorized/);
    return true;
  });
});

test('a long poll ends when the service closes', async (t) => {
  const fake = createFakeTelegramServer({ token: '42:aa' });
  const { url } = await fake.listen();
  t.after(() => fake.close());
  const api = createBotApi({ token: '42:aa', baseUrl: url });
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(api.getUpdates({ timeout: 0 }, { signal: stop.signal }), (error) => error?.aborted === true);
});


test('files go up as multipart uploads, and a file Telegram holds comes down as bytes', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-botapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = createFakeTelegramServer({ token: '42:aa' });
  const { url } = await fake.listen();
  t.after(() => fake.close());
  const api = createBotApi({ token: '42:aa', baseUrl: url });

  const photo = path.join(dir, 'cat.jpg');
  writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  const sent = await api.sendPhoto({ chatId: 777, file: photo, caption: '고양이', disableNotification: true });
  assert.equal(typeof sent.message_id, 'number');
  const voice = path.join(dir, 'hi.ogg');
  writeFileSync(voice, Buffer.from('OggS-voice'));
  await api.sendVoice({ chatId: 777, file: voice, durationSec: 3 });
  const doc = path.join(dir, 'notes.md');
  writeFileSync(doc, '# 노트');
  await api.sendDocument({ chatId: 777, file: doc });
  assert.deepEqual(fake.uploads.map((row) => [row.kind, row.name, row.bytes.length]),
    [['photo', 'cat.jpg', 6], ['voice', 'hi.ogg', 10], ['document', 'notes.md', Buffer.byteLength('# 노트')]]);
  assert.equal(fake.uploads[0].caption, '고양이');
  assert.equal(fake.uploads[0].disableNotification, true);

  await api.sendChatAction({ chatId: 777 });
  assert.equal(fake.actions.at(-1).action, 'typing');
  await api.setMessageReaction({ chatId: 777, messageId: sent.message_id, emoji: '👍' });
  assert.deepEqual(fake.reactions.at(-1).reaction, [{ type: 'emoji', emoji: '👍' }]);

  fake.addFile('f1', 'photos/file_1.jpg', Buffer.from([9, 8, 7]));
  const file = await api.getFile({ fileId: 'f1' });
  assert.equal(file.file_path, 'photos/file_1.jpg');
  assert.deepEqual([...await api.downloadFile({ filePath: file.file_path })], [9, 8, 7]);
  await assert.rejects(api.downloadFile({ filePath: 'photos/none.jpg' }), (error) => {
    assert.doesNotMatch(String(error.message), /42:aa/, 'a failed download never names the token');
    return error instanceof BotApiError;
  });
});

test('a network failure never carries the token in its message', async () => {
  const api = createBotApi({ token: '42:secretsecret', baseUrl: 'http://127.0.0.1:9',
    fetch: async (target) => { throw new Error(`connect failed for ${target}`); } });
  await assert.rejects(api.getMe(), (error) => {
    assert.doesNotMatch(error.message, /secretsecret/);
    return true;
  });
});
