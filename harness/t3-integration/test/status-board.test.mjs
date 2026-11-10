import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BOARD_LIMITS, lifecycleOf, readStatusBoard, sayLine, transcriptFacts } from '../src/status-board/scan.mjs';
import { createStatusBoardService } from '../src/status-board/service.mjs';

const NOW = Date.parse('2026-11-10T07:00:00.000Z');
const LEAD = '01a1b592-b752-708d-b41e-9347589cdfbb';
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const assistant = (offsetMs, content, stopReason) => line({ type: 'message', timestamp: iso(offsetMs),
  message: { role: 'assistant', model: 'claude-opus-5-5', provider: 'anthropic', stopReason, content } });
const said = (text) => ({ type: 'text', text });
const call = (name, args) => ({ type: 'toolCall', id: `c_${name}`, name, arguments: args });
const result = (offsetMs) => line({ type: 'message', timestamp: iso(offsetMs), message: { role: 'toolResult', toolCallId: 'c', content: [said('ok')] } });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-status-board-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const state = path.join(cwd, '.rubato', 'task');
  const agentDir = path.join(root, 'agent');
  const run = path.join(state, 'teams', 'runtime', 'run-1');
  await mkdir(path.join(run, 'tasks'), { recursive: true });
  await mkdir(path.join(state, 'tasks'), { recursive: true });
  await mkdir(path.join(state, 'logs'), { recursive: true });
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  const record = async (taskId, fields) => writeFile(path.join(state, 'tasks', `${taskId}.json`), JSON.stringify({
    task_id: taskId, residency_state: 'resident', parent_session_id: LEAD, created_at: iso(-600_000), updated_at: iso(-600_000),
    execution_mode: 'process', pid: 100, host_pid: 1, model: 'anthropic/claude-opus-5-5', ...fields }));
  const transcript = async (taskId, text, mtimeOffset, session = `0000000${taskId.slice(-1)}-0000-0000-0000-000000000000`) => {
    const dir = path.join(state, 'children', taskId, 'sessions', taskId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `2026-11-10T06-00-00-000Z_${session}.jsonl`);
    await writeFile(file, line({ type: 'session', id: session }) + text);
    const at = new Date(NOW + mtimeOffset);
    await utimes(file, at, at);
    return file;
  };
  return { root, cwd, state, agentDir, run, record, transcript };
}

test('transcript facts: an open turn, the narration line and steps', () => {
  const open = transcriptFacts(assistant(-9_000, [said('## Building the admin page\n\nmore')], 'stop')
    + assistant(-5_000, [said('Running the tests now.'), call('bash', { command: 'npm test\nsecond line' })], 'toolUse'), { cwd: '/w' });
  assert.equal(open.turnOpen, true);
  assert.equal(open.pendingTool, 'bash');
  assert.equal(open.narration.text, 'Running the tests now.');
  assert.deepEqual(open.steps.map((step) => [step.kind, step.text]),
    [['say', 'Building the admin page'], ['say', 'Running the tests now.'], ['tool', 'bash npm test']]);
  assert.equal(open.model, 'anthropic/claude-opus-5-5');
  // A tool result the model has not answered is still its turn; its final answer closes it.
  assert.equal(transcriptFacts(assistant(-5_000, [call('read', { path: '/w/a.ts' })], 'toolUse') + result(-4_000)).turnOpen, true);
  assert.equal(transcriptFacts(assistant(-5_000, [said('Done.')], 'stop')).turnOpen, false);
  assert.equal(sayLine('| a | b |\n|---|---|\n**Bold** words'), '| a | b |');
  assert.equal(sayLine('\n- **Upload**: works'), 'Upload: works');
});

test('lifecycle: a record that still says running reads as lost once its process is gone or it was evicted', () => {
  assert.equal(lifecycleOf({ status: 'running', residency_state: 'resident' }, { alive: true }), 'live');
  assert.equal(lifecycleOf({ status: 'running', residency_state: 'resident' }, { alive: false }), 'lost');
  assert.equal(lifecycleOf({ status: 'running', residency_state: 'evicted' }, { alive: true }), 'lost');
  assert.equal(lifecycleOf({ status: 'completed', residency_state: 'resident' }, { alive: true }), 'live');
  assert.equal(lifecycleOf({ status: 'completed', residency_state: 'disposed' }, { alive: false }), 'ended');
  assert.equal(lifecycleOf({ status: 'error', residency_state: 'disposed' }), 'failed');
  assert.equal(lifecycleOf(undefined), 'lost');
});

