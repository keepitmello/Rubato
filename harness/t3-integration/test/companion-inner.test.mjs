// What a companion did between the bubbles of its room, read from its session file
// (src/companion/inner.mjs, user item f8828a9f).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitResult, createInnerReader, createSessionReader, launchResult, splitSpans, spanSummary, toolSummary } from '../src/companion/inner.mjs';
import { createCompanionService, handleCompanionRequest } from '../src/companion/service.mjs';
import { writeState } from '../../companion/companion.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');

let ids = 0;
const line = (entry) => `${JSON.stringify(entry)}\n`;
function entry(parentId, fields) { return { id: `e${++ids}`, parentId, ...fields }; }
const person = (parentId, text, at) => entry(parentId, { type: 'message', message: { role: 'user', content: text, timestamp: at } });
const said = (parentId, at, parts) => entry(parentId, { type: 'message', message: { role: 'assistant', content: parts, timestamp: at } });
const result = (parentId, at, toolCallId, text, isError = false) =>
  entry(parentId, { type: 'message', message: { role: 'toolResult', toolCallId, content: [{ type: 'text', text }], isError, timestamp: at } });
const wake = (parentId, at, what, text) => entry(parentId, { type: 'custom_message', customType: 'rubato-session-message',
  content: `<rubato_wake what="${what}">${text}</rubato_wake>`, details: { kind: 'wake', what, text }, timestamp: new Date(at).toISOString() });

function sessionDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-inner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'agent', 'sessions'), { recursive: true });
  return dir;
}

test('a turn reads as its thinking, its words to itself and its tools with their results; the person\'s words are bubbles', async (t) => {
  const dir = sessionDir(t);
  const file = path.join(dir, 'agent', 'sessions', '2026-10-31T00-00-00-000Z_S1.jsonl');
  const a = person(null, '면접 질문 보여줘', 1000);
  const b = said(a.id, 2000, [{ type: 'thinking', thinking: '어제 정리했지.' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'notes/q.md' } }]);
  const c = result(b.id, 2500, 'c1', '1. 자기소개');
  const d = said(c.id, 3000, [{ type: 'text', text: '순서만 바꿔서 보여주자.' }, { type: 'toolCall', id: 'c2', name: 'reply', arguments: { text: '응, 7개야' } }]);
  const e = result(d.id, 3100, 'c2', 'sent');
  writeFileSync(file, [a, b, c, d, e].map(line).join(''));
  const items = await createSessionReader(file).items();
  assert.deepEqual(items.map((item) => item.kind), ['thinking', 'tool', 'text', 'tool']);
  assert.deepEqual(items[1], { kind: 'tool', id: 'c1', name: 'read', summary: 'notes/q.md', input: '{\n  "path": "notes/q.md"\n}', at: 2000,
    output: '1. 자기소개', done: 2500 });
  assert.equal(items[3].summary, '응, 7개야');
});

test('only the branch that ends at the file\'s last entry counts: a rewind leaves its old branch behind', async (t) => {
  const dir = sessionDir(t);
  const file = path.join(dir, 'agent', 'sessions', 'x_S1.jsonl');
  const a = person(null, 'first', 1000);
  const b = said(a.id, 1100, [{ type: 'thinking', thinking: 'kept' }]);
  const dropped = person(b.id, 'dropped', 2000);
  const gone = said(dropped.id, 2100, [{ type: 'thinking', thinking: 'gone' }]);
  const mark = entry(b.id, { type: 'custom', customType: 'rubato.rewind', data: {}, timestamp: new Date(2200).toISOString() });
  const after = said(mark.id, 2300, [{ type: 'thinking', thinking: 'after the rewind' }]);
  writeFileSync(file, [a, b, dropped, gone, mark, after].map(line).join(''));
  const items = await createSessionReader(file).items();
  assert.deepEqual(items.map((item) => item.text), ['kept', 'after the rewind']);
});

