// The app and Telegram show the same conversation: what Segno sends the person with telegram_send
// from a run the thread hides (Rubato's clock) still appears in the thread, as Segno's words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RubatoRpcConnection } from '../src/rpc-connection.mjs';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { SESSION_MESSAGE_TYPE, sessionMessageId } from '../src/events.mjs';
import { TELEGRAM_ECHO_KIND, echoText } from '../src/telegram-echo.mjs';

const wake = (what, timestamp) => ({ role: 'custom', customType: SESSION_MESSAGE_TYPE, display: false, timestamp, content: 'w',
  details: { v: 1, messageId: `wake-${timestamp}`, kind: 'wake', what, from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text: 'tick' } });
const calling = (id, args, timestamp, text = '') => ({ role: 'assistant', stopReason: 'toolUse', timestamp,
  content: [...(text ? [{ type: 'text', text }] : []), { type: 'toolCall', id, name: 'telegram_send', arguments: args }] });
const result = (id, text, timestamp, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: 'telegram_send', timestamp,
  content: [{ type: 'text', text }], isError });
const answer = (text, timestamp) => ({ role: 'assistant', stopReason: 'stop', timestamp, content: [{ type: 'text', text }] });

test("a stored conversation: a quiet run's telegram_send to the person shows as Segno's words; nothing else of the run does", async () => {
  const bridge = new RubatoPiBridge({ descriptorPath: '/nonexistent/descriptor.json', instanceId: 'rubato-test' });
  try {
    const items = bridge.importedMessages('session', [
      { role: 'user', content: 'hi', timestamp: 1 }, answer('hello', 2),
      wake('heartbeat', 3), calling('c1', { text: '**밥**은 먹었어?' }, 4, '혼잣말'), result('c1', 'sent (id: 10)', 5), answer('물어봤다.', 6),
      wake('sleep', 7), calling('c2', { text: '좋은 아침', to: '-100' }, 8), result('c2', "Held for the person's approval", 9),
      calling('c3', { text: '실패한 말' }, 10), result('c3', 'telegram_send failed', 11, true),
      calling('c4', { voice: 'only', voice_text: '잘 자' }, 12), result('c4', 'sent (id: 11) (voice)', 13),
      { role: 'user', content: '고마워', timestamp: 14 }, calling('c5', { text: '앱 턴에서 보낸 말' }, 15), result('c5', 'sent (id: 12)', 16), answer('응', 17),
    ], 'thread');
    // The server drops items without text (RubatoPiInventory.ts); a reply that only called tools has none.
    assert.deepEqual(items.filter((item) => item.text.trim()).map((item) => [item.role, item.text]), [
      ['user', 'hi'], ['assistant', 'hello'],
      ['user', '밥은 먹었어?'],
      ['user', '(음성) 잘 자'],
      ['user', '고마워'], ['assistant', '응'],
    ], 'the quiet runs show only what reached the person; a shown run is already there as its tool call');
    const [echo] = items.filter((item) => item.context?.records?.[0]?.kind === TELEGRAM_ECHO_KIND);
    assert.equal(echo.id, sessionMessageId('thread', 'telegram:c1'), 'the same id live and on import, so it is written once');
    assert.equal(echo.createdAt, new Date(5).toISOString());
  } finally { await bridge.close(); }
});

test("live: the thread gets a quiet run's message once, when its result says it went out", async () => {
  const written = [];
  const client = { client: { connected: true }, listener: null, async attach() {}, async detach() {},
    async subscribeSession(listener) { client.listener = listener; return async () => {}; }, async command() { return undefined; }, async close() {} };
  const conn = new RubatoRpcConnection({ claimed: new Set(), pendingPrompts: new Map(), skillNames: new Set(),
    appendSessionMessage: async (threadId, item) => { written.push([threadId, item]); },
    viaInventory: async (call) => call({ create: async () => ({ sessionId: 'x' }) }) },
  { threadId: 't1', cwd: '/w', onRecord: () => {}, onClosed: () => {}, awaitTimings: { pollMs: 5, graceMs: 5 } });
  conn.client = client;
  await conn.request({ type: 'switch_session', sessionPath: 's1' });
  client.listener({ runtimeId: 'r1', sequence: 0, status: 'idle', events: [] });
  const events = [
    { type: 'agent_start' }, { type: 'message_end', message: wake('heartbeat', 1) },
    { type: 'message_end', message: calling('c1', { text: '산책 가자', files: ['/tmp/길.jpg'] }, 2) },
    { type: 'message_end', message: result('c1', 'sent 2 parts (ids: 5, 6)', 3) },
    { type: 'agent_settled' },
  ];
  client.listener({ runtimeId: 'r1', sequence: events.length, status: 'running', events: events.map((event, index) => ({ sequence: index + 1, event })) });
  client.listener({ runtimeId: 'r1', sequence: events.length, status: 'idle', events: events.map((event, index) => ({ sequence: index + 1, event })) });
  await conn.inbound;
  assert.deepEqual(written.map(([threadId, item]) => [threadId, item.text]), [['t1', '산책 가자\n(파일: 길.jpg)']]);
  assert.equal(written[0][1].context.records[0].kind, TELEGRAM_ECHO_KIND);
});

test('what the thread shows is what the phone got: Telegram text, the voice note\'s words, the files', () => {
  assert.equal(echoText({ text: '좋아 [laughing] *진짜*' }), '좋아 진짜');
  assert.equal(echoText({ text: '그대로 *둬*', sanitize: false }), '그대로 *둬*');
  assert.equal(echoText({ text: '들어봐', voice: 'only', voice_text: '안녕' }), '(음성) 안녕');
  assert.equal(echoText({ files: ['/a/b/report.md'] }), '(파일: report.md)');
  assert.equal(echoText({}), '');
});
