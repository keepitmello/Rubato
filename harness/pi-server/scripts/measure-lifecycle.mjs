#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { serveProfile } from '../src/profile-server.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
import { SessionClient } from '../src/client.mjs';

const fixture = fileURLToPath(new URL('../test/fixtures/rpc.mjs', import.meta.url));
const elapsed = async (fn) => {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
};

const root = await mkdtemp(path.join(tmpdir(), 'rubato-pi-measure-'));
const workerFactory = (metadata) => new RpcWorker(metadata, { cliPath: fixture });
let service;
let client;
try {
  const coldStart = await elapsed(async () => {
    service = await serveProfile({ agentDir: root, idleMs: 60_000, workerFactory });
    client = await new SessionClient(service.descriptor).connect();
  });
  const stored = [];
  for (let index = 0; index < 100; index += 1) stored.push(await client.create({ cwd: root, title: `Stored ${index}` }));
  const listStored = await elapsed(() => client.list());
  const runtimesAfterList = listStored.value.filter((entry) => entry.runtimeId !== null).length;

  const coldAttach = await elapsed(async () => {
    await client.attach(stored[0].sessionId);
    return client.snapshot();
  });
  const firstRuntimeId = coldAttach.value.runtimeId;
  await client.detach();
  const warmAttach = await elapsed(async () => {
    await client.attach(stored[0].sessionId);
    return client.snapshot();
  });
  const sameWarmRuntime = warmAttach.value.runtimeId === firstRuntimeId;

  await client.detach();
  const switchSession = await elapsed(async () => {
    await client.attach(stored[1].sessionId);
    return client.snapshot();
  });
  const rssWithTwoRuntimes = process.memoryUsage().rss;
  const runtimeStartsBeforeRestart = service.host.metrics.runtimeStarts;

  await client.close();
  await service.close();
  client = undefined;
  service = undefined;

  const restartResume = await elapsed(async () => {
    service = await serveProfile({ agentDir: root, idleMs: 60_000, workerFactory });
    client = await new SessionClient(service.descriptor).connect();
    const list = await client.list();
    await client.attach(stored[0].sessionId);
    const snapshot = await client.snapshot();
    return { listCount: list.length, runtimeId: snapshot.runtimeId };
  });

  console.log(JSON.stringify({
    schema: 1,
    kind: 'synthetic-control-path',
    note: 'Uses the real Rubato Pi server/client/process lifecycle with a deterministic fixture worker; it does not measure model or first-token latency.',
    node: process.version,
    storedSessions: 100,
    serverColdStartMs: coldStart.ms,
    storedListMs: listStored.ms,
    runtimesAfterStoredList: runtimesAfterList,
    coldStoredAttachMs: coldAttach.ms,
    warmAttachMs: warmAttach.ms,
    warmAttachKeptRuntime: sameWarmRuntime,
    sessionSwitchMs: switchSession.ms,
    runtimeStartsBeforeRestart,
    parentRssBytesWithTwoRuntimes: rssWithTwoRuntimes,
    restartAndStoredResumeMs: restartResume.ms,
    storedSessionsAfterRestart: restartResume.value.listCount,
  }, null, 2));
} finally {
  await client?.close().catch(() => {});
  await service?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
