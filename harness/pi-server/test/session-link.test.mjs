import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionFiles } from '../src/session-files.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { startSessionServer } from '../src/host.mjs';
import { SessionClient } from '../src/client.mjs';
import { createSessionLink, LIMITS, TAIL_BYTES } from '../src/session-link.mjs';

const fixture = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const until = async (predicate, message = 'Condition did not settle') => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await delay(10); }
  throw new Error(message);
};
const keys = (value) => Object.keys(value).sort();

async function setup(t, { now, startDelayMs = 0 } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-link-')));
  const sessionsDir = path.join(root, 'sessions');
  const socketPath = path.join(root, 'pi.sock');
  const errors = [];
  const service = await startSessionServer({ socketPath, sessionsDir, idleMs: 5000, pollMs: 50,
    workerFactory: (metadata) => {
      const worker = new RpcWorker(metadata, { cliPath: fixture });
      // A slow load, to hold an attach in flight deliberately.
      if (startDelayMs) { const start = worker.start.bind(worker); worker.start = async () => { await delay(startDelayMs); return start(); }; }
      return worker;
    }, onError: (error) => errors.push(error) });
  const link = createSessionLink({ pollMs: 20, now });
  link.bind({ host: service.host, sessionsDir, socketPath, serverId: service.serverId });
  const clients = [];
  t.after(async () => {
    link.close();
    await Promise.all(clients.map((client) => client.close()));
    await service.close();
    await rm(root, { force: true, recursive: true });
  });
  const files = new SessionFiles(sessionsDir);
  const row = (id) => service.host.directory.value.sessions.find((item) => item.sessionId === id);
  const listed = (id) => until(() => row(id), `session ${id} never reached the directory`);
  const make = async (title) => { const created = await files.create({ cwd: root, title }); await listed(created.id); return created; };
  const client = async () => {
    const instance = await new SessionClient({ socketPath, serverId: service.serverId }).connect();
    clients.push(instance); return instance;
  };
  const deliveries = (id) => service.host.getSessionWorker(id)
    .request({ type: 'extension_request', name: 'fixture.session-link.deliveries' });
  return { root, sessionsDir, service, host: service.host, link, api: link.api, row, listed, make, client, deliveries, errors };
}

const stamp = () => new Date().toISOString();
const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } });
const assistant = (text, { stopReason = 'stop', tools = [] } = {}) => ({ type: 'message', message: { role: 'assistant',
  content: [...(text ? [{ type: 'text', text }] : []), ...tools.map((name, i) => ({ type: 'toolCall', id: `call-${i}`, name, arguments: {} }))],
  stopReason, provider: 'fixture', model: 'local', timestamp: Date.now() } });
const toolResult = (text) => ({ type: 'message', message: { role: 'toolResult', toolCallId: 'call-0', toolName: 'read',
  content: [{ type: 'text', text }], isError: false, timestamp: Date.now() } });

