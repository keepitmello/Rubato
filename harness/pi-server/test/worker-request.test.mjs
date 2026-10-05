import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../src/contracts.mjs';
import { workerRequest, SERVICE_TIER_REQUEST, AWAITED_WAKES_REQUEST } from '../src/host.mjs';
import { TERMINAL_AWAITED_WAKES_REQUEST } from '../../pi-runtime/features/terminal/src/host/monitor-state-event.ts';

test('child controls reach the task extension as its own requests', () => {
  assert.ok(COMMANDS.has('task_send') && COMMANDS.has('task_cancel'));
  assert.deepEqual(workerRequest({ type: 'task_send', taskId: 'st_a', message: 'focus on Q4' }),
    { type: 'extension_request', name: 'rubato.task.send', data: { to: 'st_a', message: 'focus on Q4' } });
  assert.deepEqual(workerRequest({ type: 'task_cancel', taskId: 'st_a', reason: 'Stopped by the user' }),
    { type: 'extension_request', name: 'rubato.task.cancel', data: { task_id: 'st_a', reason: 'Stopped by the user' } });
  assert.deepEqual(workerRequest({ type: 'task_cancel', taskId: 'st_a' }),
    { type: 'extension_request', name: 'rubato.task.cancel', data: { task_id: 'st_a' } });
});

test('Pi commands pass through and the service tier still asks its extension', () => {
  assert.deepEqual(workerRequest({ type: 'abort' }), { type: 'abort' });
  assert.deepEqual(workerRequest({ type: 'get_service_tier' }), { type: 'extension_request', name: SERVICE_TIER_REQUEST });
});

test('an attached client asks the terminal what the idle agent still waits on', () => {
  assert.ok(COMMANDS.has('get_awaited_wakes'));
  assert.equal(AWAITED_WAKES_REQUEST, TERMINAL_AWAITED_WAKES_REQUEST);
  assert.deepEqual(workerRequest({ type: 'get_awaited_wakes' }), { type: 'extension_request', name: TERMINAL_AWAITED_WAKES_REQUEST });
});
