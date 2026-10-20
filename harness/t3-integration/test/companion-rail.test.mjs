// Segno switched off can be turned back on from the app's rail (intent companion-segno rev 8): the
// button stays, dimmed, once Segno has a conversation, and one click saves `enabled: true`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rail = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'overlay', 'apps', 'web', 'src', 'components', 'sidebar', 'RubatoProjectRail.tsx');

test('the rail keeps an off Segno that was set up, and its button turns it on', async () => {
  const source = await readFile(rail, 'utf8');
  const off = source.slice(source.indexOf('Segno, switched off'), source.indexOf('Segno, the always-on companion'));
  assert.match(off, /!companion\.status\.settings\.enabled && companion\.status\.sessionId !== null/, 'only once Segno was set up');
  assert.match(off, /saveSettings\(environmentId, \{ enabled: true \}\)/);
  assert.match(off, /acceptCompanionStatus/, 'the rail follows the saved status at once');
});
