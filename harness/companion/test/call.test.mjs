import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CALL_EFFORTS, CALL_SAY_TOOL, CALL_WAIT_TOOL, CALL_PASS_TOOL, DEFAULT_CALL_EFFORT, createCompanionCall,
  createCompanionCallFactories, stableSentenceCut } from '../../pi-runtime/features/companion-home/call.mjs';
import { createReplyWait } from '../../pi-runtime/features/companion-home/index.mjs';
import { SESSION_MESSAGE_TYPE } from '../../pi-runtime/features/session-link/message.mjs';
import { CALL_EFFORTS as SETTINGS_CALL_EFFORTS, DEFAULT_SETTINGS, readSettings, writeSettings } from '../companion.mjs';
import { capabilityActive } from '../home.mjs';

async function fixture(t, { home, config = {}, script, level = 'high' } = {}) {
  home ??= mkdtempSync(path.join(tmpdir(), 'call-'));
  const env = { HOME: home, RUBATO_COMPANION_HOME: home, RUBATO_PI_ROLE: 'companion',
    RUBATO_COMPANION_ID: 'other', RUBATO_COMPANION_TITLE: 'Other' };
  const handlers = new Map(), tools = new Map(), messages = [], errors = [];
  const thinking = { level, changes: [] };
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
    getThinkingLevel: () => thinking.level,
    setThinkingLevel(next) { thinking.level = next; thinking.changes.push(next); },
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
  return { pi, bridge, ctx, base, post, home, env, errors, tools, emit, messages, thinking, aborts: () => aborts };
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

test('a line spoken while another step runs is answered on the call once it enters, not lost to that step', async t => {
  // The 2026-11-14 call: the client cancels the answer to the first line when the person keeps
  // talking, another run starts in the gap, and the newer line is steered in behind that run's step.
  const home = mkdtempSync(path.join(tmpdir(), 'call-'));
  const handlers = new Map(), tools = new Map(), steered = [];
  let busy = false;
  const ctx = { sessionManager: { getSessionId: () => 'gap' }, isIdle: () => !busy, abort: async () => { busy = false; } };
  const emit = (name, data = {}) => { for (const handler of handlers.get(name) ?? []) handler(data, ctx); };
  const pi = { on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { tools.set(tool.name, tool); }, sendMessage() {},
    sendUserMessage(content) {
      if (busy) { steered.push(content); return; }
      busy = true; emit('message_start', { message: { role: 'user', content } });
    } };
  const bridge = createCompanionCall(pi, { env: { HOME: home, RUBATO_COMPANION_HOME: home },
    config: { enabled: true, host: '127.0.0.1', port: 0, turnTimeoutMs: 5000 } });
  await bridge.start(ctx);
  t.after(async () => { await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const turn = (text, turnId, signal) => fetch(`${base}/call/turn`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, turnId }) });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  const client = new AbortController();
  const first = await turn('어 통화 되네, 신기하다. 아니 이제 앱도 만들었거든.', 'first', client.signal);
  client.abort(); await first.body?.cancel().catch(() => {}); await settle();
  assert.equal(bridge.active, undefined, 'the cancelled answer no longer holds the call');
  busy = true; // a run that something else started in the gap
  const second = turn('모바일 앱.', 'second');
  while (!steered.length) await settle();
  assert.equal(steered[0], '[voice] 모바일 앱.');

  const early = await tools.get(CALL_SAY_TOOL).execute('gap-say', { text: '앱을 만들었다고? 폰이야, 맥이야?' });
  assert.equal(early.isError, true);
  assert.notEqual(early.terminate, true, 'the step goes on, so the steered line enters right after it');
  assert.match(early.content[0].text, /newer line comes in right after this/);

  emit('message_start', { message: { role: 'user', content: steered.shift() } });
  const answer = '모바일 앱! 이제 폰만 있으면 어디서든 나 부를 수 있네.';
  emit('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0,
    toolCall: { type: 'toolCall', id: 'answer', name: CALL_SAY_TOOL, arguments: { text: answer } } } });
  assert.equal((await tools.get(CALL_SAY_TOOL).execute('answer', { text: answer })).content[0].text, 'Delivered on the call.');
  const rows = await eventsOf(await second);
  assert.equal(rows.filter(row => row.t === 'delta').map(row => row.text).join(''), answer);
  assert.equal(rows.at(-1).source, CALL_SAY_TOOL);
  assert.doesNotMatch(JSON.stringify(rows), /폰이야, 맥이야/);
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

const openCall = async (box, callId) => fetch(`${box.base}/call/health?watch=1&callId=${callId}`);
const endCall = async (box, callId, watch) => { await box.post('/call/end', { callId }); await watch.body.cancel(); };

test('a call lowers the conversation to the call effort and puts the level back when it ends', async t => {
  assert.deepEqual(CALL_EFFORTS, SETTINGS_CALL_EFFORTS, 'the bridge reads the same choices the settings write');
  assert.equal(DEFAULT_CALL_EFFORT, DEFAULT_SETTINGS.call.effort);
  const box = await fixture(t);
  const watch = await openCall(box, 'c1');
  assert.equal(box.thinking.level, 'medium');
  await endCall(box, 'c1', watch);
  assert.equal(box.thinking.level, 'high');
  assert.equal(existsSync(path.join(box.home, 'call/effort.json')), false);
  assert.deepEqual(box.errors, []);
});

test('the call effort follows the settings, and conversation leaves the level alone', async t => {
  const box = await fixture(t);
  assert.equal(readSettings(box.env).call.effort, 'medium');
  writeSettings({ call: { effort: 'low' } }, box.env);
  let watch = await openCall(box, 'c1');
  assert.equal(box.thinking.level, 'low');
  await endCall(box, 'c1', watch);
  assert.equal(box.thinking.level, 'high');
  writeSettings({ call: { effort: 'conversation' } }, box.env);
  const changes = box.thinking.changes.length;
  watch = await openCall(box, 'c2');
  await endCall(box, 'c2', watch);
  assert.equal(box.thinking.changes.length, changes);
  assert.equal(box.thinking.level, 'high');
});

test('a level the person picks during a call stays after it ends', async t => {
  const box = await fixture(t);
  const watch = await openCall(box, 'c1');
  box.pi.setThinkingLevel('xhigh');
  await endCall(box, 'c1', watch);
  assert.equal(box.thinking.level, 'xhigh');
});

test('an engine that stopped mid-call puts the level back when the conversation starts again', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'call-'));
  mkdirSync(path.join(home, 'call'), { recursive: true });
  writeFileSync(path.join(home, 'call/effort.json'), JSON.stringify({ restoreTo: 'high', during: 'medium' }));
  const box = await fixture(t, { home, level: 'medium' });
  assert.equal(box.thinking.level, 'high');
  assert.equal(existsSync(path.join(home, 'call/effort.json')), false);
});
