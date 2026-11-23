#!/usr/bin/env node
// Runs the engine's main user flows against an aged profile (aged-profile.mjs) on an isolated engine
// and prints, per flow, what it cost the engine's one thread (harness/bench/README.md).
//
//   node harness/bench/engine-flows.mjs --profile /tmp/rubato-aged [--flows a,b] [--repeat 3] [--json out.json]
//
// The engine is this checkout's (harness/pi-server/src/cli.mjs) on the profile's agent dir, its own
// socket and HOME, and no resident services: nothing it does reaches the person's profile, homes or
// providers. Its only model is the scripted one (scripted-model.mjs).
//
// Per flow:
//   held   main-thread time the flow kept the engine's event loop busy (event-loop utilization
//          `active`, read inside the engine). The primary number: it is what every other
//          conversation and app request waited for, and it holds still when the Mac is busy.
//   longest  the longest single stretch the loop could not turn (monitorEventLoopDelay max)
//   wall   time the client waited;  cpu  process CPU, every thread;  bytes  what the socket carried
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startScriptedModel, WINDOW_CHANGE } from './scripted-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../pi-server/src/cli.mjs');

/**
 * Budgets: main-thread ms a flow may hold the engine (`held`, median), proposed from the
 * measurements in case-studies/team-runs/2026-11-21-flow-performance-qa/engine-results.md. A flow
 * whose median is over its budget is marked OVER.
 */
export const BUDGETS = Object.freeze({
  'engine start': 1500,
  'engine start + resume 5': 3000,
  'idle (per second)': 20,
  'idle, 5 loaded (per second)': 30,
  'directory list': 50,
  'directory subscribe': 100,
  catalogue: 400,
  'open small (attach)': 300,
  'snapshot small': 50,
  'open large (attach)': 1000,
  'snapshot large': 500,
  'open companion (attach)': 1000,
  'snapshot companion': 500,
  'transcript whole (companion)': 600,
  'transcript since 1h (companion)': 50,
  'backfill pass (companion, since 10m)': 50,
  'turn with a tool call (large)': 600,
  'turn with a tool call (companion)': 600,
  'window change (large)': 800,
});

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the engine's own numbers, read through its inspector ----
const PROBE = `(() => {
  const ph = process.getBuiltinModule('node:perf_hooks');
  const g = globalThis.__rubatoBench ??= { h: ph.monitorEventLoopDelay({ resolution: 5 }) };
  if (!g.on) { g.h.enable(); g.on = true; }
  const e = ph.performance.eventLoopUtilization(); const c = process.cpuUsage(); const m = process.memoryUsage();
  const r = { active: e.active, cpu: (c.user + c.system) / 1000, longest: g.h.max / 1e6, rss: m.rss, heap: m.heapUsed, t: ph.performance.now() };
  g.h.reset(); return JSON.stringify(r);
})()`;

class Inspector {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`inspector ${url} unreachable`)); });
    return new Inspector(socket);
  }
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
    };
  }
  post(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async probe() {
    const { result, exceptionDetails } = await this.post('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'probe failed');
    return JSON.parse(result.value);
  }
  close() { try { this.socket.close(); } catch {} }
}

// ---- what the socket carries ----
function countingProxy(target, listenPath) {
  const bytes = { in: 0, out: 0 };
  const server = createServer((client) => {
    const engine = connect(target);
    client.on('data', (chunk) => { bytes.out += chunk.length; engine.write(chunk); });
    engine.on('data', (chunk) => { bytes.in += chunk.length; client.write(chunk); });
    const end = () => { client.destroy(); engine.destroy(); };
    client.on('close', end); engine.on('close', end); client.on('error', end); engine.on('error', end);
  });
  return new Promise((resolve, reject) => {
    rmSync(listenPath, { force: true });
    server.once('error', reject);
    server.listen(listenPath, () => resolve({ bytes, close: () => new Promise((done) => server.close(() => done())) }));
  });
}

// ---- the isolated engine ----
/** The environment of an isolated engine: the profile's HOME, none of the person's companion, memory or engine settings. */
export function isolatedEnv(manifest, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(RUBATO|PI_|ROO_|MSEARCH_|SENPI|CLAUDE|T3)/.test(key)));
  // The role prompts are read from this checkout, as the person's install links them.
  return { ...env, HOME: manifest.home, RUBATO_COMPANIONS_FILE: path.join(manifest.home, '.rubato', 'companions.json'), PI_OFFLINE: '1',
    RUBATO_PROMPTS_DIR: path.resolve(here, '../prompts') };
}

