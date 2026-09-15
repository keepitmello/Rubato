import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { transformMessages } from '../node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js';
import { serveProfile } from '../src/profile-server.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { SessionClient } from '../src/client.mjs';

const hang = fileURLToPath(new URL('./fixtures/hang-tool.mjs', import.meta.url));
const rpc = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const until = async (predicate, label) => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await delay(10); }
  throw new Error('timeout: ' + label);
};

test('killing a worker mid-tool-call leaves a resumable session, not a corrupted one', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-mid-tool-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const first = await serveProfile({
    agentDir: root, idleMs: 60000,
    workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: hang, timeoutMs: 8000 }),
  });
  t.after(() => first.close());
  const client = await new SessionClient(first.descriptor).connect();
  t.after(() => client.close());
  const created = await client.create({ cwd: root, title: 'Mid-tool' });
  await client.attach(created.sessionId);
  const events = [];
  const unsubscribe = await client.subscribeSession((state) => events.push(state));
  await client.command({ type: 'prompt', message: 'please hang' });
  await until(() => events.some((state) => (state.events ?? []).some((record) => record.event?.type === 'tool_execution_start')), 'tool start');
  const snapshot = await client.snapshot();
  assert.equal(snapshot.state.isStreaming, true);
  assert.ok(snapshot.messages.some((message) => message.role === 'assistant'
    && (message.content ?? []).some((block) => block.type === 'toolCall' && block.id === 'call_hang')));
  const sessionFile = snapshot.state.sessionFile;
  await unsubscribe();
  await client.close();
  await first.close();

  const raw = await readFile(sessionFile, 'utf8');
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.some((entry) => entry.parseError), false);
  const persisted = lines.filter((entry) => entry.type === 'message').map((entry) => entry.message);
  assert.deepEqual(persisted.map((message) => message.role), ['user', 'assistant']);
  assert.equal(persisted[1].stopReason, 'toolUse');
  assert.equal(persisted.some((message) => message.role === 'toolResult'), false);

  const reopened = SessionManager.open(sessionFile);
  const loaded = reopened.getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.message);
  const toolCalls = loaded.flatMap((message) => message.role === 'assistant'
    ? (message.content ?? []).filter((block) => block.type === 'toolCall') : []);
  const toolResults = loaded.filter((message) => message.role === 'toolResult');
  assert.deepEqual(toolCalls.map((block) => block.id), ['call_hang']);
  assert.deepEqual(toolResults, []);

  const transformed = transformMessages(loaded, { provider: 'openai', api: 'openai-completions', id: 'local', input: ['text'] }, (id) => id);
  const synthetic = transformed.filter((message) => message.role === 'toolResult' && message.toolCallId === 'call_hang');
  assert.equal(synthetic.length, 1);
  assert.equal(synthetic[0].isError, true);
  assert.equal(synthetic[0].content[0].text, 'No result provided');
  const unpaired = toolCalls.filter((block) => !transformed.some((message) => message.role === 'toolResult' && message.toolCallId === block.id));
  assert.deepEqual(unpaired, []);

  const second = await serveProfile({
    agentDir: root, idleMs: 60000,
    workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: rpc }),
  });
  t.after(() => second.close());
  assert.equal(second.serverId, first.serverId);
  const resumed = await new SessionClient(second.descriptor).connect();
  t.after(() => resumed.close());
  await resumed.attach(created.sessionId);
  const restored = await resumed.snapshot();
  assert.notEqual(restored.runtimeId, snapshot.runtimeId);
  assert.equal(restored.messages.some((message) => (message.content ?? []).some?.((block) => block.id === 'call_hang')), true);
  await resumed.command({ type: 'prompt', message: 'continue after kill' });
  const continued = await resumed.snapshot();
  assert.ok(continued.messages.some((message) => message.role === 'user' && message.content === 'continue after kill'));
});
