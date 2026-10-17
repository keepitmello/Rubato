// The Stats page's server half. The T3 server loads this module from the Rubato
// checkout (next to bridge.mjs) and forwards `/rubato/stats/<action>` to it.
//
// What it reads, never writes:
//   <agentDir>/sessions/**/*.jsonl               session logs (scan.mjs)
//   <agentDir>/speed-index/samples/*.jsonl       speed samples, scored like the composer's Speed index
// What it keeps:
//   <agentDir>/cache/stats/scan-v1.json          one summary per file, reused while size and mtime hold
//   <agentDir>/cache/stats/explanations-v1.json  the longest-think cards, written once per record
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveSpeedIndexAgentDir } from '../../../rubato-pi/src/speed-index-store.mjs';
import { loadTitleModels } from '../../../pi-runtime/features/session-title/session-title.mjs';
import { aggregateStats } from './aggregate.mjs';
import { createExplainer, readThinking, runPrint, stockEngineLaunch } from './explain.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
// A summary request waits this long for a rescan before answering with the last result.
const FRESH_WAIT_MS = 1500;
// A record whose card failed is tried again after this long, not on every visit.
const RETRY_FAILED_MS = 6 * 60 * 60 * 1000;

export class StatsRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, agentDir?: string, now?: () => number,
 *   explain?: (input: object) => Promise<object>, scan?: () => Promise<{sessions: object, speed: Array}> }} [options]
 *   `scan` replaces the worker (tests); `explain` replaces the model call.
 */
export function createStatsService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const agentDir = options.agentDir ?? resolveSpeedIndexAgentDir(env, home) ?? path.join(home, '.rubato-pi', 'agent');
  const cacheDir = path.join(agentDir, 'cache', 'stats');
  const explanationsFile = path.join(cacheDir, 'explanations-v1.json');
  const now = options.now ?? (() => Date.now());
  const childEnv = { ...env, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'share', 'vite-plus', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };
  const explain = options.explain ?? createExplainer({
    run: async (request) => runPrint({ launch: await stockEngineLaunch(repoRoot, childEnv), env: childEnv, ...request }),
    models: () => loadTitleModels({ home }),
  });
  const progress = { done: 0, total: 0 };
  const scanFiles = options.scan ?? (() => runWorker({ agentDir, cacheFile: path.join(cacheDir, 'scan-v1.json') }, progress));

  let result = null;
  let scanning = null;
  let explanations = null;
  const explaining = new Set();
  const failed = new Map();

  const loadExplanations = async () => {
    if (explanations) return explanations;
    try { explanations = JSON.parse(await readFile(explanationsFile, 'utf8')); } catch { explanations = {}; }
    return explanations;
  };
  const saveExplanations = async () => {
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${explanationsFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(explanations, null, 1));
    await rename(tmp, explanationsFile);
  };

  const scan = () => {
    scanning ??= scanFiles()
      .then(({ sessions, speed }) => {
        result = aggregateStats(sessions, speed, { now: now(), home });
        return result;
      })
      .finally(() => { scanning = null; });
    return scanning;
  };

  const writeCard = async (key, think) => {
    explaining.add(key);
    try {
      const [name, entryId] = [key.slice(0, key.lastIndexOf('#')), key.slice(key.lastIndexOf('#') + 1)];
      const source = await readThinking(path.join(agentDir, 'sessions', name), entryId);
      if (!source) throw new Error('the thinking block is gone');
      const card = await explain({ ...source, title: think.title, model: think.model });
      (await loadExplanations())[key] = { ...card, writtenAt: new Date(now()).toISOString() };
      await saveExplanations();
      failed.delete(key);
    } catch (error) {
      failed.set(key, now());
      console.warn(`[rubato stats] longest-think card for ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      explaining.delete(key);
    }
  };

  /** Attaches each period's card, and starts writing the ones that are missing. */
  const withCards = async (stats) => {
    const cards = await loadExplanations();
    const periods = {};
    for (const [name, period] of Object.entries(stats.periods)) {
      const think = period.think;
      if (!think) { periods[name] = period; continue; }
      let state = 'unavailable';
      const card = think.key ? cards[think.key] ?? null : null;
      if (card) state = 'ready';
      else if (think.key) {
        const lastFailure = failed.get(think.key);
        if (explaining.has(think.key)) state = 'writing';
        else if (lastFailure === undefined || now() - lastFailure > RETRY_FAILED_MS) {
          state = 'writing';
          void writeCard(think.key, think);
        }
      }
      const { key: _key, ...shown } = think;
      periods[name] = { ...period, think: { ...shown, card: card ? { headline: card.headline, body: card.body, chips: card.chips } : null, cardState: state } };
    }
    return { ...stats, periods };
  };

  return {
    agentDir,
    async handle(action) {
      if (action !== 'summary') throw new StatsRequestError(404, 'unknown-action', `Unknown stats action: ${action}`);
      let fresh = null;
      let failure = null;
      await Promise.race([
        scan().then((value) => { fresh = value; }, (error) => { failure = error; }),
        new Promise((resolve) => setTimeout(resolve, FRESH_WAIT_MS)),
      ]);
      if (!fresh && !result) {
        if (failure) throw new StatsRequestError(500, 'scan-failed', failure instanceof Error ? failure.message : String(failure));
        return { status: 'scanning', progress: { ...progress } };
      }
      return { status: 'ready', refreshing: !fresh, ...(await withCards(fresh ?? result)) };
    },
  };
}

function runWorker(workerData, progress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./scan-worker.mjs', import.meta.url), { workerData });
    worker.on('message', (message) => {
      if (message.type === 'progress') { progress.done = message.done; progress.total = message.total; }
      else if (message.type === 'done') resolve(message);
      else if (message.type === 'error') reject(new Error(message.message));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`stats scan exited ${code}`)); });
  });
}

/**
 * One HTTP exchange: `/rubato/stats/<action>`, JSON out. POST is what the page's
 * shared Rubato request helper sends; GET is for a person poking at it.
 */
export async function handleStatsRequest(service, request) {
  if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: { code: 'method', message: 'Use GET or POST.' } }, { status: 405 });
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  try {
    return Response.json(await service.handle(action));
  } catch (error) {
    const status = error instanceof StatsRequestError ? error.status : 500;
    const code = error instanceof StatsRequestError ? error.code : 'failed';
    return Response.json({ error: { code, message: error instanceof Error ? error.message : String(error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function statsService() {
  shared ??= createStatsService();
  return shared;
}
