// The scheduler as a resident service of the profile engine (pi-server resident-services.mjs).
// It runs in its own thread inside the engine: tasks start as ordinary sessions on this engine's
// socket, and a fault here ends the thread only — the engine starts it again and the next tick
// reconciles the runs it left. The schedule store and its lock are the ones the standalone daemon
// used, so the CLI, the session tool and the app's settings page keep working unchanged.
import { createScheduleStore } from '../../../packages/schedule-core/src/index.mjs';
import { createScheduler } from './scheduler.mjs';
import { releaseLock, tryLock } from './lock.mjs';

export const LOCK_RETRY_MS = 30_000;

export async function start(ctx) {
  const { options = {} } = ctx;
  const store = createScheduleStore({ env: ctx.env });
  const log = (event, details) => ctx.log(event, details);
  const root = store.files.root;
  const retryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
  // A scheduler outside the engine (the old launchd job, until the update removes it) keeps the
  // lock; this one waits for it instead of judging the same tasks twice.
  while (!tryLock(root)) {
    if (ctx.signal.aborted) return {};
    log('another scheduler holds this schedule; waiting', { root });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, retryMs);
      ctx.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  if (ctx.signal.aborted) { releaseLock(root); return {}; }
  const engine = { agentDir: ctx.agentDir, connect: () => ctx.connect() };
  const scheduler = createScheduler({ store, engine, log, ...(options.tickMs ? { tickMs: Number(options.tickMs) } : {}) });
  log('scheduler started', { root, agentDir: ctx.agentDir });
  await scheduler.start();
  return {
    tick: () => scheduler.tick(),
    async close() {
      try { await scheduler.stop(); } finally { releaseLock(root); }
    },
  };
}
