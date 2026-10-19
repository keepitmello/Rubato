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