test('a team: each member alive or not, last activity from its transcript, its board and one log', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.run, 'state.json'), JSON.stringify({ teamRunId: 'run-1', teamName: 'imgbox', status: 'active',
    createdAt: NOW - 3_600_000, leadSessionId: LEAD, members: [
      { name: 'builder2', kind: 'owner', status: 'running' },
      { name: 'checker2', kind: 'verifier', status: 'running', model: { providerID: 'openai-codex', modelID: 'gpt-6.1-sol' } },
      { name: 'dead', kind: 'owner', status: 'running' },
      { name: 'evicted', kind: 'verifier', status: 'running' },
      { name: 'gone', kind: 'owner', status: 'running' },
      { name: 'builder', kind: 'owner', status: 'shutdown_approved' },
    ] }));
  await writeFile(path.join(f.run, 'task-members.json'), JSON.stringify({ builder2: 'st_1', checker2: 'st_2', dead: 'st_3',
    evicted: 'st_4', gone: 'st_5', builder: 'st_6' }));
  await writeFile(path.join(f.run, 'tasks', '1.json'), JSON.stringify({ id: '1', subject: 'build it', status: 'in_progress', owner: 'builder2', updatedAt: NOW }));
  await writeFile(path.join(f.run, 'tasks', '2.json'), JSON.stringify({ id: '2', subject: 'gone', status: 'deleted' }));
  await f.record('st_1', { status: 'running', name: 'team:run-1:builder2', pid: 101 });
  await f.record('st_2', { status: 'completed', name: 'team:run-1:checker2', pid: 102,
    resolved_model: { display: 'openai-codex/gpt-6.1-sol', reasoning: 'medium' } });
  await f.record('st_3', { status: 'running', name: 'team:run-1:dead', pid: 103 });
  await f.record('st_4', { status: 'running', residency_state: 'evicted', name: 'team:run-1:evicted', pid: 101 });
  await f.transcript('st_1', assistant(-30_000, [said('Wiring the upload route.')], 'stop')
    + assistant(-12_000, [said('Running the tests now.'), call('bash', { command: 'npm test' })], 'toolUse'), -12_000);
  await f.transcript('st_2', assistant(-200_000, [said('Waiting for builder2.')], 'stop'), -200_000);
  await f.transcript('st_3', assistant(-20_000, [call('bash', { command: 'sleep 999' })], 'toolUse'), -20_000);
  await writeFile(path.join(f.state, 'logs', 'st_1.jsonl'), [
    line({ type: 'transition_applied', payload: {} }), line({ type: 'assistant_message', payload: { text: 'x' } }),
    line({ type: 'tool_execution', payload: { tool: 'bash' } }), line({ type: 'tool_execution', payload: { tool: 'read' } })].join(''));
  const leadFile = path.join(f.agentDir, 'sessions', `2026-11-07T10-34-13-714Z_${LEAD}.jsonl`);
  await writeFile(leadFile, line({ type: 'session', id: LEAD }) + assistant(-60_000, [said('Team started.')], 'stop'));

  const alive = (pid) => pid === 101 || pid === 102;
  const board = await readStatusBoard({ cwds: [f.cwd, f.cwd, 'relative/ignored'], now: NOW, agentDir: f.agentDir, alive });
  assert.equal(board.groups.length, 1);
  const [team] = board.groups;
  assert.equal(team.name, 'imgbox');
  const byName = Object.fromEntries(team.members.map((member) => [member.name, member]));
  assert.deepEqual(Object.fromEntries(team.members.map((member) => [member.name, member.lifecycle])),
    { builder2: 'live', checker2: 'live', dead: 'lost', evicted: 'lost', gone: 'lost', builder: 'stopped' });
  assert.equal(byName.builder2.turnOpen, true);
  assert.equal(byName.builder2.pendingTool, 'bash');
  assert.equal(byName.builder2.lastActivityAt, NOW - 12_000);
  assert.equal(byName.builder2.narration, 'Running the tests now.');
  assert.equal(byName.builder2.toolCalls, 2);
  assert.equal(byName.builder2.messages, 1);
  assert.equal(byName.checker2.turnOpen, false);
  assert.equal(byName.checker2.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(byName.checker2.role, 'verifier');
  assert.equal(team.lead.model, 'anthropic/claude-opus-5-5');
  assert.equal(team.lead.narration, 'Team started.');
  assert.deepEqual(team.board.map((item) => [item.id, item.status, item.owner]), [['1', 'in_progress', 'builder2']]);
  assert.deepEqual(team.log.map((entry) => `${entry.who}: ${entry.text}`), [
    'checker2: Waiting for builder2.', 'lead: Team started.', 'builder2: Wiring the upload route.', 'builder2: Running the tests now.']);
  assert.ok(!('says' in byName.builder2), 'the answer carries steps and the log, not every line twice');
  // Each card says where its conversation is: the lead's own thread, a member in the lead's Agents panel.
  assert.deepEqual(team.lead.open, { hostSessionId: LEAD, agentId: null, history: true });
  assert.deepEqual(byName.builder2.open, { hostSessionId: LEAD, agentId: 'st_1', history: true });
  assert.deepEqual(byName.gone.open, { hostSessionId: LEAD, agentId: 'st_5', history: false }, 'no transcript: nothing to show');
});

