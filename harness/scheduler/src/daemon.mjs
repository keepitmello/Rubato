#!/usr/bin/env node
// The scheduler outside the engine. The scheduler normally runs inside the profile engine
// (service.mjs); this entry runs the same scheduler as its own process for development and the
// fixture engine (test/fixtures/serve-fixture-engine.mjs). One per schedule directory: a second
// copy waits for the first to exit instead of judging the same tasks twice (lock.mjs).
//
// Older installs registered this file as the launchd job com.keepitmello.rubato.scheduler. When
// that job starts it (after an update), it moves the machine over: it registers the engine with
// launchd and removes its own job, which ends this process (pi-server launchd.mjs).
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { engineJob, ensureEngineLaunchAgent } from '../../pi-server/src/launchd.mjs';
import { createEngineConnector } from './engine.mjs';
import { releaseLock, tryLock } from './lock.mjs';
import { createScheduler } from './scheduler.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'agent-dir': { type: 'string' }, 'tick-ms': { type: 'string' } } });
const env = { ...process.env, ...(values.root ? { RUBATO_SCHEDULE_HOME: path.resolve(values.root) } : {}) };
const store = createScheduleStore({ env });
const log = (event, details) => process.stdout.write(`${new Date().toISOString()} ${event}${details ? ` ${JSON.stringify(details)}` : ''}\n`);

let legacyLabel;
try { legacyLabel = engineJob(env).legacySchedulerLabel; } catch {}
if (legacyLabel && process.env.XPC_SERVICE_NAME === legacyLabel) {
  try {
    const moved = await ensureEngineLaunchAgent({ env });
    log('moved into the engine: the engine is registered with launchd and this job is removed', moved);
    process.exit(0);
  } catch (error) {
    // Keep scheduling from here rather than leave the tasks without a scheduler.
    log('could not move into the engine; running on as before', { error: String(error?.stderr || error?.message || error) });
  }
}

const root = store.files.root;
while (!tryLock(root)) {
  log('another scheduler holds this schedule; waiting', { root });
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}

const engine = createEngineConnector({
  env,
  ...(values['agent-dir'] ? { agentDir: path.resolve(values['agent-dir']) } : {}),
  onError: (error) => log('engine client error', { error: String(error?.message ?? error) }),
});
const scheduler = createScheduler({ store, engine, log, ...(values['tick-ms'] ? { tickMs: Number(values['tick-ms']) } : {}) });
let stopping;
const stop = () => stopping ??= (async () => {
  log('scheduler stopping');
  try { await scheduler.stop(); } finally {
    releaseLock(root);
    process.exit(0);
  }
})();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
log('scheduler started', { pid: process.pid, root: store.files.root, agentDir: engine.agentDir });
await scheduler.start();
