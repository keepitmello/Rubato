#!/usr/bin/env node
// The resident scheduler. launchd keeps it alive (com.keepitmello.rubato.scheduler, see
// launchd.mjs); `rubato schedule install` registers it. One per schedule directory: a second
// copy waits for the first to exit instead of judging the same tasks twice.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { createEngineConnector } from './engine.mjs';
import { createScheduler } from './scheduler.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'agent-dir': { type: 'string' }, 'tick-ms': { type: 'string' } } });
const env = { ...process.env, ...(values.root ? { RUBATO_SCHEDULE_HOME: path.resolve(values.root) } : {}) };
const store = createScheduleStore({ env });
const log = (event, details) => process.stdout.write(`${new Date().toISOString()} ${event}${details ? ` ${JSON.stringify(details)}` : ''}\n`);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

const lockFile = path.join(store.files.root, 'daemon.lock');
function tryLock() {
  mkdirSync(store.files.root, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(lockFile, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let holder = NaN;
  try { holder = Number(readFileSync(lockFile, 'utf8').trim()); } catch {}
  if (pidAlive(holder)) return false;
  try { unlinkSync(lockFile); } catch {}
  return tryLock();
}

while (!tryLock()) {
  log('another scheduler holds this schedule; waiting', { root: store.files.root });
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
    try { if (Number(readFileSync(lockFile, 'utf8').trim()) === process.pid) unlinkSync(lockFile); } catch {}
    process.exit(0);
  }
})();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
log('scheduler started', { pid: process.pid, root: store.files.root, agentDir: engine.agentDir });
await scheduler.start();
