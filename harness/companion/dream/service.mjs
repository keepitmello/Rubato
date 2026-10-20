// Segno's dream as a resident service of the engine (pi-server resident-services.mjs): its own
// thread, so a fault here ends this thread only and the engine starts it again, and the companion's
// keeper and conversation keep going. Once a minute it asks whether the dream is due (dream.mjs
// dreamDue) and, when it is, starts the dream as its own engine process (ctx.spawn, so the engine
// owns and reaps it and stops it if this thread ends).
//
// The service reads the engine's conversation list to see whether Segno is in a turn, and nothing
// more: it never attaches to Segno's conversation and never calls the engine's wake or notice, so
// the dream starts, runs and ends without a word in Segno's context (intent companion-segno, user
// item bfe3d27d).
import { open } from 'node:fs/promises';
import path from 'node:path';
import { readSettings, readState } from '../companion.mjs';
import { dreamDue, readDreamState, runCompanionDream } from './dream.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const BUSY = new Set(['starting', 'running', 'waiting']);
const POLL_MS = 60_000;

/** How to start an engine child: the staged runtime's CLI with Rubato's providers (the coding dream's launch). */
async function resolveLaunch(env) {
  const { resolvePiEngineDir } = await import(path.join(repoRoot, 'harness', 'rubato-pi', 'src', 'engine-paths.mjs'));
  const { resolvePiMemoryChildLaunch } = await import(path.join(repoRoot, 'harness', 'pi-runtime', 'features', 'child-runtime', 'stock-rpc-runtime.mjs'));
  return resolvePiMemoryChildLaunch({ root: resolvePiEngineDir(env) });
}

/**
 * The loop, apart from the engine so tests can drive it: `isBusy()` answers whether Segno is in a
 * turn, `run()` starts one dream. Returns `{ check, close }`; `check()` is one pass.
 */
export function startDreamLoop({ env = process.env, isBusy, run, now = Date.now, pollMs = POLL_MS, onError = () => {}, log = () => {} }) {
  let running;
  let closed = false;
  async function check() {
    if (closed || running) return undefined;
    const at = now();
    const enabled = readSettings(env).enabled && Boolean(readState(env).sessionId);
    // Cheap gates first; the engine is asked about Segno only when the clock says the dream is due.
    const first = dreamDue({ at, state: readDreamState(env), enabled, busy: false });
    if (!first.due) return first;
    const verdict = dreamDue({ at, state: readDreamState(env), enabled, busy: await isBusy() });
    if (!verdict.due) return verdict;
    log('dream start');
    running = run().then((record) => { log('dream end', { status: record?.status, runId: record?.runId }); return record; })
      .catch((error) => { onError(error); return { status: 'failed', reason: String(error?.message ?? error) }; })
      .finally(() => { running = undefined; });
    return { due: true, record: await running };
  }
  const timer = setInterval(() => { void check().catch(onError); }, pollMs);
  timer.unref?.();
  return {
    check,
    async close() { closed = true; clearInterval(timer); await running; },
  };
}

export async function start(ctx) {
  const env = ctx.env;
  const [{ childEnv }, { launchProductModel }] = await Promise.all([
    import(path.join(repoRoot, 'packages', 'rubato-runtime', 'src', 'dream', 'child-env.ts')),
    import(path.join(repoRoot, 'packages', 'model-core', 'src', 'product-model-catalog.mjs')),
  ]);
  async function isBusy() {
    const { sessionId } = readState(env);
    const client = await ctx.connect();
    try {
      const row = (await client.list()).find((item) => item.sessionId === sessionId);
      return BUSY.has(row?.status);
    } finally { await client.close().catch(() => {}); }
  }
  // The engine's main thread starts the child (ctx.spawn), owns it and reaps it; its output goes to
  // the run's log through descriptors this thread holds until the spawn resolves.
  async function spawnChild({ command, args, cwd, env: childEnvironment, logPath, timeoutMs }) {
    const out = await open(logPath, 'a', 0o600);
    let child;
    try {
      child = await ctx.spawn(command, args, { cwd, env: childEnvironment, stdio: ['ignore', out.fd, out.fd] });
    } catch (error) {
      await out.appendFile(`spawn error: ${String(error?.message ?? error)}\n`).catch(() => {});
      return { code: null };
    } finally { await out.close().catch(() => {}); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code }); });
    });
  }
  const run = async () => runCompanionDream({ env, launch: await resolveLaunch(env), childEnv, launchModel: launchProductModel, spawnChild });
  const loop = startDreamLoop({ env, isBusy, run, onError: ctx.onError, log: ctx.log });
  return { check: () => loop.check(), close: () => loop.close() };
}
