// attachRubatoUpdates keeps process-wide IPC state, so this runs in its own file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from '../gui-update.mjs';
import { attachRubatoUpdates } from '../overlay/apps/desktop/src/updates/RubatoUpdates.ts';

test('closing the app window with a prompt open is not a "later"', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-gui-prompt-'));
  const h = { root, directory: path.join(root, '.rubato-pi', 'gui-update') };
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  process.env.HOME = h.root;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const helper = path.join(h.root, 'rubato', 'harness', 't3-integration', 'gui-update.sh');
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(helper, `echo '{"available":true,"revision":"revision-1","commits":1}'\n`);
  const settings = path.join(h.root, 'settings.json');
  await writeFile(settings, JSON.stringify({ providerInstances: { rubato: { config: {
    bridgeModule: path.join(path.dirname(helper), 'bridge', 'index.mjs') } } } }));
  const handlers = new Map();
  const sent = [];
  const open = () => {
    const window = new EventEmitter();
    const mainFrame = { url: 'http://127.0.0.1:3773/' };
    window.webContents = { id: 8800 + sent.length, mainFrame, send: (_c, s) => sent.push(s), isLoadingMainFrame: () => false };
    window.isDestroyed = () => false;
    window.isVisible = () => true;
    window.setProgressBar = () => {};
    attachRubatoUpdates(window, { ipcMain: { handle: (n, f) => handlers.set(n, f) }, dialog: {} }, settings, mainFrame.url);
    return { window, event: { sender: window.webContents, senderFrame: mainFrame } };
  };
  const first = open();
  const deadline = Date.now() + 5000;
  while (!sent.some((s) => s.phase === 'available') && Date.now() < deadline) await delay(20);
  assert.ok(sent.some((s) => s.phase === 'available'));
  first.window.emit('closed');
  await delay(50);
  assert.equal(await readJson(path.join(h.directory, 'later.json')), null);
  const firstId = sent.find((s) => s.phase === 'available').id;
  const second = open();
  // The reopened window must not show the dead prompt, and must ask again.
  const state = await handlers.get('rubato:update:get')(second.event);
  assert.notEqual(state.id, firstId);
  const again = Date.now() + 5000;
  while (!sent.some((s) => s.phase === 'available' && s.id !== firstId) && Date.now() < again) await delay(20);
  assert.ok(sent.some((s) => s.phase === 'available' && s.id !== firstId));
  second.window.emit('closed');
  await delay(50);
});
