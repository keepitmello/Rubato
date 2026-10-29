// Same mouth in the application and Telegram: successful explicit reply/say only.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { freshRun, readEntriesFrom, stepRun } from '../sync.mjs';
import { REPLY_TOOL, SAY_TOOL } from '../../home.mjs';
import { readState, writeState, messengerPaths, listOutbox } from '../store.mjs';
import { GROUP_CHAT, USER_CHAT, answerEntry, appEntry, channelEntry, noticeEntry, paired, settle, toolEntry, transcript, wakeEntry } from './helpers.mjs';

const sentTexts = box => box.fake.sent.filter(row => row.chatId === USER_CHAT && !/연결됐습니다/.test(row.text)).map(row => row.text);
const mouth = (id, text, { name = REPLY_TOOL, isError = false } = {}) => [
  answerEntry(`${id}-call`, 'PRIVATE BESIDE THE MOUTH', { stopReason: 'toolUse', tools: [{ name, arguments: { text } }] }),
  toolEntry(`${id}-result`, name, isError ? 'failed' : 'Sent to the user.', { callId: `${id}-call-t0`, isError }),
];

test('a recorded legacy transcript cannot leak any assistant monologue when Telegram is enabled', async t => {
  const box = await paired(t);
  const lines = readFileSync(new URL('./fixtures/segno-recorded.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const file = transcript(box, []);
  for (let at = 0; at < lines.length; at += 17) {
    appendFileSync(file, lines.slice(at, at + 17).join('\n') + '\n'); await settle(box.service);
  }
  assert.deepEqual(sentTexts(box), []);
});

test('ordinary text stays private for user, app, clock, completion, game and call turns', async t => {
  const box = await paired(t);
  transcript(box, [
    appEntry('a', 'user in app'), answerEntry('b', 'APP_PRIVATE'),
    channelEntry('c'), answerEntry('d', 'TELEGRAM_PRIVATE'),
    noticeEntry('e', 'work finished'), answerEntry('f', 'NOTICE_PRIVATE'),
    ...['heartbeat', 'sleep', 'greeting', 'daily-report', 'game', 'call'].flatMap((what, index) =>
      [wakeEntry(`w${index}`, what, `wake ${what}`), answerEntry(`p${index}`, `PRIVATE_${what}`)]),
    answerEntry('game-tool', 'PRIVATE GAME', { stopReason: 'toolUse', tools: [{ name: 'mc_say', arguments: { text: 'game only' } }] }),
    toolEntry('game-result', 'mc_say', 'ok', { callId: 'game-tool-t0' }),
    answerEntry('call-tool', '', { stopReason: 'toolUse', tools: [{ name: 'call_say', arguments: { text: 'voice only' } }] }),
    toolEntry('call-result', 'call_say', 'Delivered on the call.', { callId: 'call-tool-t0' }),
  ]);
  await settle(box.service);
  assert.deepEqual(sentTexts(box), []);
});

test('only successful explicit replies mirror to the paired user, once, without quoting their message', async t => {
  const box = await paired(t);
  transcript(box, [channelEntry('c', { messageId: 501 }), ...mouth('r', 'OUTWARD_REPLY'),
    ...mouth('bad', 'FAILED_REPLY', { isError: true }), ...mouth('say', 'OUTWARD_SAY', { name: SAY_TOOL })]);
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box), ['OUTWARD_REPLY', 'OUTWARD_SAY']);
  const sent = box.fake.sent.find(row => row.text === 'OUTWARD_REPLY');
  assert.equal(sent.replyToMessageId, undefined);
  assert.equal(sent.disableNotification, false);
  const recorded = readFileSync(messengerPaths(box.env).sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(recorded.filter(row => row.via === 'auto').length, 2);
});

test('a wake never silences an explicit reply, and a game event cannot redirect it to another chat', async t => {
  const box = await paired(t);
  transcript(box, [channelEntry('group', { isUser: false, chatId: GROUP_CHAT }),
    wakeEntry('game', 'game', 'game event'), ...mouth('r', 'TO THE PERSON'),
    wakeEntry('heartbeat', 'heartbeat', 'tick'), ...mouth('clock', 'ALSO TO THE PERSON')]);
  await settle(box.service);
  assert.deepEqual(sentTexts(box), ['TO THE PERSON', 'ALSO TO THE PERSON']);
  assert.equal(box.fake.sent.some(row => row.chatId === GROUP_CHAT), false);
  assert.equal(listOutbox(box.env).filter(row => row.source === 'reply').length, 0);
});

test('an explicit Telegram send is not mirrored; a matching reply does not duplicate a confirmed send', async t => {
  const box = await paired(t);
  transcript(box, [appEntry('u', 'hello'),
    answerEntry('send', 'PRIVATE', { stopReason: 'toolUse', tools: [{ name: 'telegram_send', arguments: { text: 'already sent' } }] }),
    toolEntry('sent', 'telegram_send', 'sent (id: 900)', { callId: 'send-t0' }),
    ...mouth('same', 'already sent'), ...mouth('other', 'new explicit reply')]);
  await settle(box.service);
  assert.deepEqual(sentTexts(box), ['new explicit reply']);
});

test('a failed or held Telegram send cannot suppress an explicit reply', async t => {
  for (const [index, isError, text] of [[0, true, 'failed'], [1, false, "Held for the person's approval"]]) {
    const box = await paired(t);
    transcript(box, [appEntry('u', 'hello'),
      answerEntry(`send${index}`, '', { stopReason: 'toolUse', tools: [{ name: 'telegram_send', arguments: { text: 'explicit reply' } }] }),
      toolEntry(`result${index}`, 'telegram_send', text, { callId: `send${index}-t0`, isError }),
      ...mouth(`reply${index}`, 'explicit reply')]);
    await settle(box.service);
    assert.deepEqual(sentTexts(box), ['explicit reply']);
  }
});

test('a split reply resumes after the parts already delivered, without repeating them', async t => {
  const box = await paired(t);
  const long = ['0', '1', '2'].map(char => char.repeat(3000)).join('\n\n');
  const send = box.fake.api.sendMessage;
  let calls = 0;
  box.fake.api.sendMessage = async args => { if (++calls === 2) throw new Error('telegram hiccup'); return send(args); };
  transcript(box, [appEntry('u', 'long'), ...mouth('long', long)]);
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box).map(text => text[0]), ['0', '1', '2']);
  assert.equal(box.errors.length, 1);
});

