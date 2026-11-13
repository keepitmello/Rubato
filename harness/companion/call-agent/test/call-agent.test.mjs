import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CALL_SAY_TOOL, createCompanionCall } from '../../../pi-runtime/features/companion-home/call.mjs';
import { createBridge } from '../bridge.mjs';
import { callableCompanions, resolveCompanion } from '../companion.mjs';

// The companion's real call bridge on a fake session: `say` streams call_say the way a model
// writes it, `hang` leaves the turn unfinished.
async function companionSession(t, behaviour) {
  const home = mkdtempSync(path.join(tmpdir(), 'call-agent-'));
  const env = { HOME: home, RUBATO_COMPANION_HOME: home, RUBATO_PI_ROLE: 'companion', RUBATO_COMPANION_ID: 'other', RUBATO_COMPANION_TITLE: 'Other' };
  const handlers = new Map(), heard = [], system = [];
  let busy = false, aborts = 0;
  const ctx = { sessionManager: { getSessionId: () => 'native' }, model: { id: 'fake' }, isIdle: () => !busy,
    abort: async () => { aborts++; busy = false; }, ui: { notify() {} } };
  const emit = (name, data = {}) => { if (name === 'agent_settled') busy = false; for (const handler of handlers.get(name) ?? []) handler(data, ctx); };
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {},
    sendMessage(message) { system.push(message.details?.text ?? ''); emit('message_start', { message: { role: 'custom', ...message } }); },
    sendUserMessage(content) {
      heard.push(content); busy = true; emit('message_start', { message: { role: 'user', content } });
      setImmediate(() => behaviour(emit));
    },
  };
  const bridge = createCompanionCall(pi, { env, config: { enabled: true, host: '127.0.0.1', port: 0, turnTimeoutMs: 5000 } });
  await bridge.start(ctx);
  t.after(async () => { await bridge.close(); rmSync(home, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${bridge.address().port}`, heard, system, home, aborts: () => aborts };
}

const say = text => emit => {
  for (let end = 1; end <= text.length; end++) emit('message_update', { assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0,
    partial: { content: [{ type: 'toolCall', name: CALL_SAY_TOOL, arguments: { text: text.slice(0, end) } }] } } });
  emit('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0,
    toolCall: { type: 'toolCall', id: 'say-1', name: CALL_SAY_TOOL, arguments: { text } } } });
  emit('agent_settled');
};

test('a heard turn reaches the companion as voice and its sentences come back in order', async t => {
  const companion = await companionSession(t, say('응, 들려! 나 여기 있어.'));
  const client = createBridge({ url: companion.url });
  const call = await client.open('room-1');
  assert.equal(call.health.sessionId, 'native');
  const events = [];
  for await (const event of client.turn('루야 들려?')) events.push(event);
  assert.deepEqual(events.filter(event => event.t === 'delta').map(event => event.text), ['응, 들려! ', '나 여기 있어.']);
  assert.equal(events.at(-1).t, 'done');
  assert.deepEqual(companion.heard, ['[voice] 루야 들려?']);
  await call.end();
  assert.match(companion.system.at(-1), /^\[voice\] 통화 종료/);
});

test('cutting a turn off on this side stops the companion mid-thought', async t => {
  const companion = await companionSession(t, () => {});
  const client = createBridge({ url: companion.url });
  const controller = new AbortController();
  const turn = client.turn('긴 질문', { turnId: 'cut-1', signal: controller.signal });
  const first = turn.next();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(first);
  for (let at = 0; at < 50 && companion.aborts() === 0; at++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(companion.aborts(), 1);
  const [receipt] = readdirSync(path.join(companion.home, 'call', 'turns'));
  assert.equal(JSON.parse(readFileSync(path.join(companion.home, 'call', 'turns', receipt), 'utf8')).status, 'interrupted');
});

test('a call reaches only companions with a bridge and a chosen voice, in that voice', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'call-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = (id, call) => {
    const home = path.join(root, id);
    mkdirSync(path.join(home, 'messenger'), { recursive: true });
    return { id, title: id, home, memoryAgent: id, call };
  };
  const voiced = profile('voiced', { enabled: true, port: 18001 });
  const silent = profile('silent', { enabled: true, port: 18002 });
  const closed = profile('closed', { enabled: false });
  const voiceId = '3c7ee7e408104d76a777ebaadc201896';
  for (const item of [voiced, closed])
    writeFileSync(path.join(item.home, 'messenger', 'settings.json'), JSON.stringify({ voice: { voiceId, model: 's2.1-pro' } }));
  const file = path.join(root, 'companions.json');
  writeFileSync(file, JSON.stringify({ companions: [voiced, silent, closed] }));
  const env = { HOME: root, RUBATO_COMPANIONS_FILE: file, FISH_API_KEY: 'fish-key' };

  const resolved = resolveCompanion('voiced', env);
  assert.equal(resolved.bridge.url, 'http://127.0.0.1:18001');
  assert.deepEqual([resolved.voice.voiceId, resolved.voice.model, resolved.fishKey], [voiceId, 's2.1-pro', 'fish-key']);
  assert.throws(() => resolveCompanion('silent', env), /no voice is chosen for silent/);
  assert.throws(() => resolveCompanion('closed', env), /closed has no call bridge/);
  assert.deepEqual(callableCompanions(env).map(item => [item.id, item.ready]),
    [['segno', false], ['voiced', true], ['silent', false], ['closed', false]]);
});
