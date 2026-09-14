import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ensureProfileEngine, isConversationLaunch } from '../src/discovery.mjs';
import { serveProfile } from '../src/profile-server.mjs';

test('CLI maintenance remains one-shot; all conversation modes share the engine', () => {
  for (const args of [[], ['hello'], ['-p', 'hi'], ['--mode', 'rpc'], ['--mode', 'json'], ['--', '--help']]) assert.equal(isConversationLaunch(args), true);
  for (const args of [['auth', 'status'], ['update'], ['config'], ['-h'], ['--help'], ['--list-models=foo'], ['--export', 'a']]) assert.equal(isConversationLaunch(args), false);
});
test('live legacy engine is reused by GUI and never silently replaced by a shared CLI', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-discovery-'));
  const server = await serveProfile({ agentDir: root, workerFactory() { throw new Error('Discovery must not open SDK actors'); } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const options = { descriptorPath: server.descriptorPath, runtimeRoot: null };
  const [a, b] = await Promise.all([ensureProfileEngine(options), ensureProfileEngine(options)]);
  assert.equal(a.serverId, b.serverId);
  await assert.rejects(ensureProfileEngine({ ...options, requireTerminal: true }), /No second engine was started/);
  assert.equal(server.host.metrics.runtimeStarts, 0);
});