test('an existing old cursor drops its held monologue and does not replay history', async t => {
  const box = await paired(t);
  const file = transcript(box, [appEntry('u', 'hello')]);
  await settle(box.service);
  const state = readState(box.env);
  writeState({ transcript: { ...state.transcript, run: {
    quiet: false, held: { text: 'OLD PRIVATE HELD TEXT', waitFor: [], final: true }, calls: {}, launches: {},
  } } }, box.env);
  appendFileSync(file, [...mouth('r', 'NEW EXPLICIT REPLY')].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  await settle(box.service);
  assert.deepEqual(sentTexts(box), ['NEW EXPLICIT REPLY']);
});

test('large journals and a partial last line do not lose or duplicate a reply receipt', async t => {
  const box = await paired(t);
  const file = transcript(box, Array.from({ length: 400 }, (_, i) => wakeEntry(`f${i}`, 'heartbeat', '.'.repeat(800))));
  await settle(box.service);
  const [call, result] = mouth('tail', 'TAIL_REPLY');
  appendFileSync(file, JSON.stringify(call) + '\n' + JSON.stringify(result));
  await settle(box.service);
  assert.deepEqual(sentTexts(box), []);
  appendFileSync(file, '\n');
  await settle(box.service); await settle(box.service);
  assert.deepEqual(sentTexts(box), ['TAIL_REPLY']);
  assert.deepEqual((await readEntriesFrom(file, readState(box.env).transcript.offset)).entries, []);
});

test('tool results need their own matching successful call, not a forged name or a failed generation', () => {
  const run = freshRun();
  const [call, result] = mouth('r', 'REAL');
  stepRun(run, call);
  assert.deepEqual(stepRun(run, toolEntry('wrong', 'mc_say', 'ok', { callId: 'r-call-t0' })), []);
  assert.equal(stepRun(run, result)[0].text, 'REAL');
  assert.deepEqual(stepRun(run, result), []);
  const [failed, failedResult] = mouth('aborted', 'NO');
  failed.message.stopReason = 'aborted';
  stepRun(run, failed);
  assert.deepEqual(stepRun(run, failedResult), []);
});

test('a silent final stops Telegram typing without sending monologue', async t => {
  const box = await paired(t, { typingDelay: () => 0 });
  box.fake.message({ chatId: USER_CHAT, text: 'hello' });
  await settle(box.service);
  transcript(box, [channelEntry('c'), answerEntry('final', 'PRIVATE_FINAL')]);
  await settle(box.service);
  assert.deepEqual(sentTexts(box), []);
  assert.deepEqual(box.errors, []);
});
