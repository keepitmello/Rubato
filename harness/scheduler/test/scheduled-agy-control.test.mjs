import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { SessionClient } from '../../pi-server/src/client.mjs';
import { HYDROGEN } from '../../pi-server/src/companion-agy.mjs';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { executeRun } from '../src/runner.mjs';

const model = `rubato-agy-cli/login/${HYDROGEN}`;
async function firstRun(engine, cwd) {
  const row = { id: 'run', title: 'Scheduled test' };
  await executeRun({ engine, row, task: { cwd, model }, update: patch => Object.assign(row, patch) });
  return row;
}

test('a lost engine while attaching a scheduled agy session is not an account problem', async () => {
  const row = await firstRun({ connect: async () => ({
    create: async () => ({ sessionId: 'created' }),
    attach: async () => { throw new Error('Engine disconnected'); },
    detach: async () => {}, close: async () => {},
  }) }, import.meta.dirname);
  assert.deepEqual([row.status, row.sessionId, row.reason, row.detail],
    ['failed', 'created', 'start-failed', 'Engine disconnected']);
});

test('scheduled model replay, explicit switch refusal and missing login reach the RPC caller',
  { skip: !process.env.RUBATO_TEST_CANDIDATE }, async t => {
    const root = await mkdtemp('/tmp/rb-agy-control-');
    const env = { HOME: root, PI_OFFLINE: '1', RUBATO_T3_STATE_DIR: root,
      RUBATO_PROMPTS_DIR: path.resolve(import.meta.dirname, '../../prompts') };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    let service, client;
    t.after(async () => {
      await client?.close();
      await service?.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    const settings = path.join(root, 'settings.json');
    await writeFile(settings, JSON.stringify({ providerInstances: { login: { enabled: true, driver: 'antigravity',
      config: { binaryPath: '/not-invoked/agy' }, environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'rubato-lead' }] } } }));
    const socketPath = path.join(root, 'engine.sock');
    service = await serveProfile({ socketPath, agentDir: path.join(root, 'agent'), runtimeRoot: process.env.RUBATO_TEST_CANDIDATE });
    const connect = () => new SessionClient({ socketPath, serverId: service.serverId }).connect();
    client = await connect();
    const session = await client.create({ cwd: root, agy: { model } });
    await client.attach(session.sessionId);
    const replay = { type: 'set_model', provider: 'rubato-agy-cli', modelId: `login/${HYDROGEN}` };
    assert.equal((await client.command(replay)).id, replay.modelId);
    for (const change of [{ provider: 'another-provider' }, { modelId: `another-account/${HYDROGEN}` }]) {
      await assert.rejects(client.command({ ...replay, ...change }), /Start a new thread to use another model/);
    }
    assert.equal((await client.command({ type: 'get_state' })).model.id, replay.modelId);
    await writeFile(settings, '{"providerInstances":{}}');
    const row = await firstRun({ connect }, root);
    assert.equal(row.reason, 'model', JSON.stringify(row));
    assert.match(row.detail, /Antigravity account login/);
  });
