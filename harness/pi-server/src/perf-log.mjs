// What the engine's one thread costs, in pi-server.log. Every conversation, the app's requests
// and the resident services share that thread, so when it is held everything waits: a reply
// stops streaming, a new thread times out. These lines say when, for how long and what held it,
// so a slow moment names its cause without a profiler:
//
//   engine stalled 1834ms — pi.control.snapshot · session 01a19761… "세그노" (4/4)
//     at outlineEntries session-worker.mjs:72 < SessionWorker.output session-worker.mjs:110
//
// What held it comes from two pieces:
//   - the operation: each entry into the engine (a request from an app, a conversation's own
//     work, a resident service's call, the folder scan) runs under a label in `operations`.
//     Promises and timers carry the label of the code that started them, so one label per entry
//     covers everything that entry causes.
//   - the sample: a watch thread (stall-watch-thread.mjs) sees the heartbeat below stop, and asks
//     the held thread, through the process's own inspector, for its label and stack. V8 answers
//     that between two JavaScript steps of the held work itself, so the sample is of what holds
//     the thread, not of what runs after. A turning thread is never asked anything.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

/** The operation the running code belongs to: `{ op, session? }`. */
export const operations = new AsyncLocalStorage();

/**
 * Runs `fn` under `label`, inside the operation that is running now: the ops join with ` › `
 * and the conversation is kept unless `label` names its own.
 */
export function withOperation(label, fn) {
  const parent = operations.getStore();
  const store = parent ? { op: `${parent.op} › ${label.op}`, session: label.session ?? parent.session } : label;
  return operations.run(store, fn);
}

/** A session id as Pi writes them (uuid); an app request's first argument is often one. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The label of one app request: its service member and the conversation it is about. */
export function requestLabel(envelope) {
  const call = envelope?.call;
  const op = call && typeof call.serviceId === 'string' ? `${call.serviceId}.${call.member}` : 'request';
  const target = envelope?.target?.sessionId;
  const argument = Array.isArray(call?.args) && typeof call.args[0] === 'string' && SESSION_ID.test(call.args[0]) ? call.args[0] : undefined;
  return { op, session: typeof target === 'string' ? target : argument };
}

/**
 * Labels every app request with `requestLabel`, from the moment it is handled until its answer is
 * encoded and sent, the answer included. `Server` is the pi-server class; its `handleRequest` is
 * the one place every request passes (a test holds this to the installed version).
 */
export function labelRequests(Server) {
  const original = Server?.prototype?.handleRequest;
  if (typeof original !== 'function' || original.labelled) return false;
  const handleRequest = function (state, envelope) { return withOperation(requestLabel(envelope), () => original.call(this, state, envelope)); };
  handleRequest.labelled = true;
  Server.prototype.handleRequest = handleRequest;
  return true;
}

const SAMPLE = Symbol.for('rubato.stall-sample');
const MAX_SAMPLES = 40;

/** One stack line as `function file:line`, the path cut to its last two parts. */
function frame(line) {
  const match = /^\s*at (?:(.*?) \()?(.*?):(\d+):\d+\)?$/.exec(line);
  if (!match) return undefined;
  const [, fn, location, row] = match;
  if (location.startsWith('node:') || location === '<anonymous>') return undefined;
  const file = location.replace(/^file:\/\//, '').split(path.sep).slice(-2).join('/');
  return `${fn || '(anonymous)'} ${file}:${row}`;
}

/** The held code's own frames, innermost first, without this module's. */
export function heldFrames(stack, limit = 3) {
  const frames = [];
  for (const line of String(stack).split('\n').slice(1)) {
    if (line.includes('perf-log.mjs')) continue;
    const value = frame(line);
    if (value) frames.push(value);
    if (frames.length === limit) break;
  }
  return frames;
}

function takeSample(samples) {
  if (samples.length >= MAX_SAMPLES) return;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  samples.push({ label: operations.getStore(), frames: heldFrames(stack) });
}

const count = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

/**
 * What the samples of one stall say held the thread: each operation with its share of the samples,
 * then the most sampled place in the most sampled operation.
 */
export function describeStall(samples, { title = () => undefined } = {}) {
  if (!samples.length) return 'no sample (held outside JavaScript, or the inspector is unavailable)';
  const name = (label) => {
    if (!label) return frames => frames.length ? 'unlabelled' : 'outside JavaScript';
    const titled = label.session ? title(label.session) : undefined;
    const session = label.session ? ` · session ${label.session}${titled ? ` ${JSON.stringify(String(titled).slice(0, 60))}` : ''}` : '';
    return () => `${label.op}${session}`;
  };
  const named = samples.map((sample) => ({ ...sample, name: name(sample.label)(sample.frames) }));
  const ops = count(named.map((sample) => sample.name));
  const [top] = ops[0];
  const [place] = count(named.filter((sample) => sample.name === top && sample.frames.length)
    .map((sample) => sample.frames.join(' < ')))[0] ?? [];
  return `${ops.map(([op, n]) => `${op} (${n}/${samples.length})`).join(', ')}${place ? ` · at ${place}` : ''}`;
}

/**
 * Logs each stretch the event loop could not turn for `thresholdMs` or longer, with what held it
 * (`describeStall`). `sample: false` leaves the watch thread out (tests with a fake clock).
 * `title(sessionId)` names a conversation in the line.
 */
export function watchStalls({ log, thresholdMs = 1000, intervalMs = 200, now = () => performance.now(),
  every = setInterval, stop = clearInterval, sample = true, title, sampleAfterMs = Math.min(500, thresholdMs / 2),
  sampleEveryMs = 250 } = {}) {
  const samples = [];
  globalThis[SAMPLE] = () => takeSample(samples);
  const beat = new Int32Array(new SharedArrayBuffer(4));
  let watcher;
  if (sample) {
    try {
      watcher = new Worker(new URL('./stall-watch-thread.mjs', import.meta.url), {
        workerData: { beat, intervalMs, sampleAfterMs, sampleEveryMs }, stdout: false, stderr: false,
        resourceLimits: { maxOldGenerationSizeMb: 16 } });
      watcher.unref();
      watcher.on('error', () => {});
    } catch { watcher = undefined; }
  }
  let last = now();
  const timer = every(() => {
    Atomics.add(beat, 0, 1);
    const at = now();
    const held = at - last - intervalMs;
    last = at;
    if (held >= thresholdMs) log(`engine stalled ${Math.round(held)}ms — ${describeStall(samples, { title })}`);
    samples.length = 0;
  }, intervalMs);
  timer?.unref?.();
  return () => { stop(timer); void watcher?.terminate(); if (globalThis[SAMPLE]) delete globalThis[SAMPLE]; };
}

/** Opening a conversation or listing a folder's catalogue at or above this is logged. */
export const SLOW_OPEN_MS = 1500;
