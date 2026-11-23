import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { openAgyNativeTools } from '../../t3-integration/agy-native-tools.mjs';
import { SessionClient } from '../src/client.mjs';
import { serveProfile } from '../src/profile-server.mjs';

const candidate = process.env.RUBATO_TEST_CANDIDATE;
test('ordinary AGY exposes native lazy and session tools but not companion controls',
  { skip: !candidate, timeout: 30_000 }, async t => {
    const root = await mkdtemp('/tmp/rb-agy-tools-');
    const agentDir = path.join(root, 'agent');
    const cwd = path.join(root, 'project');
    await mkdir(cwd);
    const socketPath = path.join(root, 'engine.sock');
    const prompts = path.resolve(import.meta.dirname, '../../prompts');
    const env = { ...process.env, RUBATO_PI_CODING_AGENT_DIR: agentDir, RUBATO_PROMPTS_DIR: prompts, PI_OFFLINE: '1' };
    const oldPrompts = process.env.RUBATO_PROMPTS_DIR;
    process.env.RUBATO_PROMPTS_DIR = prompts;
    let engine, client, tools;
    t.after(async () => {
      await tools?.close();
      await client?.close();
      await engine?.close();
      if (oldPrompts === undefined) delete process.env.RUBATO_PROMPTS_DIR;
      else process.env.RUBATO_PROMPTS_DIR = oldPrompts;
      await rm(root, { recursive: true, force: true });
    });
    engine = await serveProfile({ agentDir, socketPath, runtimeRoot: candidate });
    client = await new SessionClient({ socketPath, serverId: engine.serverId }).connect();
    const app = await client.create({ cwd, title: 'Ordinary native fixture' });
    tools = await openAgyNativeTools({ cwd, env });
    const names = new Set(tools.list().map(tool => tool.name));
    for (const name of ['todo', 'schedule', 'Agent', 'team_create', 'image_create', 'session_list', 'session_send']) {
      assert.ok(names.has(name), `${name} is missing in AGY`);
    }
    for (const name of ['reply', 'inbox_list', 'companion_settings', 'session_stop']) assert.ok(!names.has(name), name);
    const listing = await tools.call('session_list', { cwd });
    assert.equal(listing.isError, undefined);
    assert.match(listing.content[0].text, new RegExp(app.sessionId));
    assert.equal((await tools.call('reply', { text: 'should not run' })).isError, true);
    await assert.rejects(client.externalLeadTool(cwd, 'stop', { sessionId: app.sessionId }), /ordinary conversation/);
    await assert.rejects(client.externalLeadTool(root, 'list', {}), /another workspace/,
      // The initial call fixed this independent test connection to cwd.
    );
  });
