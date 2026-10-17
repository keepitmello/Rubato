// The Stats page's server half. The T3 server loads this module from the Rubato
// checkout (next to bridge.mjs) and forwards `/rubato/stats/<action>` to it.
//
// What it reads, never writes:
//   <agentDir>/sessions/**/*.jsonl               session logs (scan.mjs)
//   <agentDir>/speed-index/samples/*.jsonl       speed samples, scored like the composer's Speed index
// What it keeps:
//   <agentDir>/cache/stats/scan-v1.json          one summary per file, reused while size and mtime hold
//   <agentDir>/cache/stats/stories-v1.json       episode stories, written once per moment
//
// Nothing here makes the page wait on a model: a `summary` answers with every episode in
// plain English and starts the stories in the background, one at a time, which the page
// picks up on its next poll. `warm` only reads the logs, so the first visit is quick.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveSpeedIndexAgentDir } from '../../../rubato-pi/src/speed-index-store.mjs';
import { loadTitleModels } from '../../../pi-runtime/features/session-title/session-title.mjs';
import { aggregateStats } from './aggregate.mjs';
import { fallbackStory } from './episodes.mjs';
import { createStoryWriter, readThinking, runPrint, stockEngineLaunch } from './stories.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
// A summary request waits this long for a rescan before answering with the last result.
const FRESH_WAIT_MS = 1500;
// A moment whose story failed is tried again after this long, not on every visit.
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
 *   write?: (episode: object, material: object) => Promise<object>, scan?: () => Promise<{sessions: object, speed: Array}> }} [options]
 *   `scan` replaces the worker (tests); `write` replaces the model call.
 */
export function createStatsService(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const agentDir = options.agentDir ?? resolveSpeedIndexAgentDir(env, home) ?? path.join(home, '.rubato-pi', 'agent');
  const cacheDir = path.join(agentDir, 'cache', 'stats');
  const storiesFile = path.join(cacheDir, 'stories-v1.json');
  const now = options.now ?? (() => Date.now());
  const childEnv = { ...env, PATH: [
    path.join(home, '.bun', 'bin'), path.join(home, '.local', 'share', 'vite-plus', 'bin'), path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin',
  ].join(path.delimiter) };
  const write = options.write ?? createStoryWriter({
    run: async (request) => runPrint({ launch: await stockEngineLaunch(repoRoot, childEnv), env: childEnv, ...request }),
    models: () => loadTitleModels({ home }),
  });
  const progress = { done: 0, total: 0 };
  const scanFiles = options.scan ?? (() => runWorker({ agentDir, cacheFile: path.join(cacheDir, 'scan-v1.json') }, progress));

  let result = null;
  let scanning = null;
  let stories = null;
  const queue = [];
  let writing = null;
  const failed = new Map();

  const loadStories = async () => {
    if (stories) return stories;
    try { stories = JSON.parse(await readFile(storiesFile, 'utf8')); } catch { stories = {}; }
    return stories;
  };
  const saveStories = async () => {
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${storiesFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(stories, null, 1));
    await rename(tmp, storiesFile);
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

  const writeStory = async (episode) => {
    const material = { language: episode._language };
    if (episode.kind === 'mind' && episode._entryId) {
      material.thinking = await readThinking(path.join(agentDir, 'sessions', episode._file), episode._entryId);
      if (!material.thinking) throw new Error('the thinking block is gone');
    }
    const story = await write(episode, material);
    (await loadStories())[episode.id] = { headline: story.headline, story: story.story, model: story.model, writtenAt: new Date(now()).toISOString() };
    await saveStories();
  };

  /** Writes queued stories one at a time, so a page full of episodes is one model call at a time. */
  const drain = () => {
    writing ??= (async () => {
      while (queue.length > 0) {
        const episode = queue[0];
        try {
          await writeStory(episode);
          failed.delete(episode.id);
        } catch (error) {
          failed.set(episode.id, now());
          console.warn(`[rubato stats] story for ${episode.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        queue.shift();
      }
    })().finally(() => { writing = null; });
  };

  /** Gives every episode its words: the written story when there is one, else plain English, and queues the rest. */
  const withStories = async (stats) => {
    const written = await loadStories();
    const periods = {};
    for (const [name, period] of Object.entries(stats.periods)) {
      const shown = period.episodes.map((episode) => {
        const story = written[episode.id];
        let storyState = story ? 'written' : 'plain';
        if (!story) {
          const lastFailure = failed.get(episode.id);
          if (queue.some((queued) => queued.id === episode.id)) storyState = 'writing';
          else if (lastFailure === undefined || now() - lastFailure > RETRY_FAILED_MS) {
            queue.push(episode);
            storyState = 'writing';
          }
        }
        const { _file, _entryId, _language, ...visible } = episode;
        const words = story ? { headline: story.headline, story: story.story } : fallbackStory(episode);
        return { ...visible, ...words, storyState };
      });
      periods[name] = { ...period, episodes: shown };
    }
    if (queue.length > 0) drain();
    return { ...stats, periods };
  };

  return {
    agentDir,
    async handle(action) {
      if (action === 'warm') {
        // Read the logs ahead of the first visit; no model calls happen here.
        scan().catch(() => {});
        return { status: result ? 'ready' : 'scanning' };
      }
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
      return { status: 'ready', refreshing: !fresh, ...(await withStories(fresh ?? result)) };
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
