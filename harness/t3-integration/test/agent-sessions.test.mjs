import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { briefOf, readChildTranscript, taskStateDir, transcriptItems } from '../src/agents/transcript.mjs';
import { createAgentsService, handleAgentsRequest } from '../src/agents/service.mjs';

const line = (value) => JSON.stringify(value);
const at = '2026-10-02T06:25:49.157Z';
// The shapes a child's session file holds (checked against real children's files).
const SESSION = [
  line({ type: 'session', version: 3, id: 's', timestamp: at, cwd: '/p' }),
  line({ type: 'model_change', id: 'm', provider: 'openai-codex', modelId: 'gpt-6-astra' }),
  line({ type: 'custom', customType: 'rubato.role-prompt', data: {} }),
  line({ type: 'message', timestamp: at, message: { role: 'system', content: 'You are a teammate' } }),
  line({ type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'Review Q1-Q5' }] } }),
  line({ type: 'message', timestamp: at, message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Start with the form' },
    { type: 'text', text: 'Reading the draft.' },
    { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'draft.md' } },
  ] } }),
  line({ type: 'message', timestamp: at, message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', isError: false, content: [{ type: 'text', text: '# Draft' }] } }),
  line({ type: 'custom_message', customType: 'senpi-task.usage', display: false, content: 'bookkeeping' }),
  line({ type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'false' } }] } }),
  line({ type: 'message', timestamp: at, message: { role: 'toolResult', toolCallId: 'call_2', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'exit 1' }] } }),
  line({ type: 'compaction', timestamp: at, summary: 'Earlier: read the draft' }),
  line({ type: 'message', timestamp: at, message: { role: 'user', content: [{ type: 'text', text: 'Skip Q3' }] } }),
  line({ type: 'message', timestamp: at, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_3', name: 'read', arguments: { path: 'q4.md' } }] } }),
  '{not json',
].join('\n');

test('a child conversation keeps what was said, thought and run, and drops the bookkeeping', () => {
  const items = transcriptItems(SESSION);
  assert.deepEqual(items.map((item) => item.kind),
    ['user', 'thinking', 'assistant', 'tool', 'tool', 'compaction', 'user', 'tool']);
  assert.equal(items[0].text, 'Review Q1-Q5');
  assert.deepEqual({ ...items[3], at: undefined },
    { kind: 'tool', id: 'call_1', name: 'read', input: '{\n  "path": "draft.md"\n}', output: '# Draft', at: undefined });
  assert.equal(items[4].isError, true);
  assert.equal(items[4].output, 'exit 1');
  assert.equal(items[6].text, 'Skip Q3');
  assert.equal(items[7].output, undefined, 'a call still running has no output yet');
});

test("the brief is shown without the runner's envelope", () => {
  const envelope = 'You are running as a Rubato task child "reviewer".\nTask id: st_a.\nParent session: p.\nRoot session: p.\nDepth: 1.';
  assert.equal(briefOf(`${envelope}\n\nInstructions:\nBe strict.\n\nTask:\nReview Q1-Q5\n\nTask:\nnot a heading`), 'Review Q1-Q5\n\nTask:\nnot a heading');
  assert.equal(briefOf(`${envelope}\n\nTask:\nReview Q1-Q5`), 'Review Q1-Q5');
  assert.equal(briefOf('Task:\nfrom the lead, no envelope'), 'Task:\nfrom the lead, no envelope');
});

test('a huge tool output is cut, not sent whole', () => {
  const big = 'x'.repeat(10_000);
  const [tool] = transcriptItems([
    line({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }] } }),
    line({ type: 'message', message: { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: big }] } }),
  ].join('\n'));
  assert.ok(tool.output.length < 4_100);
  assert.match(tool.output, /more characters\)$/);
});

test('the state dir follows the task package: configured, then .rubato/task, then the legacy senpi-task', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  await mkdir(path.join(cwd, '.rubato', 'senpi-task'), { recursive: true });
  assert.equal(await taskStateDir(cwd, { home }), path.join(cwd, '.rubato', 'senpi-task'));
  await mkdir(path.join(cwd, '.rubato', 'task'), { recursive: true });
  assert.equal(await taskStateDir(cwd, { home }), path.join(cwd, '.rubato', 'task'));
  await mkdir(path.join(home, '.rubato'), { recursive: true });
  await writeFile(path.join(home, '.rubato', 'rubato.jsonc'), '{ // user\n "task": { "state_dir": "~/state" } }');
  assert.equal(await taskStateDir(cwd, { home }), path.join(home, 'state'));
  await writeFile(path.join(cwd, '.rubato', 'rubato.jsonc'), '{ "task": { "state_dir": "tasks" } }');
  assert.equal(await taskStateDir(cwd, { home }), path.join(cwd, 'tasks'));
});

