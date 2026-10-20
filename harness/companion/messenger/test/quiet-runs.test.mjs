// Which input opened each run of Segno's conversation (quiet-runs.mjs), as the Telegram mirror and
// the settings tool's "only the person changes a setting" read it. Segno's thread in the app does not
// use this (t3-integration companion-thread.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { QUIET_WAKES, newQuietState, quietStep, reportedIds } from '../quiet-runs.mjs';
import { WAKES } from '../../../pi-runtime/features/session-link/message.mjs';

const wake = (what) => ({ role: 'custom', customType: 'rubato-session-message', display: false, content: '<rubato_wake>',
  details: { v: 1, messageId: `w-${what}`, kind: 'wake', what, from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text: 'tick' }, timestamp: 1 });
const user = { role: 'user', content: 'hi', timestamp: 3 };
const said = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 30, stopReason: 'stop' });
const bashLaunch = (id) => ({ role: 'toolResult', toolCallId: `call-${id}`, toolName: 'bash', isError: false, timestamp: 10,
  content: [{ type: 'text', text: `Command running in background with ID: ${id}` }], details: { bash_id: id, background: true } });
const agentLaunch = (id) => ({ role: 'toolResult', toolCallId: `call-${id}`, toolName: 'Agent', isError: false, timestamp: 10,
  content: [{ type: 'text', text: `Started ${id}` }], details: { agentId: id, status: 'running', mode: 'spawn' } });
const terminalDone = (id, content) => ({ role: 'custom', customType: 'senpi-terminal:notification', display: false, timestamp: 20,
  content: content ?? `<system-reminder>Background terminal session ${id} finished: completed (exit code 0).</system-reminder>` });
const taskDone = (ids) => ({ role: 'custom', customType: 'rubato.task.completion', display: false, timestamp: 20,
  content: 'A subagent finished.', details: ids.map((agentId) => ({ agentId, status: 'completed' })) });
const quietOf = (messages) => { const state = newQuietState(); return messages.map((message) => quietStep(state, message).quiet); };

test("the quiet wakes are Rubato's clock, and each opens a quiet run up to the next other input", () => {
  for (const what of QUIET_WAKES) assert.ok(WAKES.includes(what), what);
  assert.deepEqual(quietOf([user, said('a'), wake('heartbeat'), said('b'), user, said('c')]), [false, false, true, true, false, false]);
});

test('background work finishing belongs to the run that launched it; a mixed batch is the person\'s; unknown work continues the stretch', () => {
  const stored = [user, agentLaunch('st_person03'), said('a'), wake('heartbeat'), agentLaunch('st_segno03'), said('b'),
    taskDone(['st_segno03']), said('PRIVATE'), taskDone(['st_segno03', 'st_person03']), said('MIXED'), terminalDone('bash_999'), said('UNKNOWN')];
  const state = newQuietState();
  const steps = stored.map((message) => quietStep(state, message));
  assert.deepEqual(steps[6], { quiet: true, launcher: 'st_segno03' });
  assert.deepEqual(steps[8], { quiet: false, launcher: 'st_person03' });
  assert.deepEqual(steps[10], { quiet: false }, 'unknown work continues the stretch, no launcher');
  const segnoOnly = newQuietState();
  for (const message of [wake('heartbeat'), agentLaunch('st_segno04'), said('c'), user, said('d')]) quietStep(segnoOnly, message);
  assert.deepEqual(quietStep(JSON.parse(JSON.stringify(segnoOnly)), taskDone(['st_segno04'])), { quiet: true, launcher: 'st_segno04' },
    'the state survives a JSON round trip');
});

test('a finish is identified by its own header or details: bash_1 is not bash_10, and ids its output mentions do not count', () => {
  assert.deepEqual(quietOf([user, bashLaunch('bash_1'), said('a'), wake('heartbeat'), bashLaunch('bash_10'), said('b'), user, said('c'),
    terminalDone('bash_10'), said('PRIVATE_TEN')]).at(-1), true);
  const quoting = terminalDone('bash_42', '<system-reminder>Background terminal session bash_42 finished: completed.\nFinal output:\nEarlier bash_41 was already checked.</system-reminder>');
  assert.deepEqual(reportedIds(quoting), ['bash_42']);
  assert.deepEqual(reportedIds({ ...taskDone(['st_segno9']), content: 'Result mentions st_person9 in passing.' }), ['st_segno9']);
  assert.deepEqual(reportedIds({ role: 'custom', customType: 'codemode:detached-eval', display: false,
    content: '<system-reminder>Detached eval cell toolu_01EVALcell (js) completed.\n42\n</system-reminder>' }), ['toolu_01EVALcell']);
});
