import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCompanionHomeFactories } from '../../pi-runtime/features/companion-home/index.mjs';
import { openInbox } from '../inbox.mjs';
import { readRecord } from '../home.mjs';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}

function toolsOf() {
  const tools = new Map();
  const [feature] = createCompanionHomeFactories();
  feature.factory({ registerTool: (tool) => tools.set(tool.name, tool) });
  return tools;
}

test('the companion writes a daily and a diary with its own tools', async (t) => {
  const env = sandbox(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { process.env = before; });
  const tools = toolsOf();
  assert.deepEqual([...tools.keys()].sort(), ['inbox_add', 'inbox_list', 'inbox_update', 'segno_record']);
  await tools.get('segno_record').execute('c1', { kind: 'daily', text: '리드 하나 시작했어. 우용이 말 그대로 옮겼어.' });
  await tools.get('segno_record').execute('c2', { kind: 'diary', heading: '버그 리포트가 들어온 오후', text: '오랜만에 판이 살아 있는 느낌이었어.' });
  const daily = readRecord('daily', { env });
  const diary = readRecord('diary', { env });
  assert.match(daily, /리드 하나 시작했어/);
  assert.match(diary, /## 버그 리포트가 들어온 오후/);
});

test('the companion lists, adds, links and closes inbox items with its tools', async (t) => {
  const env = sandbox(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { process.env = before; });
  const tools = toolsOf();
  const added = await tools.get('inbox_add').execute('c1', { title: '로그인이 안 돼요', body: '로그인 화면에서 멈춥니다.', reporter: 'Gildong' });
  assert.match(added.content[0].text, /Added: S-1 \[open\]/);
  assert.equal(added.details.item.reporter, 'Gildong');

  const listed = await tools.get('inbox_list').execute('c2', {});
  assert.match(listed.content[0].text, /S-1 \[open\] 로그인이 안 돼요/);

  const linked = await tools.get('inbox_update').execute('c3', { id: 'S-1', status: 'in-progress', leadSessionId: 'lead-9', note: '리드에 넘겼어.' });
  assert.match(linked.content[0].text, /in-progress/);
  assert.equal(linked.details.item.leadSessionId, 'lead-9');
  await tools.get('inbox_update').execute('c4', { id: 'S-1', status: 'done' });

  const box = openInbox({ env });
  t.after(() => box.close());
  const closed = box.get('S-1');
  assert.equal(closed.status, 'done');
  assert.deepEqual(closed.notes.map((note) => note.kind), ['created', 'status', 'linked', 'note', 'status']);
  assert.equal(box.counts().open, 0);
});

test('a tool that is handed a bad id says so instead of writing', async (t) => {
  const env = sandbox(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { process.env = before; });
  const tools = toolsOf();
  await assert.rejects(tools.get('inbox_update').execute('c1', { id: 'S-99', status: 'done' }), /no inbox item/);
});