/** A transcript written the way Pi writes one: header, then entries chained by parentId. */
async function writeSession(dir, cwd, entries) {
  const id = randomUUID();
  const timestamp = stamp();
  const file = path.join(dir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  let parentId = null;
  const chained = entries.map((entry, index) => {
    const value = { id: `e${index}`, parentId, timestamp, ...entry };
    parentId = value.id;
    return value;
  });
  await writeFile(file, [{ type: 'session', version: 3, id, timestamp, cwd }, ...chained].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return { id, file, entries: chained };
}

test('the extension-facing object has exactly the six methods and refuses until the engine binds it', async () => {
  const link = createSessionLink();
  assert.deepEqual(keys(link.api), ['create', 'fork', 'list', 'read', 'send', 'wait']);
  assert.ok(Object.isFrozen(link.api));
  for (const name of Object.keys(link.api)) {
    await assert.rejects(link.api[name]({}), /session link is not available in this process/);
  }
});

test('list: frozen row shape, live sessions first, query and cwd filters, limit with truncation', async (t) => {
  const env = await setup(t);
  const alpha = await env.make('Alpha report');
  const beta = await env.make('Beta notes');
  const gamma = await env.make('Gamma');
  const other = path.join(env.root, 'other');
  await (await import('node:fs/promises')).mkdir(other);
  const elsewhere = await new SessionFiles(env.sessionsDir).create({ cwd: other, title: 'Elsewhere' });
  await env.listed(elsewhere.id);
  const client = await env.client();
  await client.attach(alpha.id);
  await until(() => env.row(alpha.id).runtimeId);

  const all = await env.api.list();
  assert.deepEqual(keys(all), ['sessions', 'truncated']);
  assert.equal(all.truncated, false);
  assert.deepEqual(keys(all.sessions[0]), ['cwd', 'live', 'messageCount', 'sessionId', 'status', 'title', 'updatedAt']);
  assert.equal(all.sessions[0].sessionId, alpha.id, 'the loaded session comes first');
  assert.equal(all.sessions[0].live, true);
  assert.equal(all.sessions.find((item) => item.sessionId === beta.id).live, false);
  assert.equal(all.sessions.find((item) => item.sessionId === beta.id).status, 'stored');

  assert.deepEqual((await env.api.list({ query: 'beta NOTES' })).sessions.map((item) => item.sessionId), [beta.id]);
  assert.deepEqual((await env.api.list({ query: gamma.id.slice(0, 13) })).sessions.map((item) => item.sessionId), [gamma.id]);
  assert.deepEqual((await env.api.list({ cwd: other })).sessions.map((item) => item.sessionId), [elsewhere.id]);
  const limited = await env.api.list({ limit: 2 });
  assert.equal(limited.sessions.length, 2);
  assert.equal(limited.truncated, true);
  assert.equal((await env.api.list({ limit: 500 })).sessions.length, 4, 'limit is capped, not refused');
});

test('read: frozen shape, visible roles only, tool names without tool output, bounded and truncated text', async (t) => {
  const env = await setup(t);
  const session = await writeSession(env.sessionsDir, env.root, [
    { type: 'session_info', name: 'Readable' },
    user('first question'),
    assistant('let me look', { stopReason: 'toolUse', tools: ['read', 'bash'] }),
    toolResult('SECRET TOOL OUTPUT'),
    assistant('x'.repeat(50)),
    { type: 'custom_message', customType: 'rubato-session-message', content: 'model-facing envelope', display: true,
      details: { v: 1, messageId: 'm1', kind: 'message', from: { sessionId: 'a', title: 'A', cwd: '/' }, text: 'hello from A' } },
    { type: 'custom_message', customType: 'rubato-runtime:wake', content: 'wake', display: false },
  ]);
  await env.listed(session.id);
  const result = await env.api.read({ sessionId: session.id, maxCharsPerMessage: 12 });
  assert.deepEqual(keys(result), ['messages', 'session', 'truncated']);
  assert.deepEqual(keys(result.session), ['cwd', 'messageCount', 'model', 'sessionId', 'status', 'title', 'updatedAt']);
  assert.equal(result.session.title, 'Readable');
  assert.equal(result.session.model, 'fixture/local');
  assert.equal(result.session.status, 'stored');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'session-message']);
  assert.deepEqual(keys(result.messages[0]), ['at', 'entryId', 'isFinal', 'role', 'text', 'toolCalls']);
  assert.deepEqual(result.messages[1].toolCalls, ['read', 'bash']);
  assert.equal(result.messages[1].isFinal, false);
  assert.equal(result.messages[2].isFinal, true);
  assert.equal(result.messages[2].text, 'x'.repeat(12) + '…');
  assert.equal(result.messages[3].text, 'hello from A', 'a session message reads as what its sender wrote');
  assert.ok(!JSON.stringify(result).includes('SECRET TOOL OUTPUT'));
  assert.equal(env.host.metrics.runtimeStarts, 0, 'reading never loads the target');

  const recent = await env.api.read({ sessionId: session.id, messages: 2 });
  assert.deepEqual(recent.messages.map((message) => message.entryId), ['e4', 'e5'], 'oldest first, newest kept');
  assert.equal(recent.truncated, true);
  await assert.rejects(env.api.read({ sessionId: 'missing' }), { code: 'unknown_session' });
});

test('send loads a stored target through the router and delivers the frozen data exactly once', async (t) => {
  const env = await setup(t);
  const a = await env.make('Sender A');
  const b = await env.make('Target B');
  assert.equal(env.host.metrics.runtimeStarts, 0);
  const result = await env.api.send({ from: a.id, to: b.id, text: 'please check the build', messageId: 'msg-1' });
  assert.deepEqual(keys(result), ['cursor', 'duplicate', 'messageId', 'state', 'to']);
  assert.deepEqual(keys(result.to), ['sessionId', 'status', 'title']);
  assert.equal(result.messageId, 'msg-1');
  assert.equal(result.to.sessionId, b.id);
  assert.equal(result.to.title, 'Target B');
  assert.equal(env.host.metrics.runtimeStarts, 1, 'only the target was loaded');
  assert.equal(env.host.getSessionWorker(a.id), undefined, 'the sender is not loaded to resolve its name');
  assert.deepEqual(await env.deliveries(b.id), [{ mode: 'turn', data: { v: 1, messageId: 'msg-1', kind: 'message',
    from: { sessionId: a.id, title: 'Sender A', cwd: env.root }, text: 'please check the build' } }]);
  await until(() => env.row(b.id).attachments === 0, 'the delivery attachment was not released');

  const second = await env.api.send({ from: a.id, to: b.id, text: 'another' });
  assert.match(second.messageId, /^[0-9a-f-]{36}$/, 'a message id is generated when omitted');
  assert.notEqual(second.messageId, 'msg-1');
});