test('a long board counts every item: an open one past the display limit is kept and counted', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.run, 'state.json'), JSON.stringify({ teamRunId: 'run-1', teamName: 'long', status: 'active',
    createdAt: NOW - 3 * 86_400_000, leadSessionId: LEAD, members: [] }));
  await writeFile(path.join(f.run, 'task-members.json'), '{}');
  await writeFile(path.join(f.run, 'tasks', '1.json'), JSON.stringify({ id: '1', subject: 'open one', status: 'in_progress', updatedAt: NOW - 60_000 }));
  for (let id = 2; id <= BOARD_LIMITS.boardItems + 1; id += 1)
    await writeFile(path.join(f.run, 'tasks', `${id}.json`), JSON.stringify({ id: String(id), subject: `done ${id}`, status: 'completed', updatedAt: NOW - 2 * 86_400_000 }));
  const [team] = (await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true })).groups;
  assert.equal(team.board.length, BOARD_LIMITS.boardItems);
  assert.equal(team.board[0].id, '1', 'the open item stays in what is shown');
  assert.deepEqual(team.boardSummary, { total: BOARD_LIMITS.boardItems + 1, open: 1, updatedAt: NOW - 60_000 });
});

test('standalone subagents sit under the conversation that started them; long-finished ones drop off', async (t) => {
  const f = await fixture(t);
  await f.record('st_7', { status: 'running', task_summary: 'Check the API', pid: 107 });
  await f.record('st_8', { status: 'completed', residency_state: 'disposed', task_summary: 'Old', updated_at: iso(-BOARD_LIMITS.recentAgentMs - 1) });
  await f.transcript('st_7', assistant(-400_000, [call('bash', { command: 'sleep 600' })], 'toolUse'), -400_000);
  const board = await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true });
  assert.equal(board.groups.length, 1);
  const [group] = board.groups;
  assert.equal(group.kind, 'agents');
  assert.equal(group.lead.role, 'lead');
  assert.deepEqual(group.members.map((member) => [member.name, member.role, member.turnOpen, member.lastActivityAt]),
    [['Check the API', 'subagent', true, NOW - 400_000]]);
  assert.deepEqual(group.members[0].open, { hostSessionId: LEAD, agentId: 'st_7', history: true });
});

test('groups come newest-created first, ties by id', async (t) => {
  const f = await fixture(t);
  for (const [runId, createdAgo] of [['run-a', 3_600_000], ['run-c', 60_000], ['run-b', 3_600_000]]) {
    const dir = path.join(f.state, 'teams', 'runtime', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ teamRunId: runId, teamName: runId, status: 'active', createdAt: NOW - createdAgo, members: [] }));
  }
  const board = await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true });
  assert.deepEqual(board.groups.map((group) => group.id), ['run-c', 'run-a', 'run-b']);
});

test('a long transcript is read from its end only', async (t) => {
  const f = await fixture(t);
  await f.record('st_9', { status: 'running', pid: 109 });
  const filler = assistant(-900_000, [said('x'.repeat(4_000))], 'stop').repeat(Math.ceil(BOARD_LIMITS.tailBytes / 4_000) + 5);
  await f.transcript('st_9', filler + assistant(-1_000, [said('Latest line.')], 'stop'), -1_000);
  const board = await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true });
  const [member] = board.groups[0].members;
  assert.equal(member.narration, 'Latest line.');
  assert.equal(member.turnOpen, false);
  assert.ok(member.steps.length <= BOARD_LIMITS.steps);
});

