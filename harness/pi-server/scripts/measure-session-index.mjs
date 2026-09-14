// Read-only, explicit corpus. Never opens a SessionManager, calls a model,
// connects to the live server, or writes the user's sessions/configuration.
import fs from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { SessionFiles } from '../src/session-files.mjs';
import { createSessionHost } from '../src/host.mjs';

const { values } = parseArgs({ options: {
  'sessions-dir': { type: 'string' }, mode: { type: 'string', default: 'index' },
  samples: { type: 'string', default: '5' }, 'idle-ms': { type: 'string', default: '0' },
} });
if (!values['sessions-dir'] || !path.isAbsolute(values['sessions-dir'])) throw new Error('--sessions-dir must be an explicit absolute existing directory');
if (!['legacy', 'index'].includes(values.mode)) throw new Error('--mode must be legacy or index');
const root = await realpath(values['sessions-dir']);
if (!(await stat(root)).isDirectory()) throw new Error('Expected existing session directory');
const samples = Number(values.samples), idleMs = Number(values['idle-ms']);
if (!Number.isInteger(samples) || samples < 1 || samples > 20 || !Number.isInteger(idleMs) || idleMs < 0 || idleMs > 120000) throw new Error('Invalid measurement limits');
if (idleMs && values.mode !== 'index') throw new Error('--idle-ms measures the current host only; use index mode');

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const folders = async () => [root, ...(await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))];
async function corpus() {
  const fingerprints = [];
  for (const dir of await folders()) {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const value = await stat(file, { bigint: true }).catch(() => null);
      if (value?.isFile()) fingerprints.push([file, ...[value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String)]);
    }
  }
  return { files: fingerprints.length, bytes: fingerprints.reduce((sum, row) => sum + Number(row[3]), 0), fingerprint: digest(fingerprints) };
}
async function legacyList() {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const infos = (await Promise.all((await folders()).map((dir) => SessionManager.listAll(dir)))).flat();
  const result = [];
  for (const info of infos) {
    const file = await realpath(info.path).catch(() => null);
    if (file?.startsWith(root + path.sep)) result.push({ id: info.id, file, cwd: info.cwd,
      title: info.name || info.firstMessage || 'New session', createdAt: info.created.getTime(),
      modifiedAt: info.modified.getTime(), messageCount: info.messageCount });
  }
  return result.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
let streams = 0, bytes = 0;
const original = fs.createReadStream;
fs.createReadStream = function (...args) {
  const stream = original.apply(this, args);
  if (String(args[0]).endsWith('.jsonl')) {
    streams++;
    stream.once('close', () => { bytes += stream.bytesRead; });
  }
  return stream;
};
syncBuiltinESMExports();
const store = new SessionFiles(root);
const list = values.mode === 'legacy' ? legacyList : () => store.list();
// Match the old module graph without charging its import to just the first
// legacy list; index mode deliberately never loads the agent SDK at all.
if (values.mode === 'legacy') await import('@earendil-works/pi-coding-agent');
const before = await corpus();
const rows = [];
for (let i = 0; i < samples; i++) {
  global.gc?.();
  streams = 0; bytes = 0;
  const memoryBefore = process.memoryUsage();
  const start = performance.now(), cpu = process.cpuUsage();
  const records = await list();
  const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
  rows.push({ iteration: i, sessions: records.length, elapsedMs, cpuMs: (used.user + used.system) / 1000,
    readStreams: streams, applicationReadBytes: bytes, memoryBefore, memoryAfter: process.memoryUsage(), metadataDigest: digest(records) });
}
let idle;
if (idleMs) {
  const host = createSessionHost({ sessionsDir: root, serverId: 'read-only-measurement', pollMs: 2000,
    workerFactory() { throw new Error('A directory measurement must never start a worker'); } });
  try {
    await host.start(); global.gc?.();
    streams = 0; bytes = 0;
    const revision = host.directory.value.revision, lists = host.metrics.lists;
    const memoryBefore = process.memoryUsage();
    const start = performance.now(), cpu = process.cpuUsage();
    await delay(idleMs);
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    const cpuMs = (used.user + used.system) / 1000;
    idle = { elapsedMs, cpuMs, oneCorePercent: 100 * cpuMs / elapsedMs, readStreams: streams,
      applicationReadBytes: bytes, lists: host.metrics.lists - lists, revisions: host.directory.value.revision - revision,
      runtimeStarts: host.metrics.runtimeStarts, memoryBefore, memoryAfter: process.memoryUsage() };
  } finally { await host.close(); }
}
const after = await corpus();
console.log(JSON.stringify({ node: process.version, kind: 'read-only-session-index', mode: values.mode,
  corpusBefore: before, corpusAfter: after, corpusStable: before.fingerprint === after.fingerprint, rows, idle,
  limitations: 'Separate observer process, application IO not physical disk IO, warm filesystem likely. Idle measures current host without T3, sockets or model workers. Compare metadata digests only when corpus fingerprints match; no live service was replaced.' }, null, 2));
