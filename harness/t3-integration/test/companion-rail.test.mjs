// Segno switched off can be turned on from the app's rail (intent companion-segno rev 8): the button
// shows, dimmed, whenever Segno is off — on a device that never turned it on too — and one click
// saves `enabled: true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rail = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'apps', 'web', 'src', 'components', 'sidebar', 'RubatoProjectRail.tsx');

test('the rail shows an off Segno, set up or not, and its button turns it on', async () => {
  const source = await readFile(rail, 'utf8');
  const off = source.slice(source.indexOf('Segno while it is off'), source.indexOf('Segno, the always-on companion'));
  assert.match(off, /companion\.status && !companion\.status\.settings\.enabled \?/);
  assert.doesNotMatch(off, /sessionId/, 'a device that never turned Segno on shows it too');
  assert.match(off, /saveSettings\(environmentId, \{ enabled: true \}\)/);
  assert.match(off, /acceptCompanionStatus/, 'the rail follows the saved status at once');
});