test('the file is read as it grows, a line cut mid-character included', async (t) => {
  const dir = sessionDir(t);
  const file = path.join(dir, 'agent', 'sessions', 'x_S1.jsonl');
  const a = said(null, 1000, [{ type: 'thinking', thinking: '하나' }]);
  const b = said(a.id, 2000, [{ type: 'thinking', thinking: '둘' }]);
  writeFileSync(file, line(a));
  const reader = createSessionReader(file);
  assert.equal((await reader.items()).length, 1);
  const bytes = Buffer.from(line(b));
  const cut = bytes.indexOf(Buffer.from('둘')) + 1; // inside the character
  appendFileSync(file, bytes.subarray(0, cut));
  assert.deepEqual((await reader.items()).map((item) => item.text), ['하나'], 'a line still being written waits');
  appendFileSync(file, bytes.subarray(cut));
  assert.deepEqual((await reader.items()).map((item) => item.text), ['하나', '둘']);
});

test('spans split at the bubble times: a reply\'s own call lands before its bubble, and one span runs on after the last', () => {
  const items = [{ kind: 'wake', at: 5 }, { kind: 'thinking', at: 12 }, { kind: 'tool', at: 20, done: 26 }, { kind: 'text', at: 31 }];
  const spans = splitSpans(items, [10, 20, 30]);
  assert.deepEqual(spans.map((span) => span.map((item) => item.at)), [[5], [12, 20], [], [31]]);
  assert.deepEqual(splitSpans(items, [10, 20], 10).map((span) => span.length), [0, 2, 1], 'nothing before `after`');
  assert.deepEqual(spanSummary(spans[1]), { thinking: 1, text: 0, tools: 1, wakes: 0, wakeKinds: {}, messages: 0, from: 12, to: 26, launches: [], commits: [] });
  assert.deepEqual(spanSummary([]), { thinking: 0, text: 0, tools: 0, wakes: 0, wakeKinds: {}, messages: 0, from: null, to: null, launches: [], commits: [] });
});

test('a span names the conversations the companion started or forked and the records it committed', async (t) => {
  const dir = sessionDir(t);
  const file = path.join(dir, 'agent', 'sessions', 'x_S1.jsonl');
  const json = (value) => JSON.stringify(value, null, 2);
  const a = person(null, '리드 하나 띄워줘', 1000);
  const b = said(a.id, 2000, [{ type: 'toolCall', id: 'k1', name: 'session_create',
    arguments: { cwd: '/w', title: '원화 출금 설계', model: 'anthropic/claude-opus-5-5-sub', text: 'x'.repeat(2000) } }]);
  const c = result(b.id, 2100, 'k1', `Created "원화 출금 설계" (S2) in /w; it is running.\n${json({ sessionId: 'S2', title: '원화 출금 설계', cwd: '/w', status: 'running', model: 'anthropic/claude-opus-5-5-sub' })}`);
  const d = said(c.id, 2200, [{ type: 'toolCall', id: 'k2', name: 'session_fork', arguments: {} }]);
  const e = result(d.id, 2300, 'k2', `Forked into "Fork of it" (S3) with 4 messages.\n${json({ sessionId: 'S3', title: 'Fork of it', cwd: '/w', copiedMessages: 4 })}`);
  const f = said(e.id, 2400, [{ type: 'toolCall', id: 'k3', name: 'session_create', arguments: { text: 'y' } }]);
  const g = result(f.id, 2500, 'k3', 'Could not create a conversation in /nope', true);
  const h = said(g.id, 2600, [{ type: 'toolCall', id: 'k4', name: 'segno_commit', arguments: { paths: ['memory/status.md'], message: '카줌 셀러 컨택은 수찬 전화 먼저' } }]);
  const i = result(h.id, 2700, 'k4', 'Committed 5f8e228: memory/status.md');
  const j = said(i.id, 2800, [{ type: 'toolCall', id: 'k5', name: 'segno_commit', arguments: { paths: ['memory/us.md'], message: 'nothing' } }]);
  const k = result(j.id, 2900, 'k5', 'Nothing changed; nothing committed.');
  writeFileSync(file, [a, b, c, d, e, f, g, h, i, j, k].map(line).join(''));
  const items = await createSessionReader(file).items();
  const summary = spanSummary(items);
  assert.deepEqual(summary.launches, [
    { id: 'k1', tool: 'create', title: '원화 출금 설계', model: 'anthropic/claude-opus-5-5-sub', sessionId: 'S2', at: 2000, done: 2100, error: null },
    { id: 'k2', tool: 'fork', title: 'Fork of it', model: null, sessionId: 'S3', at: 2200, done: 2300, error: null },
    { id: 'k3', tool: 'create', title: null, model: null, sessionId: null, at: 2400, done: 2500, error: 'Could not create a conversation in /nope' },
  ]);
  assert.deepEqual(summary.commits, [{ id: 'k4', message: '카줌 셀러 컨택은 수찬 전화 먼저', files: ['memory/status.md'], sha: '5f8e228', at: 2700 }],
    'a commit that changed nothing leaves no line');
  assert.equal(items[0].launch.sessionId, 'S2');
  assert.equal(Object.keys(items[0]).includes('launch'), false, 'the opened span\'s pieces stay as they were');
});

