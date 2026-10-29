// Segno switched off can be turned on from the app's rail (intent companion-segno rev 8): the button
// shows, dimmed, whenever Segno is off — on a device that never turned it on too — and one click
// saves `enabled: true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { companionRailAction } from '../overlay/apps/web/src/components/sidebar/rubatoCompanionRailAction.ts';

test('an off companion can be turned on with or without an existing conversation', () => {
  for (const id of ['segno', 'other']) for (const threadId of [null, 'existing-thread']) {
    assert.deepEqual(companionRailAction({ id, threadId, settings: { enabled: false } }, 'environment'),
      { kind: 'enable', companionId: id, environmentId: 'environment' });
  }
});

test('a running companion opens only its own thread; missing connection or thread opens settings', () => {
  const item = { id: 'other', threadId: 'own-thread', settings: { enabled: true } };
  assert.deepEqual(companionRailAction(item, 'environment'),
    { kind: 'open', companionId: 'other', environmentId: 'environment', threadId: 'own-thread' });
  assert.deepEqual(companionRailAction({ ...item, threadId: null }, 'environment'), { kind: 'settings', companionId: 'other' });
  assert.deepEqual(companionRailAction(item, null), { kind: 'settings', companionId: 'other' });
});