test('a last entry longer than the tail is read whole: a big tool result keeps the turn open and the narration', async (t) => {
  const f = await fixture(t);
  await f.record('st_10', { status: 'running', pid: 110 });
  const big = (offsetMs, bytes) => line({ type: 'message', timestamp: iso(offsetMs),
    message: { role: 'toolResult', toolCallId: 'c', content: [said('y'.repeat(bytes))] } });
  await f.transcript('st_10', assistant(-9_000, [said('Reading the whole log.'), call('read', { path: '/w/big.log' })], 'toolUse')
    + big(-5_000, BOARD_LIMITS.tailBytes + 5_000), -5_000);
  let board = await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true });
  let [member] = board.groups[0].members;
  assert.equal(member.turnOpen, true);
  assert.equal(member.narration, 'Reading the whole log.');
  assert.equal(member.lastActivityAt, NOW - 5_000);
  // Past the cap it is not read, and the turn is still not called closed.
  await f.transcript('st_10', assistant(-3_000, [said('Done reading.')], 'stop') + big(-2_000, BOARD_LIMITS.tailMaxBytes + 1_000), -2_000);
  board = await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true });
  [member] = board.groups[0].members;
  assert.equal(member.turnOpen, true);
  // Unread: what it last said stays the line read before, not the one hidden behind the big entry.
  assert.equal(member.narration, 'Reading the whole log.');
});

test('words before a big result are kept: carried from the last read, or found by reading further back', async (t) => {
  const f = await fixture(t);
  await f.record('st_11', { status: 'running', pid: 111 });
  const big = (offsetMs, bytes) => line({ type: 'message', timestamp: iso(offsetMs),
    message: { role: 'toolResult', toolCallId: 'c', content: [said('y'.repeat(bytes))] } });
  // Two calls in one step: a big result, then a small one, so the last line is whole in the tail.
  const head = assistant(-9_000, [said('Reading both logs.'), call('read', { path: '/w/a.log' }), call('read', { path: '/w/b.log' })], 'toolUse');
  const file = await f.transcript('st_11', head, -9_000);
  const read = async () => (await readStatusBoard({ cwds: [f.cwd], now: NOW, agentDir: f.agentDir, alive: () => true })).groups[0].members[0];
  assert.equal((await read()).narration, 'Reading both logs.');
  await writeFile(file, big(-6_000, BOARD_LIMITS.tailBytes * 2) + result(-5_000), { flag: 'a' });
  await utimes(file, new Date(NOW - 5_000), new Date(NOW - 5_000));
  let member = await read();
  assert.equal(member.turnOpen, true);
  assert.equal(member.narration, 'Reading both logs.', 'carried from the read before');
  assert.ok(member.steps.some((step) => step.text === 'read /w/a.log'));
  // A first read of the same file (a fresh server) reads back until it finds the words.
  const fresh = await mkdtemp(path.join(tmpdir(), 'rb-status-board-copy-'));
  t.after(() => rm(fresh, { recursive: true, force: true }));
  const g = { ...f, cwd: path.join(fresh, 'project'), state: path.join(fresh, 'project', '.rubato', 'task') };
  await mkdir(path.join(g.state, 'tasks'), { recursive: true });
  await writeFile(path.join(g.state, 'tasks', 'st_11.json'), JSON.stringify({ task_id: 'st_11', status: 'running', residency_state: 'resident', pid: 111, created_at: iso(-600_000) }));
  const dir = path.join(g.state, 'children', 'st_11', 'sessions', 'st_11');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, path.basename(file)), await readFile(file));
  member = (await readStatusBoard({ cwds: [g.cwd], now: NOW, agentDir: f.agentDir, alive: () => true })).groups[0].members[0];
  assert.equal(member.turnOpen, true);
  assert.equal(member.narration, 'Reading both logs.');
});

test('the service answers unchanged when the caller holds the same version', async () => {
  let reads = 0;
  let now = NOW;
  const service = createStatusBoardService({ clock: () => now, read: async ({ now: at }) => { reads += 1; return { now: at, groups: [{ id: 'g' }] }; } });
  const first = await service.handle('read', { cwds: ['/b', '/a'] });
  assert.equal(first.groups.length, 1);
  assert.equal((await service.handle('read', { cwds: ['/a', '/b'], version: first.version })).unchanged, true);
  assert.equal(reads, 1, 'asks within a second share one read');
  now += 2_000;
  assert.equal((await service.handle('read', { cwds: ['/a', '/b'], version: 'other' })).groups.length, 1);
  assert.equal(reads, 2);
  await assert.rejects(service.handle('write', {}), /Unknown action/);
});