test('a running target is steered in its existing runtime, not woken again or loaded twice', async (t) => {
  const env = await setup(t);
  const a = await env.make('A');
  const b = await env.make('B');
  const client = await env.client();
  await client.attach(b.id);
  const before = await client.snapshot();
  await client.command({ type: 'prompt', message: 'background' });
  await until(() => env.row(b.id).status === 'running');
  const result = await env.api.send({ from: a.id, to: b.id, text: 'mid-turn note' });
  assert.equal(result.to.status, 'running');
  const delivered = await env.deliveries(b.id);
  assert.deepEqual(delivered.map((item) => item.mode), ['steer']);
  assert.equal(env.host.metrics.runtimeStarts, 1);
  assert.equal((await client.snapshot()).runtimeId, before.runtimeId);
  await client.command({ type: 'abort' });
});

test('wait: frozen shape, wakes on a completed turn, ignores the same turn after its cursor', async (t) => {
  const env = await setup(t);
  const a = await env.make('A');
  const b = await env.make('B');
  await env.api.send({ from: a.id, to: b.id, text: 'do the thing' });
  const woke = await env.api.wait({ targets: [{ sessionId: b.id }], timeoutMs: 10000 });
  assert.deepEqual(keys(woke), ['polls', 'timedOut', 'wake']);
  assert.equal(woke.timedOut, false);
  assert.deepEqual(keys(woke.wake), ['cursor', 'latestAssistant', 'reason', 'sessionId', 'status']);
  assert.equal(woke.wake.reason, 'completed');
  assert.equal(woke.wake.status, 'idle');
  assert.equal(woke.wake.latestAssistant.text, 'reply: do the thing');
  assert.equal(woke.polls.length, 1);
  assert.equal(woke.polls[0].changed, true);
  assert.equal(woke.polls[0].cursor, woke.wake.cursor);

  const again = await env.api.wait({ targets: [{ sessionId: b.id, afterCursor: woke.wake.cursor }], timeoutMs: 0 });
  assert.deepEqual(again, { timedOut: true, wake: null, polls: [{ sessionId: b.id, cursor: woke.wake.cursor, changed: false, status: 'idle',
    latestAssistant: woke.wake.latestAssistant }] });

  await assert.rejects(env.api.wait({ targets: [] }), { code: 'invalid' });
  await assert.rejects(env.api.wait({ targets: Array.from({ length: 9 }, () => ({ sessionId: b.id })) }), { code: 'invalid' });
  await assert.rejects(env.api.wait({ targets: [{ sessionId: b.id, afterCursor: 'garbage' }], timeoutMs: 0 }), { code: 'invalid' });
});

test('wait: streaming commentary does not wake, a question asked while it waits does, once per question', async (t) => {
  const env = await setup(t);
  const b = await env.make('B');
  const client = await env.client();
  await client.attach(b.id);
  await client.command({ type: 'prompt', message: 'background' });
  await until(() => env.row(b.id).status === 'running');
  const file = (await env.host.resolveSession(b.id)).file;
  const last = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  await appendFile(file, JSON.stringify({ id: 'commentary', parentId: last.id, timestamp: stamp(), ...assistant('still reading files') }) + '\n');
  const quiet = await env.api.wait({ targets: [{ sessionId: b.id }], timeoutMs: 300 });
  assert.equal(quiet.timedOut, true);
  assert.equal(quiet.wake, null);
  assert.equal(quiet.polls[0].status, 'running');
  assert.deepEqual(quiet.polls[0].latestAssistant, { entryId: 'commentary', text: 'still reading files' });
  await client.command({ type: 'abort' });
  await until(() => env.row(b.id).status === 'idle');

  const worker = env.host.getSessionWorker(b.id);
  const listening = worker.listenerCount('event');
  // The commentary above is now this idle target's latest answer; the cursor says it was seen.
  const asking = env.api.wait({ targets: [{ sessionId: b.id, afterCursor: quiet.polls[0].cursor }], timeoutMs: 5000 });
  await until(() => worker.listenerCount('event') > listening, 'the wait never listened to the live worker');
  await client.command({ type: 'prompt', message: 'question' });
  const asked = await asking;
  assert.equal(asked.wake?.reason, 'needs-attention');
  assert.equal(env.row(b.id).status, 'running', 'the directory alone cannot see the question');
  assert.equal(env.row(b.id).attachments, 1, 'only the test client is attached: the waiter never attaches');
  const same = await env.api.wait({ targets: [{ sessionId: b.id, afterCursor: asked.wake.cursor }], timeoutMs: 200 });
  assert.equal(same.timedOut, true, 'the same question does not wake twice');
  assert.equal(worker.listenerCount('event'), listening, 'each wait lets go of the worker');
  await client.reply({ id: 'question-1', value: 'yes' });
});

