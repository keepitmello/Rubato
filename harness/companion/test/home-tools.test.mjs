import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPLY_REMINDER, REPLY_REMINDER_TYPE, createCompanionHomeFactories, createReplyWait } from '../../pi-runtime/features/companion-home/index.mjs';
import { openInbox } from '../inbox.mjs';
import { REPLY_TOOL, SAY_TOOL, readRecord, readWakeWish, sentMessages } from '../home.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}

/** The tools as the runtime registers them, and Pi's events and messages around them. */
function toolsOf(options) {
  const tools = new Map();
  const handlers = new Map();
  const sent = [];
  const [feature] = createCompanionHomeFactories(options);
  feature.factory({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler),
    sendMessage: (message, delivery) => sent.push([message, delivery]) });
  tools.emit = (name, event) => handlers.get(name)?.(event);
  tools.sent = sent;
  return tools;
}

test('the companion writes a daily and a diary with its own tools', async (t) => {
  const env = sandbox(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { process.env = before; });
  const tools = toolsOf();
  assert.deepEqual([...tools.keys()].sort(), ['inbox_add', 'inbox_list', 'inbox_update', 'memory_seed', 'reply', 'segno_commit',
    'segno_record', 'segno_search', 'sent_messages', 'user_schedule', 'wake_wish', 'world_fragment']);
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

test('the companion sets its wake wish with its tool, the way Roo runs wake-wish.sh', async (t) => {
  const env = sandbox(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { process.env = before; });
  const tools = toolsOf();
  const start = Date.now();
  const result = await tools.get('wake_wish').execute('w1', { when: '120', reason: '리드 둘 다\n끝날 즈음 본다' });
  const wish = readWakeWish(env);
  assert.equal(wish.reason, '리드 둘 다 끝날 즈음 본다', 'one line');
  assert.ok(wish.wishAt >= start + 120 * 60_000 && wish.wishAt <= Date.now() + 120 * 60_000);
  assert.match(result.content[0].text, /^WAKE_WISH_SET wishAt=\S+$/);
  await assert.rejects(tools.get('wake_wish').execute('w2', { when: 'soon', reason: 'x' }), /minutes, HH:MM or an ISO 8601 time/);
  assert.equal(readWakeWish(env).reason, '리드 둘 다 끝날 즈음 본다', 'a refused wish leaves the earlier one');
});

test('reply records what Segno said, and sent_messages finds it beside what Telegram delivered before; say waits for a voice', async (t) => {
  const env = sandbox(t);
  const before = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { process.env = before; });
  // A line the Telegram messenger wrote while the product ran it still counts.
  const sent = path.join(env.RUBATO_COMPANION_HOME, 'messenger', 'sent.jsonl');
  mkdirSync(path.dirname(sent), { recursive: true });
  appendFileSync(sent, `${JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), chatId: '1', toUser: true, text: '어제 그 버그 고쳤어', via: 'telegram_send' })}\n`);
  const tools = toolsOf();
  assert.equal(tools.has(SAY_TOOL), false, 'no voice is set, so Segno does not see say');
  const reply = tools.get(REPLY_TOOL);
  assert.deepEqual(reply.parameters.required, ['text']);
  assert.doesNotMatch(reply.description, /telegram/i);
  const answer = await reply.execute('c1', { text: '좋은 아침! 오늘 마감 하나 있어.' });
  assert.deepEqual(Object.keys(answer.details).sort(), ['at', 'text', 'toUser', 'via']);
  assert.equal(answer.details.via, REPLY_TOOL);
  const rows = sentMessages({ env });
  assert.deepEqual(rows.map((row) => [row.text, row.via]), [['어제 그 버그 고쳤어', 'telegram_send'], ['좋은 아침! 오늘 마감 하나 있어.', 'reply']]);
  const listed = await tools.get('sent_messages').execute('c2', { keyword: '마감' });
  assert.match(listed.content[0].text, /오늘 마감 하나 있어/);
  await assert.rejects(async () => reply.execute('c3', { text: '  ' }), /needs some text/);
  const voiced = toolsOf({ voice: true });
  const said = await voiced.get(SAY_TOOL).execute('c4', { text: '잘 자' });
  assert.equal(said.details.via, SAY_TOOL);
});

test("Roo's reminder: a turn the user opened that settles without a reply is reminded once, by a hidden turn of its own", () => {
  const tools = toolsOf();
  tools.emit('message_start', { message: { role: 'user', content: '오늘 뭐 있어?' } });
  tools.emit('message_start', { message: { role: 'custom', customType: 'rubato-session-message' } });
  tools.emit('tool_execution_end', { toolName: 'bash', isError: false });
  tools.emit('agent_settled', {});
  assert.deepEqual(tools.sent, [[{ customType: REPLY_REMINDER_TYPE, content: REPLY_REMINDER, display: false }, { deliverAs: 'followUp', triggerTurn: true }]]);
  tools.emit('agent_settled', {});
  assert.equal(tools.sent.length, 1, 'once: the reminder turn that still says nothing ends the wait');

  const wait = createReplyWait();
  wait.message({ role: 'user' }); wait.toolEnd({ toolName: REPLY_TOOL, isError: false });
  assert.equal(wait.settled(), false, 'a reply answered it');
  wait.message({ role: 'user' }); wait.toolEnd({ toolName: REPLY_TOOL, isError: true });
  assert.equal(wait.settled(), true, 'a reply that failed did not');
  wait.toolEnd({ toolName: SAY_TOOL, isError: false });
  assert.equal(wait.settled(), false, 'the reminder turn replied');
  assert.equal(createReplyWait().settled(), false, 'a turn the user did not open waits for nothing');
  wait.message({ role: 'user' }); assert.equal(wait.settled(), true, 'a new message from the user starts a new wait');
  const other = createReplyWait();
  other.message({ role: 'custom', customType: 'rubato-session-message' });
  assert.equal(other.settled(), false, 'a lead\'s message is not the user\'s');
});
