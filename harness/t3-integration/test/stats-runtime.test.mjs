import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runPrint, stockEngineLaunch } from '../src/stats/stories.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const storiesUrl = new URL('../src/stats/stories.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-stats-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const providers = path.join(root, 'rubato-features/child-runtime/provider-extension.mjs');
  await mkdir(path.dirname(cli), { recursive: true });
  await mkdir(path.dirname(providers), { recursive: true });
  await writeFile(providers, '');
  // No model calls or native modules: observe the actual runtime of the child.
  await writeFile(cli, `process.stdin.resume(); process.stdin.on('end', () => {
    console.log(JSON.stringify({ electron: process.versions.electron ?? null,
      node: process.versions.node, execPath: process.execPath,
      contextMode: process.env.RUBATO_CONTEXT_MODE }));
  });`);
  return { ...process.env, RUBATO_PI_ENGINE_DIR: root };
}

test('stats print jobs keep the standalone Node runtime and child profile', async (t) => {
  const env = await fixture(t);
  const launch = await stockEngineLaunch(repoRoot, env);
  const result = JSON.parse(await runPrint({ launch, env, model: 'test/model', systemPrompt: '', prompt: 'probe' }));
  assert.equal(result.electron, null);
  assert.equal(result.execPath, process.execPath);
  assert.equal(result.contextMode, 'summary');
});

test('an Electron backend launches stats jobs in standalone Node, not another app executable', {
  skip: !process.env.RUBATO_TEST_ELECTRON,
}, async (t) => {
  const env = await fixture(t);
  const script = `
    import { stockEngineLaunch, runPrint } from ${JSON.stringify(storiesUrl)};
    if (!process.versions.electron) throw new Error('Expected an Electron backend');
    const launch = await stockEngineLaunch(${JSON.stringify(repoRoot)}, process.env);
    console.log(await runPrint({ launch, env: process.env, model: 'test/model', systemPrompt: '', prompt: 'probe' }));
  `;
  const { stdout } = await exec(process.env.RUBATO_TEST_ELECTRON, ['--input-type=module', '-e', script], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.electron, null, 'ELECTRON_RUN_AS_NODE alone does not make Electron a standalone Node');
  assert.notEqual(result.execPath, process.env.RUBATO_TEST_ELECTRON);
  assert.equal(result.contextMode, 'summary');
});

test('the Electron branch never inherits the backend executable, even without Electron installed', async (t) => {
  const env = await fixture(t);
  const script = `
    import { stockEngineLaunch, runPrint } from ${JSON.stringify(storiesUrl)};
    Object.defineProperty(process.versions, 'electron', { value: 'test' });
    Object.defineProperty(process, 'execPath', { value: '/not-a-node/Rubato' });
    const launch = await stockEngineLaunch(${JSON.stringify(repoRoot)}, process.env);
    console.log(await runPrint({ launch, env: process.env, model: 'test/model', systemPrompt: '', prompt: 'probe' }));
  `;
  // Record the test runner's Node like the CLI does, so CI needs no system install.
  await mkdir(path.join(env.RUBATO_PI_ENGINE_DIR, '.rubato-pi'));
  await writeFile(path.join(env.RUBATO_PI_ENGINE_DIR, '.rubato-pi/node-path'), process.execPath);
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...env, HOME: env.RUBATO_PI_ENGINE_DIR }, timeout: 20_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.electron, null);
  assert.notEqual(result.execPath, '/not-a-node/Rubato');
  assert.equal(result.contextMode, 'summary');
});