test('fork copies only completed history next to its source; a running turn and its partial answer stay behind', async (t) => {
  const env = await setup(t);
  const source = await writeSession(env.sessionsDir, env.root, [
    user('first'),
    assistant('first answer'),
    { type: 'session_info', name: 'Source title' },
    user('second, still running'),
    assistant('working on it', { stopReason: 'toolUse', tools: ['bash'] }),
    toolResult('partial output'),
  ]);
  await env.listed(source.id);
  const original = await readFile(source.file, 'utf8');
  const forked = await env.api.fork({ sessionId: source.id });
  assert.deepEqual(keys(forked), ['copiedMessages', 'cwd', 'sessionId', 'title']);
  assert.equal(forked.copiedMessages, 2);
  assert.equal(forked.title, 'Source title');
  assert.equal(forked.cwd, env.root);
  assert.equal(await readFile(source.file, 'utf8'), original, 'the source is never rewritten');
  const name = (await readdir(env.sessionsDir)).find((file) => file.endsWith(`_${forked.sessionId}.jsonl`));
  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/, "Pi's own file naming");
  const [header, ...entries] = (await readFile(path.join(env.sessionsDir, name), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(header.type, 'session');
  assert.equal(header.id, forked.sessionId);
  assert.equal(header.parentSession, source.file);
  assert.deepEqual(entries.map((entry) => entry.id), ['e0', 'e1', 'e2']);
  assert.deepEqual(entries.map((entry) => entry.parentId), [null, 'e0', 'e1']);
  assert.equal(env.host.metrics.runtimeStarts, 0, 'forking without a message loads nothing');
  await until(() => env.row(forked.sessionId), 'the fork is published in the directory');

  const withText = await env.api.fork({ sessionId: source.id, text: 'continue from here' });
  const delivered = await env.deliveries(withText.sessionId);
  assert.deepEqual(delivered.map((item) => [item.mode, item.data.kind, item.data.from.sessionId, item.data.text]),
    [['turn', 'message', source.id, 'continue from here']]);
});

test('create makes a conversation in the folder and delivers its first message as kind create', async (t) => {
  const env = await setup(t);
  const a = await env.make('Maker');
  const created = await env.api.create({ from: a.id, cwd: env.root, title: 'Made for you', text: 'start here' });
  assert.deepEqual(keys(created), ['cwd', 'sessionId', 'status', 'title']);
  assert.equal(created.title, 'Made for you');
  assert.equal(created.cwd, env.root);
  const delivered = await env.deliveries(created.sessionId);
  assert.deepEqual(delivered.map((item) => [item.data.kind, item.data.from.title, item.data.text]), [['create', 'Maker', 'start here']]);
  assert.ok(env.row(created.sessionId), 'published without waiting for a directory poll');
  await assert.rejects(env.api.create({ from: a.id, cwd: env.root, text: 'start here' }), { code: 'duplicate' });
  await assert.rejects(env.api.create({ from: a.id, cwd: 'relative', text: 'x' }), { code: 'invalid' });
});

test('safety: oversized text, self-send, unknown target, duplicate and rate limits are refused before delivery', async (t) => {
  let clock = 1_000_000;
  const env = await setup(t, { now: () => clock });
  const a = await env.make('A');
  const targets = [await env.make('T0'), await env.make('T1'), await env.make('T2'), await env.make('T3')];
  const b = targets[0];
  await assert.rejects(env.api.send({ from: a.id, to: b.id, text: 'x'.repeat(LIMITS.textChars + 1) }), { code: 'too_long' });
  await assert.rejects(env.api.send({ from: a.id, to: b.id, text: '   ' }), { code: 'invalid' });
  await assert.rejects(env.api.send({ from: a.id, to: a.id, text: 'me' }), { code: 'self_send' });
  await assert.rejects(env.api.send({ from: a.id, to: 'no-such-session', text: 'hi' }), { code: 'unknown_session' });
  assert.equal(env.host.metrics.runtimeStarts, 0, 'refusals load nothing');

  await env.api.send({ from: a.id, to: b.id, text: 'x'.repeat(LIMITS.textChars) });
  await env.api.send({ from: a.id, to: b.id, text: 'same' });
  await assert.rejects(env.api.send({ from: a.id, to: b.id, text: 'same' }), { code: 'duplicate' });
  clock += LIMITS.duplicateMs;
  await env.api.send({ from: a.id, to: b.id, text: 'same' });
  for (let i = 3; i < LIMITS.pairPerMinute; i++) await env.api.send({ from: a.id, to: b.id, text: `pair ${i}` });
  await assert.rejects(env.api.send({ from: a.id, to: b.id, text: 'one too many' }), { code: 'rate_limited' });
  assert.equal((await env.deliveries(b.id)).length, LIMITS.pairPerMinute);

  let sent = LIMITS.pairPerMinute;
  for (const target of targets.slice(1)) {
    for (let i = 0; i < LIMITS.pairPerMinute && sent < LIMITS.senderPerMinute; i++, sent++)
      await env.api.send({ from: a.id, to: target.id, text: `spread ${i}` });
  }
  await assert.rejects(env.api.send({ from: a.id, to: targets[3].id, text: 'over the sender limit' }), { code: 'rate_limited' });
  clock += LIMITS.windowMs;
  await env.api.send({ from: a.id, to: b.id, text: 'a minute later' });
});

// ── Review fixes ────────────────────────────────────────────────────────────────

const sessionMessage = (messageId, text, display = true) => ({ type: 'custom_message', customType: 'rubato-session-message',
  content: `envelope for ${text}`, display, details: { v: 1, messageId, kind: 'message', from: { sessionId: 'a', title: 'A', cwd: '/' }, text } });

test('the read-only transcript keeps received session messages in the live shape, and only those custom messages', async (t) => {
  const env = await setup(t);
  const session = await writeSession(env.sessionsDir, env.root, [
    user('hi'),
    sessionMessage('m1', 'hello from A'),
    { type: 'custom_message', customType: 'rubato-runtime:wake', content: 'wake', display: true },
    sessionMessage('m2', 'hidden', false),
    assistant('answer'),
  ]);
  await env.listed(session.id);
  const client = await env.client();
  const { messages } = await client.transcript(session.id);
  assert.deepEqual(messages.map((message) => message.role), ['user', 'custom', 'assistant']);
  const stored = session.entries[1];
  assert.deepEqual(messages[1], { entryId: 'e1', role: 'custom', customType: 'rubato-session-message', content: stored.content,
    display: true, details: stored.details, timestamp: Date.parse(stored.timestamp) });
  assert.equal(env.host.metrics.runtimeStarts, 0, 'reading history loads nothing');
});

test('wait without a cursor wakes at once on a target that already finished', async (t) => {
  const env = await setup(t);
  const stored = await writeSession(env.sessionsDir, env.root, [user('question'), assistant('old answer')]);
  await env.listed(stored.id);
  const began = Date.now();
  const woke = await env.api.wait({ targets: [{ sessionId: stored.id }], timeoutMs: 5000 });
  assert.equal(woke.wake?.reason, 'completed');
  assert.equal(woke.wake.latestAssistant.text, 'old answer');
  assert.ok(Date.now() - began < 2000, 'it did not sit out the timeout');

  // The race itself: the target's whole turn is written before send even returns.
  const a = await env.make('A');
  const b = await env.make('B');
  await env.api.send({ from: a.id, to: b.id, text: 'instant please' });
  await until(() => env.row(b.id).status === 'idle');
  const late = await env.api.wait({ targets: [{ sessionId: b.id }], timeoutMs: 5000 });
  assert.equal(late.wake?.reason, 'completed');
  assert.equal(late.wake.latestAssistant.text, 'reply: instant please');
});

test('send returns the cursor from before delivery, so a reply written before send returns still wakes that wait', async (t) => {
  const env = await setup(t);
  const a = await env.make('A');
  const b = await writeSession(env.sessionsDir, env.root, [user('earlier'), assistant('earlier answer')]);
  await env.listed(b.id);
  const sent = await env.api.send({ from: a.id, to: b.id, text: 'instant reply' });
  assert.equal(typeof sent.cursor, 'string');
  await until(() => env.row(b.id).status === 'idle');
  const woke = await env.api.wait({ targets: [{ sessionId: b.id, afterCursor: sent.cursor }], timeoutMs: 2000 });
  assert.equal(woke.wake?.reason, 'completed', 'the reply counts as news after the send cursor');
  assert.equal(woke.wake.latestAssistant.text, 'reply: instant reply');
});

test('wait without a cursor on a running target still waits for its next answer, not the one before', async (t) => {
  const env = await setup(t);
  const b = await writeSession(env.sessionsDir, env.root, [user('earlier'), assistant('old answer')]);
  await env.listed(b.id);
  const client = await env.client();
  await client.attach(b.id);
  await client.command({ type: 'prompt', message: 'background' });
  await until(() => env.row(b.id).status === 'running');
  const waiting = env.api.wait({ targets: [{ sessionId: b.id }], timeoutMs: 1000 });
  await delay(200);
  await client.command({ type: 'abort' });
  const result = await waiting;
  assert.equal(result.wake, null, 'an aborted turn with no new answer does not replay the old one');
  assert.equal(result.polls[0].status, 'idle');
});

test('the tail read grows past an entry larger than its first read, and says so when even the ceiling holds none', async (t) => {
  const env = await setup(t);
  const huge = (bytes) => ({ type: 'message', message: { role: 'toolResult', toolCallId: 'call-0', toolName: 'read',
    content: [{ type: 'text', text: 'x'.repeat(bytes) }], isError: false, timestamp: Date.now() } });
  const large = await writeSession(env.sessionsDir, env.root, [user('question'), assistant('answer'),
    user('look at this'), assistant('', { stopReason: 'toolUse', tools: ['read'] }), huge(TAIL_BYTES[0] + 44 * 1024)]);
  await env.listed(large.id);
  const read = await env.api.read({ sessionId: large.id });
  assert.deepEqual(read.messages.map((message) => message.text), ['question', 'answer', 'look at this', '']);
  assert.equal(read.session.model, 'fixture/local');
  assert.equal(read.truncated, false);
  const woke = await env.api.wait({ targets: [{ sessionId: large.id }], timeoutMs: 2000 });
  assert.equal(woke.wake?.latestAssistant.text, 'answer', 'wait judges progress through the same read');

  const empty = await env.make('Empty');
  assert.deepEqual(await env.api.read({ sessionId: empty.id }), { session: (await env.api.read({ sessionId: empty.id })).session,
    messages: [], truncated: false });

  const beyond = await writeSession(env.sessionsDir, env.root, [user('question'), huge(TAIL_BYTES.at(-1) + 1024)]);
  await env.listed(beyond.id);
  await assert.rejects(env.api.read({ sessionId: beyond.id }), { code: 'unreadable' });
});

test('a fork refused by the send limits leaves no file behind', async (t) => {
  let clock = 1_000_000;
  const env = await setup(t, { now: () => clock });
  const a = await env.make('A');
  const targets = [await env.make('T0'), await env.make('T1'), await env.make('T2')];
  for (let sent = 0; sent < LIMITS.senderPerMinute; sent++)
    await env.api.send({ from: a.id, to: targets[Math.floor(sent / LIMITS.pairPerMinute)].id, text: `note ${sent}` });
  const source = await writeSession(env.sessionsDir, env.root, [user('first'), assistant('first answer')]);
  await env.listed(source.id);
  const before = (await readdir(env.sessionsDir)).sort();
  await assert.rejects(env.api.fork({ sessionId: source.id, from: a.id, text: 'continue' }), { code: 'rate_limited' });
  assert.deepEqual((await readdir(env.sessionsDir)).sort(), before, 'no forked file was written');
  clock += LIMITS.windowMs;
  const forked = await env.api.fork({ sessionId: source.id, from: a.id, text: 'continue' });
  assert.ok((await readdir(env.sessionsDir)).some((name) => name.endsWith(`_${forked.sessionId}.jsonl`)));
});

test('one conversation receives at most the inbound count and characters per minute, across all senders', async (t) => {
  let clock = 1_000_000;
  const env = await setup(t, { now: () => clock });
  const [a, b, c] = [await env.make('A'), await env.make('B'), await env.make('C')];
  const target = await env.make('Target');
  const full = LIMITS.textChars;
  const whole = Math.floor(LIMITS.inboundCharsPerMinute / full);
  for (let i = 0; i < whole; i++) await env.api.send({ from: a.id, to: target.id, text: `${i}`.padEnd(full, '.') });
  const rest = LIMITS.inboundCharsPerMinute - whole * full;
  await assert.rejects(env.api.send({ from: b.id, to: target.id, text: 'b'.repeat(rest + 1) }), { code: 'rate_limited' });
  await env.api.send({ from: b.id, to: target.id, text: 'b'.repeat(rest) });

  clock += LIMITS.windowMs;
  const senders = [a, b, c];
  for (let i = 0; i < LIMITS.inboundPerMinute; i++)
    await env.api.send({ from: senders[Math.floor(i / LIMITS.pairPerMinute)].id, to: target.id, text: `short ${i}` });
  const quiet = await env.make('D');
  await assert.rejects(env.api.send({ from: quiet.id, to: target.id, text: 'one more' }), { code: 'rate_limited' });
  assert.equal((await env.deliveries(target.id)).length, whole + 1 + LIMITS.inboundPerMinute);
});

test('messageId is trimmed; an explicit id is a retry the handler judges, only an unnamed repeat is refused by text', async (t) => {
  const env = await setup(t);
  const a = await env.make('A');
  const b = await env.make('B');
  await assert.rejects(env.api.send({ from: a.id, to: b.id, text: 'x', messageId: '   ' }), { code: 'invalid' });
  const sent = await env.api.send({ from: a.id, to: b.id, text: 'same words', messageId: '  m-7 ' });
  assert.equal(sent.messageId, 'm-7');
  await env.api.send({ from: a.id, to: b.id, text: 'same words', messageId: 'm-7' });
  assert.deepEqual((await env.deliveries(b.id)).map((item) => item.data.messageId), ['m-7', 'm-7'], 'the retry reached the handler');
  await env.api.send({ from: a.id, to: b.id, text: 'plain words' });
  await assert.rejects(env.api.send({ from: a.id, to: b.id, text: 'plain words' }), { code: 'duplicate' });
});

/** The same engine seen through a directory that still says `running` for `id`. */
function staleHost(host, id, getSessionWorker = (key) => host.getSessionWorker(key)) {
  return Object.create(host, {
    directory: { value: { get value() {
      const value = host.directory.value;
      return { ...value, sessions: value.sessions.map((item) => item.sessionId === id ? { ...item, status: 'running' } : item) };
    } } },
    getSessionWorker: { value: getSessionWorker },
  });
}

test('observing never starts a runtime: not for a stale running row, not when the target unloads mid-wait', async (t) => {
  const env = await setup(t);
  // The directory still says running, but the runtime is already gone.
  const stale = await env.make('Stale');
  const link = createSessionLink({ pollMs: 20 });
  t.after(() => link.close());
  link.bind({ host: staleHost(env.host, stale.id), sessionsDir: env.sessionsDir, socketPath: path.join(env.root, 'pi.sock'), serverId: env.service.serverId });
  assert.equal((await link.wait({ targets: [{ sessionId: stale.id }], timeoutMs: 600 })).timedOut, true);

  // A running target that stops and unloads while it is watched (the review's race). If the
  // wait attaches at all, the target unloads just before that attach lands; if it never does,
  // the target unloads mid-wait anyway. Either way the wait must not bring it back.
  const b = await env.make('B');
  const client = await env.client();
  await client.attach(b.id);
  await client.command({ type: 'prompt', message: 'background' });
  await until(() => env.row(b.id).status === 'running');
  const starts = env.host.metrics.runtimeStarts;
  let unloaded;
  const unload = () => unloaded ??= (async () => {
    await client.command({ type: 'abort' });
    await client.detach();
    await until(() => env.row(b.id).status === 'idle' && env.row(b.id).attachments === 0);
    await client.unload(b.id);
  })();
  const attach = SessionClient.prototype.attach;
  SessionClient.prototype.attach = async function (id) { if (id === b.id) await unload(); return attach.call(this, id); };
  t.after(() => { SessionClient.prototype.attach = attach; });
  const worker = env.host.getSessionWorker(b.id);
  const listening = worker.listenerCount('event');
  const waiting = env.api.wait({ targets: [{ sessionId: b.id }], timeoutMs: 1200 });
  await until(() => Boolean(unloaded) || worker.listenerCount('event') > listening, 'the wait neither listened nor attached');
  await unload();
  await waiting;
  SessionClient.prototype.attach = attach;
  await delay(300);
  assert.equal(env.host.metrics.runtimeStarts - starts, 0, 'observation-only runtime starts');
  assert.equal(env.host.getSessionWorker(b.id), undefined, 'the target stays unloaded');
});

test('a wait ends at its deadline and on its abort', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-link-abort-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await writeSession(root, root, [user('q')]);
  const row = { sessionId: session.id, title: 'Busy', cwd: root, status: 'running', runtimeId: 'r', messageCount: 1 };
  const host = { directory: { value: { sessions: [row] } }, getSessionWorker: () => undefined,
    resolveSession: async () => ({ file: session.file }) };
  const link = createSessionLink({ pollMs: 20 });
  link.bind({ host, sessionsDir: root, socketPath: path.join(root, 'none.sock'), serverId: randomUUID() });
  t.after(() => link.close());
  const within = (promise, ms) => Promise.race([promise, delay(ms).then(() => 'hung')]);
  const timed = await within(link.wait({ targets: [{ sessionId: session.id }], timeoutMs: 200 }), 3000);
  assert.equal(timed.timedOut, true);
  const controller = new AbortController();
  const waiting = link.wait({ targets: [{ sessionId: session.id }], timeoutMs: 120000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.notEqual(await within(waiting, 3000), 'hung', 'the abort ended the wait');
});

test("a created conversation's first message counts against its pair and inbound caps, once against its sender", async (t) => {
  let clock = 1_000_000;
  const env = await setup(t, { now: () => clock });
  const [a, b, c] = [await env.make('A'), await env.make('B'), await env.make('C')];
  const full = LIMITS.textChars;
  // Characters: the first message plus what others send stays under the inbound cap.
  const byChars = await env.api.create({ from: a.id, cwd: env.root, text: 'first'.padEnd(full, '.') });
  const fit = Math.floor(LIMITS.inboundCharsPerMinute / full) - 1;
  for (let i = 0; i < fit; i++) await env.api.send({ from: b.id, to: byChars.sessionId, text: `${i}`.padEnd(full, '.') });
  const room = LIMITS.inboundCharsPerMinute - (fit + 1) * full;
  await assert.rejects(env.api.send({ from: c.id, to: byChars.sessionId, text: 'c'.repeat(room + 1) }), { code: 'rate_limited' });

  // Count, and the creator's pair: the first message is one of its messages to that conversation.
  clock += LIMITS.windowMs;
  const byCount = await env.api.create({ from: a.id, cwd: env.root, text: 'first message' });
  for (let i = 1; i < LIMITS.pairPerMinute; i++) await env.api.send({ from: a.id, to: byCount.sessionId, text: `from creator ${i}` });
  await assert.rejects(env.api.send({ from: a.id, to: byCount.sessionId, text: 'creator over its pair' }), { code: 'rate_limited' });
  const others = [b, c];
  for (let i = LIMITS.pairPerMinute; i < LIMITS.inboundPerMinute; i++)
    await env.api.send({ from: others[Math.floor((i - LIMITS.pairPerMinute) / LIMITS.pairPerMinute)].id, to: byCount.sessionId, text: `other ${i}` });
  const d = await env.make('D');
  await assert.rejects(env.api.send({ from: d.id, to: byCount.sessionId, text: 'one past the inbound count' }), { code: 'rate_limited' });

  // The sender pays for a create once: one create and 19 sends reach its 20.
  clock += LIMITS.windowMs;
  await env.api.create({ from: a.id, cwd: env.root, text: 'counted once' });
  const spread = [b, c, d];
  for (let i = 1; i < LIMITS.senderPerMinute; i++)
    await env.api.send({ from: a.id, to: spread[Math.floor((i - 1) / LIMITS.pairPerMinute)].id, text: `spread ${i}` });
  await assert.rejects(env.api.send({ from: a.id, to: d.id, text: 'over the sender limit' }), { code: 'rate_limited' });
});

test("send reports the target handler's answer, and null where the handler said nothing", async (t) => {
  const env = await setup(t);
  const a = await env.make('A');
  const b = await env.make('B');
  // The fixture's own answer is an older runtime's: no duplicate, no state.
  const older = await env.api.send({ from: a.id, to: b.id, text: 'first', messageId: 'm-1' });
  assert.deepEqual([older.duplicate, older.state], [null, null], 'nothing is invented');
  const script = (answer) => env.host.getSessionWorker(b.id)
    .request({ type: 'extension_request', name: 'fixture.session-link.answer', data: answer });
  await script({ messageId: 'm-1', duplicate: true, state: 'queued' });
  const queued = await env.api.send({ from: a.id, to: b.id, text: 'first', messageId: 'm-1' });
  assert.deepEqual([queued.messageId, queued.duplicate, queued.state], ['m-1', true, 'queued']);
  await script({ messageId: 'm-2', duplicate: false, state: 'written' });
  const written = await env.api.send({ from: a.id, to: b.id, text: 'second', messageId: 'm-2' });
  assert.deepEqual([written.duplicate, written.state], [false, 'written']);
  await script({ messageId: 'm-3', duplicate: false, state: 'delivered-ish' });
  assert.equal((await env.api.send({ from: a.id, to: b.id, text: 'third', messageId: 'm-3' })).state, null, 'an unknown state is not passed on');
});
