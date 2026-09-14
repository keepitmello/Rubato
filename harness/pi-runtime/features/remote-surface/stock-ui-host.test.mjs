import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadPiFeatures } from '../../feature-catalog.mjs';
import { stagePiRuntime } from '../../stage-runtime.mjs';
import { patchStockUiHost } from './patches.mjs';
import { bindStockUiHost, invalidateStockUiHost } from './stock-ui-host.mjs';

const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
test('an inactive factory leaves existing UI functions unchanged', () => {
  const select = () => Promise.resolve('native');
  const ui = { select };
  const mode = { session: {} };
  assert.equal(bindStockUiHost(mode, ui), ui);
  assert.equal(ui.select, select);
  assert.deepEqual(Object.keys(ui), ['select']);
  invalidateStockUiHost(mode);
});
test('stock UI host patch is unique, pinned and composes with the existing input feature', async (t) => {
  const stock = await readFile(join(sourceRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js'), 'utf8');
  assert.throws(() => patchStockUiHost(patchStockUiHost(stock)), /already patched/);
  assert.throws(() => patchStockUiHost(stock.replace('async bindCurrentSessionExtensions()', 'async changed()')), /unique stock anchor/);
  const scratch = await mkdtemp(join(tmpdir(), 'rubato-stock-ui-host-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: join(scratch, 'engine'),
    features: await loadPiFeatures(['remote-surface', 'tui-input']) });
  const env = { ...process.env, HOME: scratch, PI_OFFLINE: '1',
    PI_CODING_AGENT_DIR: join(scratch, 'agent'), RUBATO_PI_CODING_AGENT_DIR: join(scratch, 'agent') };
  for (const key of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'RUBATO_HUB_SOCKET', 'RUBATO_LIVE_DESCRIPTOR']) delete env[key];
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./test-fixtures/stock-ui-host.mjs', import.meta.url)), staged.root, scratch],
    { env, cwd: scratch, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /STOCK_UI_HOST_OK/);
  t.diagnostic(child.stdout.match(/STOCK_UI_HOST_OK[^\n]*/)[0]);
  // Falsify the roundtrip: a missing response capability must fail this same
  // real-stock fixture rather than producing a false-positive "UI parity".
  const broken = spawnSync(process.execPath, [fileURLToPath(new URL('./test-fixtures/stock-ui-host.mjs', import.meta.url)), staged.root, scratch],
    { env: { ...env, RUBATO_TEST_UI_REPLY_DISABLED: '1' }, cwd: scratch, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(broken.error, undefined);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stderr, /false !== true/);
  t.diagnostic('Negative control: disabling the UI reply capability fails the Unix/native roundtrip as expected.');
  assert.equal(await readFile(join(sourceRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js'), 'utf8'), stock);
});
