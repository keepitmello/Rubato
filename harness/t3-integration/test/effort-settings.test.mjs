// Settings > Providers > Thinking effort through the Providers tab's server half, written by Pi's
// own SettingsManager (this checkout's pi-runtime build) into a throwaway profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService, handleAuthRequest } from '../src/auth/service.mjs';
import { createEffortSettings } from '../src/auth/effort.mjs';

const runtimeRoot = fileURLToPath(new URL('../../pi-runtime/', import.meta.url));

async function profile(t, settings) {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-effort-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(path.join(agentDir, 'server'));
  await writeFile(path.join(agentDir, 'server', 'connection.json'), JSON.stringify({ runtimeRoot }));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const service = createAuthService({ effort: createEffortSettings({ agentDir, env: {} }) });
  const call = async (action, body) => {
    const response = await handleAuthRequest(service, new Request(`http://local/rubato/auth/${action}`, body === undefined
      ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const file = async () => JSON.parse(await readFile(path.join(agentDir, 'settings.json'), 'utf8'));
  return { call, file };
}

test('the page reads and writes the levels new conversations start at, leaving the rest of settings.json', async (t) => {
  const p = await profile(t, {
    defaultThinkingLevel: 'medium',
    modelThinkingLevels: { 'openai-codex/gpt-6.2-sol': 'medium' },
    theme: 'dark',
    modelServiceTiers: { 'openai-codex/gpt-6.2-sol': 'priority' },
  });
  assert.deepEqual((await p.call('effort')).body, { defaultLevel: 'medium', models: { 'openai-codex/gpt-6.2-sol': 'medium' } });

  assert.deepEqual((await p.call('set-effort', { defaultLevel: 'high' })).body.defaultLevel, 'high');
  const own = await p.call('set-effort', { model: 'anthropic/claude-haiku-5-5', level: 'low' });
  assert.deepEqual(own.body.models, { 'openai-codex/gpt-6.2-sol': 'medium', 'anthropic/claude-haiku-5-5': 'low' });
  const dropped = await p.call('set-effort', { model: 'openai-codex/gpt-6.2-sol', level: null });
  assert.deepEqual(dropped.body, { defaultLevel: 'high', models: { 'anthropic/claude-haiku-5-5': 'low' } });

  assert.deepEqual(await p.file(), {
    defaultThinkingLevel: 'high',
    modelThinkingLevels: { 'anthropic/claude-haiku-5-5': 'low' },
    theme: 'dark',
    modelServiceTiers: { 'openai-codex/gpt-6.2-sol': 'priority' },
  });
});

test('a level or model the page cannot mean is refused and nothing is written', async (t) => {
  const p = await profile(t, { defaultThinkingLevel: 'high' });
  for (const body of [{ defaultLevel: 'ultra' }, { model: 'claude', level: 'low' }, { model: 'anthropic/claude-haiku-5-5', level: 'ultra' }, {}]) {
    const answer = await p.call('set-effort', body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.error.code, 'bad-request');
  }
  assert.deepEqual(await p.file(), { defaultThinkingLevel: 'high' });
});
