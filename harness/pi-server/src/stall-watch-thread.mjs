// The engine's stall watch (perf-log.mjs watchStalls). The main thread bumps `beat` every
// `intervalMs`; when it has not moved for `sampleAfterMs`, the main thread is held, and this thread
// asks it, through the process's own inspector, to record what it is running (its label and stack)
// every `sampleEveryMs` until it turns again. The session is open only while the thread is held, so
// a turning engine carries no inspector session.
import { Session } from 'node:inspector/promises';
import { workerData } from 'node:worker_threads';

const { beat, intervalMs, sampleAfterMs, sampleEveryMs } = workerData;
const SAMPLE = 'globalThis[Symbol.for("rubato.stall-sample")]?.()';
let seen = Atomics.load(beat, 0);
let since = performance.now();
let lastSample = 0;
let session;
let asking = false;

const poll = Math.max(20, Math.min(100, intervalMs / 2));
setInterval(async () => {
  const value = Atomics.load(beat, 0);
  const at = performance.now();
  if (value !== seen) {
    seen = value; since = at;
    if (session) { try { session.disconnect(); } catch {} session = undefined; }
    return;
  }
  if (asking || at - since < intervalMs + sampleAfterMs || at - lastSample < sampleEveryMs) return;
  asking = true; lastSample = at;
  try {
    if (!session) { session = new Session(); session.connectToMainThread(); }
    await session.post('Runtime.evaluate', { expression: SAMPLE, silent: true, returnByValue: true });
  } catch { try { session?.disconnect(); } catch {} session = undefined; }
  finally { asking = false; }
}, poll);
