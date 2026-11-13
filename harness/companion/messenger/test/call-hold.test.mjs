// The companion's words stay off Telegram while it is on a call with the person (the call card has
// them), judged by when each was said, and all of them when the person turned outbound delivery off.
// Telegram still brings the person's messages in.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCallWindows, TAIL_MS } from '../../call-window.mjs';
import { REPLY_TOOL } from '../../home.mjs';
import { writeMessengerSettings } from '../store.mjs';
import { USER_CHAT, answerEntry, appEntry, paired, settle, toolEntry, transcript } from './helpers.mjs';

const T0 = Date.UTC(2026, 10, 13, 17, 26, 38);
const T1 = T0 + 6 * 60_000;
const at = (ms) => new Date(ms).toISOString();
const stamp = (entry, ms) => ({ ...entry, timestamp: at(ms) });
const reply = (id, text, ms) => [
  stamp(answerEntry(`${id}-call`, 'PRIVATE', { stopReason: 'toolUse', tools: [{ name: REPLY_TOOL, arguments: { text } }] }), ms),
  stamp(toolEntry(`${id}-result`, REPLY_TOOL, 'Sent to the user.', { callId: `${id}-call-t0` }), ms),
];
const sentTexts = (box) => box.fake.sent.filter((row) => row.chatId === USER_CHAT && !/연결됐습니다/.test(row.text)).map((row) => row.text);

function callLog(t, box, calls) {
  const dir = path.join(box.dir, 'calls');
  mkdirSync(dir, { recursive: true });
  for (const call of calls) writeFileSync(path.join(dir, `${call.id}.json`), JSON.stringify(call));
  return createCallWindows({ dir });
}

async function boxWithCalls(t, calls) {
  let windows;
  const box = await paired(t, { callWindows: { inCall: (...args) => windows.inCall(...args) } });
  windows = callLog(t, box, calls);
  return box;
}

test("what is said during the companion's call stays off Telegram, even when the mirror catches up afterwards", async (t) => {
  const box = await boxWithCalls(t, [{ id: 'call-segno-1', companion: 'segno', status: 'ended', answeredAt: T0, endedAt: T1 }]);
  transcript(box, [
    ...reply('before', 'BEFORE_CALL', T0 - 60_000),
    stamp(appEntry('heard', '[voice] 어 통화 되네'), T0 + 20_000),
    ...reply('during', 'DURING_CALL', T0 + 30_000),
    ...reply('tail', 'LAST_WORDS', T1 + TAIL_MS - 1_000),
    ...reply('after', 'AFTER_CALL', T1 + 40_000),
  ]);
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box), ['BEFORE_CALL', 'AFTER_CALL']);
});

test("another companion's call does not hold this companion's words", async (t) => {
  const box = await boxWithCalls(t, [{ id: 'call-roo-1', companion: 'roo', status: 'ended', answeredAt: T0, endedAt: T1 }]);
  transcript(box, [...reply('during', 'SEGNO_DURING_ROOS_CALL', T0 + 30_000)]);
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box), ['SEGNO_DURING_ROOS_CALL']);
});

test('a call that is still up holds a send addressed to the person; the tool hears why', async (t) => {
  const box = await boxWithCalls(t, [{ id: 'call-segno-2', companion: 'segno', status: 'active', answeredAt: Date.now() - 5_000, endedAt: null }]);
  const row = await box.service.send({ text: '통화 중에 보내는 말', to: 'user' });
  assert.equal(row.state, 'off');
  assert.match(row.note, /call/);
  await settle(box.service);
  assert.deepEqual(sentTexts(box), []);
});

test('with outbound delivery off nothing of the companion goes to Telegram, and the person still reaches it from there', async (t) => {
  const box = await boxWithCalls(t, []);
  writeMessengerSettings({ outbound: false }, box.env);
  transcript(box, [stamp(appEntry('app', '앱에서 한 말'), T0), ...reply('r', 'NOT_ON_TELEGRAM', T0 + 1_000)]);
  const row = await box.service.send({ text: '파일 보낼게', to: 'user' });
  assert.equal(row.state, 'off');
  assert.match(row.note, /turned Telegram delivery off/);
  box.fake.message({ chatId: USER_CHAT, text: '텔레그램에서 보낸 말', from: 'Wy' });
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box), []);
  assert.ok(box.delivered.some((item) => item.text === '텔레그램에서 보낸 말'), 'inbound still arrives');
  // Turned back on: what comes next goes out again.
  writeMessengerSettings({ outbound: true }, box.env);
  transcript(box, [...reply('r2', 'BACK_ON', Date.now())], { append: true });
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box), ['BACK_ON']);
});
