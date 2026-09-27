// The Providers tab's server half against the real `rubato auth --json` CLI, on a
// throwaway HOME: status, a key login answered through the job, pin, remove, and a
// cancelled login that leaves nothing behind. No network: key logins stay local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthService, handleAuthRequest } from '../src/auth/service.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-auth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    RUBATO_AUTH_PATH: path.join(home, 'auth.json'),
    RUBATO_AUTH_POOL_STATE: path.join(home, 'pool.json'),
    RUBATO_CLAUDE_ACCOUNT: 'sub',
    RUBATO_CLAUDE_SETUP_TOKEN_FILE: path.join(home, 'setup-token'),
  };
  return { home, env, service: createAuthService({ env }) };
}

async function until(service, job, predicate) {
  for (let i = 0; i < 100; i += 1) {
    const state = await service.handle('login-state', { job });
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('login never reached the expected state');
}

const provider = (status, id) => status.providers.find((entry) => entry.id === id);

test('a key login answered through the job shows up in status, then pin and remove', async (t) => {
  const f = await fixture(t);
  assert.equal(provider(await f.service.handle('status'), 'kiro').state, 'absent');

  const started = await f.service.handle('login', { provider: 'kiro', method: 'api_key' });
  const asked = await until(f.service, started.id, (state) => state.prompt !== null);
  assert.equal(asked.prompt.kind, 'secret');
  await f.service.handle('answer', { job: started.id, prompt: asked.prompt.id, value: 'kiro-key' });
  const done = await until(f.service, started.id, (state) => state.status !== 'running');
  assert.equal(done.status, 'done');
  assert.equal(JSON.stringify(done).includes('kiro-key'), false);

  const kiro = provider(await f.service.handle('status'), 'kiro');
  assert.equal(kiro.state, 'connected');
  assert.equal(kiro.accounts[0].type, 'api_key');
  assert.deepEqual(await f.service.handle('pin', { provider: 'kiro', account: 'default' }), { ok: true });
  assert.equal(provider(await f.service.handle('status'), 'kiro').accounts[0].pinned, true);
  assert.deepEqual(await f.service.handle('remove', { provider: 'kiro', account: 'default' }), { ok: true });
  assert.equal(provider(await f.service.handle('status'), 'kiro').state, 'absent');
});

test('the Claude setup-token lands in its own file, not auth.json', async (t) => {
  const f = await fixture(t);
  const started = await f.service.handle('login', { provider: 'anthropic', method: 'setup-token' });
  const asked = await until(f.service, started.id, (state) => state.prompt !== null);
  await f.service.handle('answer', { job: started.id, prompt: asked.prompt.id, value: 'sk-ant-oat-gui-test' });
  assert.equal((await until(f.service, started.id, (state) => state.status !== 'running')).status, 'done');
  assert.equal((await readFile(path.join(f.home, 'setup-token'), 'utf8')).trim(), 'sk-ant-oat-gui-test');
  assert.equal(existsSync(f.env.RUBATO_AUTH_PATH), false);
  const claude = provider(await f.service.handle('status'), 'anthropic');
  assert.equal(claude.accounts.find((account) => account.source === 'setup-token')?.type, 'setup-token');
});

test('a cancelled login ends as cancelled and stores nothing', async (t) => {
  const f = await fixture(t);
  const started = await f.service.handle('login', { provider: 'deepseek', method: 'api_key' });
  await until(f.service, started.id, (state) => state.prompt !== null);
  await f.service.handle('cancel', { job: started.id });
  assert.equal((await until(f.service, started.id, (state) => state.status !== 'running')).status, 'cancelled');
  assert.equal(existsSync(f.env.RUBATO_AUTH_PATH), false);
});

test('the HTTP surface rejects malformed input and unknown jobs', async (t) => {
  const f = await fixture(t);
  const post = (action, body) => handleAuthRequest(f.service, new Request(`http://x/rubato/auth/${action}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
  assert.equal((await post('remove', { provider: '../x', account: 'default' })).status, 400);
  assert.equal((await post('login', { provider: 'kiro', method: 'shell' })).status, 400);
  assert.equal((await post('login-state', { job: 'nope' })).status, 404);
  const status = await handleAuthRequest(f.service, new Request('http://x/rubato/auth/status'));
  assert.equal(status.status, 200);
  assert.ok((await status.json()).providers.length >= 8);
});
