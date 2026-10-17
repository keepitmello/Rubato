// Worker thread for the Stats page: reads session logs and speed samples off the
// T3 server's event loop. A file is read again only when its size or mtime moved;
// everything else comes from the cache it keeps next to the agent's other caches.
//
// workerData: { agentDir, cacheFile }
// posts: { type: 'progress', done, total } ... then { type: 'done', sessions, speed }
//        or { type: 'error', message }
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parentPort, workerData } from 'node:worker_threads';
import { SUMMARY_VERSION, createSessionSummarizer, summarizeSpeedSamples } from './scan.mjs';
import * as speedIndex from '../../../rubato-pi/src/speed-index.mjs';

const CACHE_VERSION = `${SUMMARY_VERSION}.${speedIndex.SPEED_INDEX_METRIC_VERSION}`;

async function listJsonl(dir) {
  let names;
  try { names = await readdir(dir, { recursive: true }); } catch { return []; }
  return names.filter((name) => name.endsWith('.jsonl')).toSorted();
}

async function summarizeFile(file) {
  const summarizer = createSessionSummarizer();
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (!summarizer.push(line)) break;
  } finally {
    lines.close();
    stream.destroy();
  }
  return summarizer.finish();
}

async function loadCache(file) {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8'));
    if (cache?.version === CACHE_VERSION) return cache;
  } catch { /* first run or a stale format */ }
  return { version: CACHE_VERSION, sessions: {}, speed: {} };
}

async function refresh(dir, held, onFile, read) {
  const next = {};
  for (const name of await listJsonl(dir)) {
    const file = path.join(dir, name);
    let info;
    try { info = await stat(file); } catch { continue; }
    const old = held[name];
    if (old && old.size === info.size && old.mtimeMs === info.mtimeMs) {
      next[name] = old;
    } else {
      try { next[name] = { size: info.size, mtimeMs: info.mtimeMs, value: await read(file) }; } catch { /* vanished mid-read */ }
    }
    onFile();
  }
  return next;
}

async function main() {
  const { agentDir, cacheFile } = workerData;
  const sessionsDir = path.join(agentDir, 'sessions');
  const samplesDir = path.join(agentDir, 'speed-index', 'samples');
  const cache = await loadCache(cacheFile);
  const total = (await listJsonl(sessionsDir)).length + (await listJsonl(samplesDir)).length;
  let done = 0;
  let lastPost = 0;
  const onFile = () => {
    done += 1;
    const now = Date.now();
    if (now - lastPost > 250) { lastPost = now; parentPort.postMessage({ type: 'progress', done, total }); }
  };
  cache.sessions = await refresh(sessionsDir, cache.sessions, onFile, summarizeFile);
  cache.speed = await refresh(samplesDir, cache.speed, onFile, async (file) => summarizeSpeedSamples((await readFile(file, 'utf8')).split('\n'), speedIndex));
  await mkdir(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cache));
  await rename(tmp, cacheFile);
  const sessions = {};
  for (const [name, entry] of Object.entries(cache.sessions)) if (entry.value) sessions[name] = entry.value;
  const speed = [];
  for (const entry of Object.values(cache.speed)) for (const row of entry.value ?? []) speed.push(row);
  parentPort.postMessage({ type: 'done', sessions, speed });
}

main().catch((error) => parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
