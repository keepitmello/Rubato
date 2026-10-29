// What Segno says with reply or say becomes its own message in the thread, once per call that went
// through, whichever turn it came from (intent companion-segno rev 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RubatoRpcConnection } from '../src/rpc-connection.mjs';
import { sessionMessageId } from '../src/events.mjs';
import { SAID_KIND, channelItem, companionThreadItems, createSaidEcho, saidEchoes } from '../src/said-echo.mjs';
import { REPLY_TOOL, SAY_TOOL } from '../../companion/home.mjs';

const calling = (id, name, text, timestamp) => ({ role: 'assistant', stopReason: 'toolUse', timestamp,
  content: [{ type: 'text', text: '혼잣말' }, { type: 'toolCall', id, name, arguments: { text } }] });
const result = (id, name, timestamp, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: name, timestamp,
  content: [{ type: 'text', text: isError ? 'failed' : 'Sent to the user.' }], isError });

test('each reply or say that went through is one item of Segno\'s words; a failed one is none; the monologue around it is none', () => {
  const messages = [
    { role: 'user', content: '오늘 뭐 있어?', timestamp: 1 }, calling('r1', REPLY_TOOL, '3시에 회의 있어.', 2), result('r1', REPLY_TOOL, 3),
    calling('r2', REPLY_TOOL, '실패', 4), result('r2', REPLY_TOOL, 5, true),
    calling('s1', SAY_TOOL, '잘 자', 6), result('s1', SAY_TOOL, 7),
    calling('t1', 'tell_user', '예전 이름', 8), result('t1', 'tell_user', 9),
  ];
  const items = [...saidEchoes(messages, 'thread').values()];
  assert.deepEqual(items.map((item) => [item.text, item.ownRun, item.context.records[0].kind, item.context.records[0].payload.voice === true]),
    [['3시에 회의 있어.', true, SAID_KIND, false], ['잘 자', true, SAID_KIND, true]]);
  assert.equal(items[0].id, sessionMessageId('thread', 'said:r1'));
  assert.equal(items[0].createdAt, new Date(3).toISOString());
});

test('live: one item per call, when its result says it went through', () => {
  const echo = createSaidEcho({ threadId: 't1' });
  assert.equal(echo.accept({ type: 'message_end', message: calling('r1', REPLY_TOOL, '산책 가자', 1) }), undefined);
  const item = echo.accept({ type: 'message_end', message: result('r1', REPLY_TOOL, 2) });
  assert.equal(item.text, '산책 가자');
  assert.equal(echo.accept({ type: 'message_end', message: result('r1', REPLY_TOOL, 2) }), undefined, 'once');
});

test('Telegram inputs appear as the person in both companions, never a third party or a machine wake', () => {
  const message = { role: 'custom', customType: 'rubato-session-message', timestamp: 5,
    details: { kind: 'channel', messageId: 'telegram:1:2', text: 'from Telegram', from: { channel: 'telegram', isUser: true } } };
  for (const id of ['roo-thread', 'segno-thread']) {
    const item = channelItem(message, id);
    assert.equal(item.id, sessionMessageId(id, 'telegram:1:2'));
    assert.equal(item.context.records[0].payload.role, 'user');
    assert.equal(item.text, 'from Telegram');
    assert.deepEqual(companionThreadItems([message], id, () => { throw Error('not a plain message'); }), [item]);
  }
  assert.equal(channelItem({ ...message, details: { ...message.details, from: { channel: 'telegram', isUser: false } } }, 't'), undefined);
  assert.equal(channelItem({ ...message, details: { ...message.details, kind: 'wake' } }, 't'), undefined);
});

test('only confirmed Telegram sends to the person appear in the app; a matching reply is not a duplicate', () => {
  const send = (id, args, state = 'sent', target = 'user') => [
    { ...calling(id, 'telegram_send', args.text, 1), content: [{ type: 'toolCall', id, name: 'telegram_send', arguments: args }] },
    { ...result(id, 'telegram_send', 2), details: { state, target } },
  ];
  const messages = [...send('sent', { text: 'hello' }), calling('reply', 'reply', 'hello', 3), result('reply', 'reply', 4),
    ...send('held', { text: 'do not show' }, 'held'), ...send('queued', { text: 'not sent yet' }, 'queued'),
    ...send('other', { text: 'private group', to: '-123' }, 'sent', { chatId: '-123' }),
    { role: 'user', content: 'again', timestamp: 7 }, calling('again', 'reply', 'hello', 8), result('again', 'reply', 9)];
  assert.deepEqual([...saidEchoes(messages, 't').values()].map(item => item.text), ['hello', 'hello']);
});

test('after a time with no stream, the backfill writes what Segno said, once, under the live id', async () => {
  const written = [];
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    appendSessionMessage: async (threadId, item) => { written.push([threadId, item.id, item.text]); },
    viaInventory: async () => undefined },
  { threadId: 't1', cwd: '/w', onRecord: () => {}, onClosed: () => {}, awaitTimings: { pollMs: 5, graceMs: 5 } });
  const messages = [{ role: 'user', content: 'hi', timestamp: 1 }, calling('c1', REPLY_TOOL, '좋은 아침', 4), result('c1', REPLY_TOOL, 5)];
  conn.backfillSaidEchoes(messages);
  conn.backfillSaidEchoes(messages);
  assert.deepEqual(written, [['t1', sessionMessageId('t1', 'said:c1'), '좋은 아침']]);
});
