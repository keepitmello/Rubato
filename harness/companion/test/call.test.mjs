import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CALL_SAY_TOOL, CALL_WAIT_TOOL, CALL_PASS_TOOL, createCompanionCall, createCompanionCallFactories,
  stableSentenceCut } from '../../pi-runtime/features/companion-home/call.mjs';
import { createReplyWait } from '../../pi-runtime/features/companion-home/index.mjs';
import { SESSION_MESSAGE_TYPE } from '../../pi-runtime/features/session-link/message.mjs';
import { capabilityActive } from '../home.mjs';

async function fixture(t, { home, config = {}, script } = {}) {
  home ??= mkdtempSync(path.join(tmpdir(), 'call-'));
  const env = { HOME: home, RUBATO_COMPANION_HOME: home, RUBATO_PI_ROLE: 'companion',
    RUBATO_COMPANION_ID: 'other', RUBATO_COMPANION_TITLE: 'Other' };
  const handlers = new Map(), tools = new Map(), messages = [], errors = [];
  let busy = false, aborts = 0;
  const ctx = { sessionManager: { getSessionId: () => 'same-native-conversation' }, model: { id: 'fake-model' },
    isIdle: () => !busy, abort: async () => { aborts++; busy = false; }, ui: { notify() {} } };
  const emit = (name, data = {}) => {
    if (name === 'agent_settled') busy = false;
    for (const handler of handlers.get(name) ?? []) handler(data, ctx);
  };
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage(message, options) {
      messages.push({ message, options });
      emit('message_start', { message: { role: 'custom', ...message } });
      if (options.triggerTurn) { busy = true; setImmediate(() => script?.({ pi, emit, tools, machine: true })); }
    },
    sendUserMessage(content, options) {
      messages.push({ message: { role: 'user', content }, options });
      busy = true; emit('message_start', { message: { role: 'user', content } });
      setImmediate(() => script?.({ pi, emit, tools, machine: false }));
    },
  };
  const bridge = createCompanionCall(pi, { env, config: { enabled: true, host: '127.0.0.1', port: 0, turnTimeoutMs: 2000, ...config },
    onError: error => errors.push(error) });
  await bridge.start(ctx);
  t.after(async () => { await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const post = (url, value) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { pi, bridge, ctx, base, post, home, errors, tools, emit, messages, aborts: () => aborts };
}
const eventsOf = async response => (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const toolEnd = (emit, name, args, id = 'call-tool') => {
  emit('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0,
    toolCall: { type: 'toolCall', id, name, arguments: args } } });
  emit('agent_settled');
};

test('call is opt-in and no companion gets a listener or tools by default', () => {
  assert.deepEqual(createCompanionCallFactories({ env: {} }), []);
  assert.equal(stableSentenceCut('A decimal 3.14 is not finished.'), -1);
  assert.equal(stableSentenceCut('A sentence. More'), 12);
});

test('the actual HTTP call streams only explicit stable speech from the same native conversation', async t => {
  const box = await fixture(t, { script: ({ emit }) => {
    emit('message_update', { assistantMessageEvent: { type: 'text_end', content: 'PRIVATE MONOLOGUE' } });
    for (const value of ['Hello.', 'Hello. Again', 'Hallo. Again']) emit('message_update', {
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0,
        partial: { content: [{ type: 'toolCall', name: CALL_SAY_TOOL, arguments: { text: value } }] } },
    });
    toolEnd(emit, CALL_SAY_TOOL, { text: 'Hello. Again.' });
  } });
  const health = await (await fetch(`${box.base}/call/health`)).json();
  assert.equal(health.sessionId, 'same-native-conversation');
  const rows = await eventsOf(await box.post('/call/turn', { text: 'heard words', turnId: 'voice-1' }));
  assert.equal(rows.filter(row => row.t === 'delta').map(row => row.text).join(''), 'Hello. Again.');
  assert.deepEqual(rows.at(-1), { t: 'done', text: 'Hello. Again.', source: CALL_SAY_TOOL, toolsBeforeSay: [] });
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE MONOLOGUE|Hallo/);
  const human = box.messages.filter(item => item.message.role === 'user');
  assert.equal(human.length, 1);
  assert.equal(human[0].message.content, '[voice] heard words');
  assert.equal(box.messages[0].message.customType, SESSION_MESSAGE_TYPE);
  assert.equal(box.messages[0].message.details.kind, 'wake', 'the call brief is machine context, not a fabricated user message');
  const executed = await box.tools.get(CALL_SAY_TOOL).execute('call-tool', { text: 'Hello. Again.' });
  assert.equal(executed.terminate, true);
  assert.equal(executed.isError, undefined);
  assert.deepEqual(box.errors, []);
});