/**
 * Starts the engine on the profile. Resolves when it serves: its descriptor, inspector, log lines
 * and how long the start took. `runtimeRoot` is the engine build (default: the installed one).
 */
export async function startIsolatedEngine({ manifest, runtimeRoot, socketPath, log = () => {}, inspect = true }) {
  const began = performance.now();
  const child = spawn(process.execPath, [...(inspect ? ['--inspect=127.0.0.1:0'] : []), CLI, '--agent-dir', manifest.agentDir, '--socket', socketPath,
    '--idle-ms', 'never', '--runtime-root', runtimeRoot], { env: isolatedEnv(manifest), stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let descriptor;
  let inspectorUrl;
  const ready = new Promise((resolve, reject) => {
    const take = (stream, onLine) => { let rest = ''; stream.setEncoding('utf8'); stream.on('data', (chunk) => {
      rest += chunk; const parts = rest.split('\n'); rest = parts.pop(); for (const line of parts) onLine(line); }); };
    take(child.stdout, (line) => {
      if (!descriptor && line.startsWith('{')) { try { descriptor = JSON.parse(line); } catch {} if (descriptor) resolve(); return; }
      lines.push(line); log(line);
    });
    take(child.stderr, (line) => {
      const match = /Debugger listening on (ws:\/\/\S+)/.exec(line);
      if (match) inspectorUrl = match[1];
      else if (!/For help, see|Debugger attached|Waiting for the debugger/.test(line)) { lines.push(line); log(line); }
    });
    child.once('exit', (code) => reject(new Error(`engine exited (${code}) before serving:\n${lines.slice(-20).join('\n')}`)));
  });
  await ready;
  const startMs = performance.now() - began;
  const inspector = inspect ? await Inspector.connect(inspectorUrl) : undefined;
  return { child, descriptor, inspector, lines, startMs,
    async stop() {
      inspector?.close();
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      await exited; clearTimeout(timer);
    } };
}

// ---- flows ----
async function waitForStatus(client, want, { timeoutMs = 120_000 } = {}) {
  const began = Date.now();
  for (;;) {
    const state = await client.command({ type: 'get_state' });
    if (want(state)) return state;
    if (Date.now() - began > timeoutMs) throw new Error(`timed out waiting for the session (last state ${JSON.stringify(state).slice(0, 300)})`);
    await sleep(50);
  }
}

/** Runs the bench and returns its rows, the engine's stall lines and the scripted model's counts. */
export async function runBench({ profile, runtimeRoot, flows: only, repeat = 3, idleSeconds = 20, verbose = false, cpuProfiles,
  log = (line) => console.error(line) }) {
  const manifest = JSON.parse(readFileSync(path.join(profile, 'manifest.json'), 'utf8'));
  const { SessionClient } = await import('../pi-server/src/client.mjs');
  runtimeRoot ??= (await import('../pi-server/src/discovery.mjs')).installedSharedRuntime();
  if (!runtimeRoot) throw new Error('No engine build found; pass --runtime-root');
  const model = await startScriptedModel({ port: manifest.options.modelPort });
  const socketPath = `/tmp/rbench-${process.pid}.sock`;
  const proxyPath = `/tmp/rbench-${process.pid}-p.sock`;
  const rows = [];
  const want = (name) => !only || only.some((flow) => name.startsWith(flow));
  const stalls = [];
  const engineLog = (line) => { if (verbose) log(`engine: ${line}`); if (/engine stalled|opened in|catalogue .* in/.test(line)) stalls.push(line); };
  let engine;
  let proxy;
  let client;
  const record = (name, samples) => {
    const pickMedian = (key) => median(samples.map((sample) => sample[key]));
    const row = { flow: name, held: pickMedian('held'), longest: pickMedian('longest'), wall: pickMedian('wall'), cpu: pickMedian('cpu'),
      bytes: pickMedian('bytes'), runs: samples.length, samples, budget: BUDGETS[name] };
    row.over = row.budget !== undefined && row.held > row.budget;
    rows.push(row);
    log(`${name}: held ${row.held.toFixed(0)}ms (longest ${row.longest.toFixed(0)}ms) wall ${row.wall.toFixed(0)}ms cpu ${row.cpu.toFixed(0)}ms bytes ${row.bytes}${row.over ? '  OVER' : ''}`);
    return row;
  };
  // `cpuProfiles`: a V8 CPU profile of the engine per measured run, written there (the sampling
  // inflates `held`; profile in a separate run). cpu-profile-summary.mjs reads them.
  let measured = 0;
  const measure = async (fn, name = 'flow') => {
    if (cpuProfiles) { await engine.inspector.post('Profiler.enable'); await engine.inspector.post('Profiler.setSamplingInterval', { interval: 250 }); await engine.inspector.post('Profiler.start'); }
    const before = await engine.inspector.probe();
    const bytes = proxy.bytes.in + proxy.bytes.out;
    const began = performance.now();
    await fn();
    const wall = performance.now() - began;
    const after = await engine.inspector.probe();
    if (cpuProfiles) {
      const { profile: cpu } = await engine.inspector.post('Profiler.stop');
      mkdirSync(cpuProfiles, { recursive: true });
      writeFileSync(path.join(cpuProfiles, `${String(++measured).padStart(2, '0')}-${name.replace(/[^\w]+/g, '-')}.cpuprofile`), JSON.stringify(cpu));
    }
    return { held: after.active - before.active, longest: after.longest, wall, cpu: after.cpu - before.cpu,
      bytes: proxy.bytes.in + proxy.bytes.out - bytes };
  };
  const flow = async (name, fn, { setup, teardown, times = repeat } = {}) => {
    if (!want(name)) return;
    const samples = [];
    try {
      for (let i = 0; i < times; i += 1) {
        const context = await setup?.();
        try { samples.push(await measure(() => fn(context), name)); } finally { await teardown?.(context); }
      }
    } catch (error) {
      log(`${name}: FAILED ${error?.message ?? error}`);
      rows.push({ flow: name, error: String(error?.message ?? error), budget: BUDGETS[name] });
      return;
    }
    return record(name, samples);
  };
  const start = async ({ resume = [] } = {}) => {
    const resumeFile = path.join(manifest.agentDir, 'server', 'resume.json');
    if (resume.length) {
      mkdirSync(path.dirname(resumeFile), { recursive: true });
      writeFileSync(resumeFile, JSON.stringify({ version: 1, writtenAt: Date.now(), sessions: resume.map((sessionId) => ({ sessionId, continue: false })) }));
    } else rmSync(resumeFile, { force: true });
    engine = await startIsolatedEngine({ manifest, runtimeRoot, socketPath, log: engineLog });
    proxy = await countingProxy(socketPath, proxyPath);
    client = await new SessionClient({ socketPath: proxyPath, serverId: engine.descriptor.serverId, sessionTimeoutMs: 300_000 }).connect();
  };
  const stop = async () => { await client?.close().catch(() => {}); await proxy?.close(); await engine?.stop(); client = proxy = engine = undefined; };
  const { small, large, companion, recent } = manifest.conversations;
  const largest = large[0];
  const open = (id) => async () => { await client.attach(id); };
  const close = (id) => async () => { await client.detach().catch(() => {}); await client.unload(id).catch(() => {}); };
  const perSecond = (sample) => ({ ...sample, held: sample.held / idleSeconds, cpu: sample.cpu / idleSeconds, wall: sample.wall / idleSeconds, bytes: sample.bytes / idleSeconds });

  try {
    // Engine start, cold and with conversations to take up again after a restart.
    for (const [name, resume] of [['engine start', []], ['engine start + resume 5', recent.slice(-5).map((item) => item.id)]]) {
      if (!want(name)) continue;
      const samples = [];
      for (let i = 0; i < repeat; i += 1) {
        const began = performance.now();
        await start({ resume });
        while (resume.length && (await client.list()).filter((item) => resume.includes(item.sessionId) && item.runtimeId).length < resume.length) await sleep(100);
        const probe = await engine.inspector.probe();
        samples.push({ held: probe.active, longest: probe.longest, wall: performance.now() - began, cpu: probe.cpu, bytes: 0 });
        if (i < repeat - 1) await stop();
      }
      record(name, samples);
      if (resume.length && want('idle, 5 loaded')) {
        await sleep(3000);
        record('idle, 5 loaded (per second)', [perSecond(await measure(() => sleep(idleSeconds * 1000), 'idle-5-loaded'))]);
      }
      await stop();
    }
    await start();
    if (want('idle (per second)')) {
      await sleep(3000);
      record('idle (per second)', [perSecond(await measure(() => sleep(idleSeconds * 1000), 'idle'))]);
    }
    await flow('directory list', () => client.list());
    await flow('directory subscribe', async () => { const stopListening = await client.subscribeDirectory(() => {}); await stopListening(); });
    await flow('catalogue', () => client.catalogue(small?.cwd ?? manifest.work));
    for (const [label, item] of [['small', small], ['large', largest], ['companion', companion]]) {
      if (!item) continue;
      await flow(`open ${label} (attach)`, open(item.id), { teardown: close(item.id) });
      await flow(`snapshot ${label}`, () => client.snapshot(), { setup: open(item.id), teardown: close(item.id) });
    }
    if (companion) {
      await flow('transcript whole (companion)', () => client.transcript(companion.id));
      await flow('transcript since 1h (companion)', () => client.transcript(companion.id, { since: Date.now() - 3_600_000 }));
      await flow('backfill pass (companion, since 10m)', () => client.transcript(companion.id, { since: Date.now() - 600_000 }));
    }
    // A turn as the app runs it: the conversation attached and watched, one tool call, a streamed reply.
    // The window change is the notes mode's compaction: the model saves now.md and calls new_context.
    const turns = [['turn with a tool call (large)', largest, 'bench: run one tool, then answer'],
      ['turn with a tool call (companion)', companion, 'bench: run one tool, then answer'],
      ['window change (large)', largest, `${WINDOW_CHANGE} bench: save the note and change the window`]];
    for (const [name, item, message] of turns) {
      if (!item || !want(name)) continue;
      await client.attach(item.id);
      const stopListening = await client.subscribeSession(() => {});
      await flow(name, async () => {
        await client.command({ type: 'prompt', message });
        await waitForStatus(client, (state) => !state.isStreaming && !state.isCompacting && !state.pendingMessageCount);
      });
      await stopListening(); await close(item.id)();
    }
  } finally {
    await stop().catch(() => {});
    await model.close();
    rmSync(proxyPath, { force: true });
  }
  return { rows, stalls, model: model.stats, runtimeRoot, manifest: { options: manifest.options, totals: manifest.totals } };
}

export function formatTable(rows) {
  const header = ['flow', 'held ms', 'longest ms', 'wall ms', 'cpu ms', 'bytes', 'budget', ''];
  const body = rows.map((row) => row.error ? [row.flow, 'failed', '', '', '', '', row.budget === undefined ? '-' : String(row.budget), row.error.slice(0, 60)] : [row.flow, row.held.toFixed(0), row.longest.toFixed(0), row.wall.toFixed(0), row.cpu.toFixed(0),
    String(Math.round(row.bytes)), row.budget === undefined ? '-' : String(row.budget), row.over ? 'OVER' : '']);
  const widths = header.map((cell, i) => Math.max(cell.length, ...body.map((line) => line[i].length)));
  const line = (cells) => `| ${cells.map((cell, i) => (i ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join(' | ')} |`;
  return [line(header), `|${widths.map((width, i) => (i ? `${'-'.repeat(width + 1)}:` : '-'.repeat(width + 2))).join('|')}|`, ...body.map(line)].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, 'runtime-root': { type: 'string' }, flows: { type: 'string' },
    repeat: { type: 'string' }, 'idle-seconds': { type: 'string' }, json: { type: 'string' }, verbose: { type: 'boolean' }, 'cpu-profiles': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !values.profile) {
    console.log('Usage: node harness/bench/engine-flows.mjs --profile /absolute/aged-profile [--runtime-root /engine/build] [--flows "open large,turn"] [--repeat 3] [--idle-seconds 20] [--json out.json] [--cpu-profiles dir] [--verbose]');
    process.exitCode = values.profile ? 0 : 1;
  } else {
    const result = await runBench({ profile: path.resolve(values.profile), runtimeRoot: values['runtime-root'],
      flows: values.flows?.split(',').map((flow) => flow.trim()).filter(Boolean), repeat: Number(values.repeat ?? 3),
      idleSeconds: Number(values['idle-seconds'] ?? 20), verbose: values.verbose,
      cpuProfiles: values['cpu-profiles'] && path.resolve(values['cpu-profiles']) });
    console.log(formatTable(result.rows));
    if (result.stalls.length) console.log(`\nengine log during the bench:\n${result.stalls.join('\n')}`);
    if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
  }
}