test('a transcript is read from the child dir and not sent again while unchanged', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.rubato', 'senpi-task', 'children', 'st_a', 'sessions', 'st_a');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '2026-10-02T06-25-49-157Z_s.jsonl'), SESSION);
  const home = path.join(root, 'home');
  const first = await readChildTranscript({ cwd: root, taskId: 'st_a', home });
  assert.equal(first.found, true);
  assert.equal(first.items.length, 8);
  const again = await readChildTranscript({ cwd: root, taskId: 'st_a', version: first.version, home });
  assert.deepEqual(again, { found: true, version: first.version, unchanged: true });
  assert.deepEqual(await readChildTranscript({ cwd: root, taskId: 'st_missing', home }), { found: false, version: '', items: [] });
  await assert.rejects(readChildTranscript({ cwd: root, taskId: '../../etc', home }), /Unknown agent id/);
  await assert.rejects(readChildTranscript({ cwd: 'relative', taskId: 'st_a', home }), /absolute/);
});

function request(action, body) {
  return new Request(`http://t3/rubato/agents/${action}`, { method: 'POST', body: JSON.stringify(body) });
}

test('stop and send go to the thread session; a refusal comes back with its reason', async () => {
  const calls = [];
  const bridge = {
    controlsAgents: (threadId) => threadId === 'thread-1',
    async controlAgent(threadId, taskId, action, message) {
      calls.push({ threadId, taskId, action, message });
      return taskId === 'st_gone' ? { kind: 'not_found', reason: 'Task not found.' } : { kind: action === 'stop' ? 'cancelled' : 'steered' };
    },
  };
  const service = createAgentsService({ bridge: () => bridge, read: async () => ({ found: true, version: 'v', items: [] }) });
  const json = async (action, body) => {
    const response = await handleAgentsRequest(service, request(action, body));
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await json('stop', { threadId: 'thread-1', taskId: 'st_a' }), { status: 200, body: { outcome: 'cancelled' } });
  assert.deepEqual(await json('send', { threadId: 'thread-1', taskId: 'st_a', message: '  Skip Q3 ' }), { status: 200, body: { outcome: 'steered' } });
  assert.deepEqual(calls, [
    { threadId: 'thread-1', taskId: 'st_a', action: 'stop', message: undefined },
    { threadId: 'thread-1', taskId: 'st_a', action: 'send', message: 'Skip Q3' },
  ]);
  assert.equal((await json('send', { threadId: 'thread-1', taskId: 'st_a', message: ' ' })).status, 400);
  assert.deepEqual(await json('stop', { threadId: 'thread-1', taskId: 'st_gone' }),
    { status: 409, body: { error: { code: 'not_found', message: 'Task not found.' } } });
  assert.equal((await json('stop', { threadId: 'thread-1', taskId: '../x' })).status, 400);
  assert.equal((await json('transcript', { threadId: 'thread-1', cwd: '/p', taskId: 'st_a' })).body.controllable, true);
  assert.equal((await json('transcript', { threadId: 'thread-2', cwd: '/p', taskId: 'st_a' })).body.controllable, false);
  assert.equal((await handleAgentsRequest(service, new Request('http://t3/rubato/agents/stop'))).status, 405);
});

test('without the provider running, controls say so and reading still works', async () => {
  const service = createAgentsService({ bridge: () => undefined, read: async () => ({ found: true, version: 'v', items: [] }) });
  const stop = await handleAgentsRequest(service, request('stop', { threadId: 't', taskId: 'st_a' }));
  assert.equal(stop.status, 503);
  const read = await handleAgentsRequest(service, request('transcript', { threadId: 't', cwd: '/p', taskId: 'st_a' }));
  assert.deepEqual(await read.json(), { found: true, version: 'v', items: [], controllable: false });
});