test('a launch result names its conversation even when the JSON is cut short', () => {
  assert.deepEqual(launchResult('Created "a (b)" (S9) in /w; it is running.\n{"sessionId": "S9", "ti'), { sessionId: 'S9', title: 'a (b)', model: null });
  assert.equal(launchResult('something else'), null);
  assert.equal(commitResult('Nothing changed; nothing committed.'), null);
});

test('a tool row names what the call was about', () => {
  assert.equal(toolSummary('bash', { command: 'git status\n  --short' }), 'git status --short');
  assert.equal(toolSummary('wake_wish', { when: '08:30', reason: '안부' }), '08:30');
  assert.equal(toolSummary('x', {}), '');
});

test('the room asks the companion service for span summaries and one span\'s pieces', async (t) => {
  const dir = sessionDir(t);
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'home'), RUBATO_PI_CODING_AGENT_DIR: path.join(dir, 'agent') };
  const file = path.join(dir, 'agent', 'sessions', '2026-10-31T00-00-00-000Z_S9.jsonl');
  const a = wake(null, 500, 'heartbeat', 'HEARTBEAT tick=1');
  const b = said(a.id, 600, [{ type: 'thinking', thinking: '조용하네' }]);
  const c = person(b.id, 'hi', 1000);
  const d = said(c.id, 1200, [{ type: 'toolCall', id: 'r', name: 'reply', arguments: { text: 'hey' } }]);
  writeFileSync(file, [a, b, c, d].map(line).join(''));
  const service = createCompanionService({ env, defaultsDir, inner: createInnerReader({ env }) });
  const post = async (action, body) => (await handleCompanionRequest(service,
    new Request(`http://local/rubato/companion/${action}`, { method: 'POST', body: JSON.stringify(body) }))).json();
  assert.deepEqual(await post('inner', { boundaries: [1000] }), { spans: [null, null] }, 'no conversation yet');
  writeState({ sessionId: 'S9' }, env);
  const { spans } = await post('inner', { boundaries: [1000, 1300] });
  assert.deepEqual(spans.map((span) => span && [span.wakes, span.thinking, span.tools]), [[1, 1, 0], [0, 0, 1], [0, 0, 0]]);
  assert.deepEqual(spans[0].wakeKinds, { heartbeat: 1 }, 'the line names what woke it');
  const { items } = await post('inner-items', { after: 1000, until: 1300 });
  assert.deepEqual(items.map((item) => item.name), ['reply']);
  assert.deepEqual((await post('inner-items', { until: 1000 })).items.map((item) => item.kind), ['wake', 'thinking']);
  assert.equal((await post('inner', {})).error.code, 'invalid');
});
