import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { HYDROGEN, acpModelSelection } from '../../pi-server/src/companion-agy.mjs';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { SessionClient } from '../../pi-server/src/client.mjs';
import { scheduledAgy } from '../../pi-server/src/scheduled-agy.mjs';
import { createScheduler } from '../src/scheduler.mjs';

const ref = `rubato-agy-cli/login/${HYDROGEN}`;
test('scheduled model references pin both the login type and the exact catalog choice', () => {
  assert.equal(scheduledAgy('openai/example'), null);
  assert.equal(scheduledAgy(ref).isolated, false);
  assert.throws(() => scheduledAgy(ref.replace('gemini-4', 'gemini-3')));
  const session = { models: { availableModels: [{ modelId: HYDROGEN }] } };
  assert.throws(() => acpModelSelection(session, HYDROGEN.replace('medium', 'low'), {}), /does not offer/);
  assert.throws(() => acpModelSelection(session, HYDROGEN, { thinking: 'low' }), /conflicts/);
  assert.equal(acpModelSelection(session, HYDROGEN, {}).model, HYDROGEN);
});

const candidate = process.env.RUBATO_TEST_CANDIDATE;
const binary = process.env.RUBATO_SCHEDULE_TEST_AGY;
const login = process.env.RUBATO_SCHEDULE_TEST_AGY_PROFILE;
test('isolated scheduled Hydrogen and unavailable-model run rows over official ACP', {
  skip: !candidate || !binary, timeout: 180_000,
}, async t => {
  const root = await mkdtemp('/tmp/rb-sc-agy-');
  const env = { HOME: root, RUBATO_T3_STATE_DIR: root, PI_OFFLINE: '1',
    RUBATO_PROMPTS_DIR: path.resolve(import.meta.dirname, '../../prompts') };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let service, scheduler;
  t.after(async () => {
    await scheduler?.stop();
    await service?.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  // Let official agy read its own login, without copying credentials or
  // sharing agents, MCP configs, conversations or caches with the real app.
  if (login) {
    const dir = path.join(root, 'providers', 'antigravity', createHash('sha256').update('login').digest('hex'), 'antigravity-acp');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await symlink(path.join(login, 'antigravity-acp', 'antigravity-oauth-token'), path.join(dir, 'antigravity-oauth-token'));
  }
  const selected = login ? ref.replace('agy-cli', 'agy-profile') : ref;
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ providerInstances: {
    login: { enabled: true, driver: 'antigravity', config: { binaryPath: binary },
      environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'rubato-lead' },
        ...(login ? [{ name: 'RUBATO_LOCAL_AGY_ISOLATED', value: '1' }] : [])] },
  } }));
  const socketPath = path.join(root, 'engine.sock');
  service = await serveProfile({ socketPath, runtimeRoot: candidate, agentDir: path.join(root, 'agent'),
    onError: e => t.diagnostic(e.message) });
  const connect = () => new SessionClient({ socketPath, serverId: service.serverId }).connect();
  const store = createScheduleStore({ root: path.join(root, 'schedule') });
  scheduler = createScheduler({ store, engine: { connect } });
  await scheduler.start();
  for (const [model, expected] of [[selected.replace(HYDROGEN, 'gemini-4-not-offered'), 'failed'], [selected, 'success']]) {
    const task = await store.create({ name: 'Hydrogen schedule check', model, prompt: 'Reply only: Hydrogen ready.',
      cwd: project, schedule: { kind: 'daily', time: '00:01' } });
    await store.runNow(task.id);
    await scheduler.tick();
    let row;
    for (let i = 0; i < 300; i++) {
      [row] = (await store.runs(task.id)).runs;
      if (row && row.status !== 'running') break;
      await delay(300);
    }
    assert.equal(row?.status, expected, JSON.stringify(row));
    if (expected === 'failed') assert.match(row.detail, /does not offer.*not-offered/i);
    else {
      const client = await connect();
      try {
        assert.ok((await client.list()).some(entry => entry.sessionId === row.sessionId && !entry.companion));
        const reply = (await client.transcript(row.sessionId)).messages.findLast(message => message.role === 'assistant');
        assert.equal(`${reply.provider}/${reply.model}`, selected);
        assert.match(JSON.stringify(reply.content), /Hydrogen ready/i);
      } finally { await client.close(); }
    }
    t.diagnostic(`${row.status} ${row.sessionId} ${row.model} ${row.detail ?? ''}`);
  }
});
