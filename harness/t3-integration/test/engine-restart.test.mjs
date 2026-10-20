// The engine restarted while the app stayed open (board 29, 2026-10-20 ~19:34–19:47Z): its socket is
// gone until launchd starts the next engine, which waits for the old one to finish its work. T3
// refreshed its provider snapshot inside that window, the catalogue timed out, the snapshot came
// back with no models, and the model picker stayed empty — new threads would not open — until the
// app was reopened. The bridge must come back to the new engine on its own, and the picker must
// never empty meanwhile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RubatoPiBridge } from '../src/bridge.mjs';
import { serveProfile } from '../../pi-server/src/profile-server.mjs';
import { RpcWorker } from '../../pi-server/src/rpc-worker.mjs';
import { readDescriptor } from '../../pi-server/src/descriptor.mjs';
import { socketAlive } from '../../pi-server/src/discovery.mjs';

const fixture = fileURLToPath(new URL('../../pi-server/test/fixtures/rpc.mjs', import.meta.url));
const engine = (root) => serveProfile({ agentDir: root, idleMs: 60, workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: fixture }) });

test('an engine restart with the app open: the picker keeps its list while no engine answers, and the bridge reaches the next engine by itself', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-t3-restart-'));
  let current = await engine(root);
  // launchd's part, as ensureProfileEngine does it under launchd: wait for the next engine's descriptor.
  const findEngine = async (descriptorPath) => {
    for (let i = 0; i < 400; i += 1) {
      const descriptor = await readDescriptor(descriptorPath).catch(() => null);
      if (descriptor && await socketAlive(descriptor.socketPath)) return descriptor;
      await delay(25);
    }
    throw new Error('Rubato profile engine did not start under launchd');
  };
  const bridge = new RubatoPiBridge({ descriptorPath: current.descriptorPath, instanceId: 'rubato-test', shows: () => true,
    findEngine, catalogueStaleMs: 100 });
  t.after(async () => { await bridge.close(); await current?.close().catch(() => {}); await rm(root, { force: true, recursive: true }); });

  const before = await bridge.catalogue(root);
  assert.ok(before.slashCommands.length > 0, 'the engine answered');
  const firstSocket = bridge.inventoryClient.socketPath;

  // The engine stops (SIGTERM); the next one has not started yet.
  await current.close();
  current = null;
  await delay(50);
  const started = Date.now();
  const during = await bridge.catalogue(root, { fresh: true });
  assert.ok(Date.now() - started < 2000, 'it does not wait out the restart (T3 gives up on a catalogue after 30 s)');
  assert.deepEqual(during.slashCommands, before.slashCommands, 'the last list stands in: the picker does not empty');

  // launchd starts the next engine on the same profile; the bridge reaches it without the app reopening.
  current = await engine(root);
  let after;
  for (let i = 0; i < 200 && !after; i += 1) {
    const answer = await bridge.catalogue(root, { fresh: true });
    if (bridge.inventoryClient?.client.connected && bridge.descriptor?.serverId === current.descriptor.serverId) after = answer;
    else await delay(25);
  }
  assert.ok(after, 'the bridge reconnected to the new engine');
  assert.notEqual(bridge.descriptor.serverId, undefined);
  assert.equal(bridge.inventoryClient.socketPath, current.descriptor.socketPath);
  assert.ok(firstSocket);
  const created = await bridge.viaInventory((client) => client.create({ cwd: root, title: 'after restart' }));
  assert.ok(created.sessionId, 'a new thread can open its session on the new engine');
});

test('an engine that never answered leaves nothing to stand in: the failure comes through', async (t) => {
  const bridge = new RubatoPiBridge({ descriptorPath: '/nonexistent/connection.json', instanceId: 'rubato-test',
    findEngine: async () => { throw new Error('Rubato profile engine did not start under launchd'); } });
  t.after(() => bridge.close());
  await assert.rejects(bridge.catalogue('/tmp'), /did not start/);
});
