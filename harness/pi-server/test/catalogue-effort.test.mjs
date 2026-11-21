import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveProfile } from '../src/profile-server.mjs';
import { SessionClient } from '../src/client.mjs';

const MODELS = [
  { provider: 'anthropic', id: 'claude-sonnet-5-5', reasoning: true },
  { provider: 'anthropic', id: 'claude-haiku-5-5', reasoning: true },
];

/** A hosted worker as the catalogue sees it: the RPC answers and the session's Pi settings. */
function hostedWorkers(settings) {
  return () => ({
    runtime: { session: { settingsManager: settings } },
    async start() { return { model: { provider: 'anthropic', id: 'claude-opus-5-5' }, thinkingLevel: 'low' }; },
    async request(command) {
      if (command.type === 'get_available_models') return { models: MODELS };
      if (command.type === 'get_commands') return { commands: [] };
      throw new Error(`unexpected ${command.type}`);
    },
    async stop() {},
  });
}

async function catalogue(t, workerFactory) {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-catalogue-effort-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const served = await serveProfile({ agentDir: root, workerFactory });
  t.after(() => served.close());
  const client = await new SessionClient(served.descriptor).connect();
  t.after(() => client.close());
  return Object.fromEntries((await client.catalogue(root)).models.map((model) => [model.id, model.startThinkingLevel]));
}

test('the catalogue carries the effort each model starts at, in Pi model-switch order', async (t) => {
  const settings = (perModel, global) => ({
    getModelThinkingLevel: (provider, id) => perModel[`${provider}/${id}`],
    getDefaultThinkingLevel: () => global,
  });
  assert.deepEqual(await catalogue(t, hostedWorkers(settings({ 'anthropic/claude-haiku-5-5': 'minimal' }, 'high'))),
    { 'claude-sonnet-5-5': 'high', 'claude-haiku-5-5': 'minimal' });
  // No profile default: a new conversation's own level.
  assert.deepEqual(await catalogue(t, hostedWorkers(settings({}, undefined))),
    { 'claude-sonnet-5-5': 'low', 'claude-haiku-5-5': 'low' });
});

test('a worker without Pi settings leaves the models as they are', async (t) => {
  assert.deepEqual(await catalogue(t, hostedWorkers(undefined)),
    { 'claude-sonnet-5-5': undefined, 'claude-haiku-5-5': undefined });
});
