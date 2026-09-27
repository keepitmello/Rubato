import test from 'node:test';
import assert from 'node:assert/strict';
import { errorLog } from '../src/error-log.mjs';

test('a burst of the same failure is one timed line and a count', () => {
  const lines = [];
  const report = errorLog({ write: (line) => lines.push(line), now: () => new Date('2026-09-27T13:50:42.000Z') });
  report(new Error('Unix connection exceeded its pending byte limit'));
  for (let index = 0; index < 2196; index++) report(new Error('Unix connection is closed'));
  report(new Error('Agent is already processing.'));
  report.flush();
  assert.deepEqual(lines, [
    '2026-09-27T13:50:42.000Z Unix connection exceeded its pending byte limit',
    '2026-09-27T13:50:42.000Z Unix connection is closed',
    '2026-09-27T13:50:42.000Z (repeated 2195 more times)',
    '2026-09-27T13:50:42.000Z Agent is already processing.',
  ]);
});