test('ordinary assistant text is never a spoken fallback and a successful call reply needs no app echo', async t => {
  const box = await fixture(t, { script: ({ emit }) => {
    emit('message_update', { assistantMessageEvent: { type: 'text_end', content: 'private thoughts, not speech' } });
    emit('agent_settled');
  } });
  const rows = await eventsOf(await box.post('/call/qwen-turn', { text: 'hello', turnId: 'no-mouth' }));
  assert.equal(rows.at(-1).source, 'none');
  assert.equal(rows.at(-1).text, '');
  assert.doesNotMatch(JSON.stringify(rows), /private thoughts/);
  const waiting = createReplyWait();
  waiting.message({ role: 'user', content: '[voice] hello' });
  waiting.toolEnd({ toolName: CALL_SAY_TOOL, isError: false });
  assert.equal(waiting.settled(), false, 'reply reminder does not send the spoken answer into the app or Telegram');
});

test('opportunities are machine context; wait/pass/end emit no speech and keep the same conversation', async t => {
  let count = 0;
  const box = await fixture(t, { script: ({ emit, machine }) => {
    assert.equal(machine, true);
    count++;
    toolEnd(emit, count === 1 ? CALL_WAIT_TOOL : CALL_PASS_TOOL,
      count === 1 ? { after_seconds: 5, reason: 'a concrete pending thought' } : {}, `op-${count}`);
  } });
  const watch = await fetch(`${box.base}/call/health?watch=1&callId=c1`);
  assert.equal(capabilityActive('call', { env: { RUBATO_COMPANION_HOME: box.home } }), true);
  const rows = await eventsOf(await box.post('/call/opportunity', { turnId: 'opportunity-1', reason: 'look again' }));
  assert.equal(rows.at(-1).source, CALL_WAIT_TOOL);
  assert.equal(rows.at(-1).waitMs, 5000);
  assert.equal(rows.at(-1).text, '');
  assert.equal(box.messages.filter(item => item.message.role === 'user').length, 0);
  assert.equal((await eventsOf(await box.post('/call/opportunity', { turnId: 'opportunity-2' }))).at(-1).source, CALL_PASS_TOOL);
  assert.equal((await (await box.post('/call/end', { callId: 'c1' })).json()).ended, true);
  assert.equal(capabilityActive('call', { env: { RUBATO_COMPANION_HOME: box.home } }), false);
  await watch.body.cancel();
  assert.equal(box.messages.at(-1).message.details.kind, 'wake');
  assert.equal(box.messages.at(-1).options.triggerTurn, false);
});

test('cancellation interrupts generation and a replay after restart never repeats a human turn or its speech', async t => {
  const box = await fixture(t);
  const response = await box.post('/call/turn', { text: 'do not repeat', turnId: 'durable-turn' });
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await (await box.post('/call/cancel', { turnId: 'durable-turn' })).json();
  assert.equal(cancelled.cancelled, true);
  await eventsOf(response);
  assert.equal(box.aborts(), 1);
  await box.bridge.close();
  const again = await fixture(t, { home: box.home });
  const replay = await eventsOf(await again.post('/call/turn', { text: 'do not repeat', turnId: 'durable-turn' }));
  assert.equal(replay.at(-1).duplicate, true);
  assert.equal(replay.at(-1).source, 'none');
  assert.equal(again.messages.length, 0);
  const files = readdirSync(path.join(box.home, 'call/turns'));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(box.home, 'call/turns', files[0]), 'utf8')).status, 'interrupted');
});

test('another real user message cancels the voice turn, so its later tools cannot become speech', async t => {
  const box = await fixture(t);
  const response = await box.post('/call/turn', { text: 'voice first', turnId: 'interleaved' });
  await new Promise(resolve => setImmediate(resolve));
  box.emit('message_start', { message: { role: 'user', content: 'a newer app message' } });
  toolEnd(box.emit, CALL_SAY_TOOL, { text: 'this belongs to the newer app message' });
  const rows = await eventsOf(response);
  assert.equal(rows.some(row => row.t === 'delta'), false);
  assert.equal(rows.at(-1).t, 'error');
  assert.equal((await box.tools.get(CALL_SAY_TOOL).execute('late', { text: 'no listener' })).isError, true);
});

test('unauthorized and malformed inputs never open a model turn; a port collision stays a capability failure', async t => {
  const box = await fixture(t, { config: { token: 'isolated-token' } });
  assert.equal((await box.post('/call/turn', { text: 'refuse me' })).status, 401);
  assert.equal((await fetch(`${box.base}/call/turn`, { method: 'POST', headers: { authorization: 'Bearer isolated-token' }, body: 'not JSON' })).status, 400);
  assert.equal(box.messages.length, 0);
  const errors = [];
  const pi = { on() {}, registerTool() {} };
  const other = createCompanionCall(pi, { env: { RUBATO_COMPANION_HOME: box.home }, config: { host: '127.0.0.1', port: box.bridge.address().port },
    onError: error => errors.push(error) });
  await other.start(box.ctx);
  assert.equal(errors[0]?.code, 'EADDRINUSE');
  assert.equal((await fetch(`${box.base}/call/health`, { headers: { authorization: 'Bearer isolated-token' } })).status, 200);
  await other.close();
});
