#!/usr/bin/env node
// An isolated profile engine + scheduler for trying the whole feature without the user's
// engine or a paid model: the real Pi server (router, socket, JSONL files) with the
// deterministic model child in ./agent.mjs, and the real scheduler daemon.
//
//   node harness/scheduler/test/fixtures/serve-fixture-engine.mjs --root /tmp/sched-e2e
//
// Point a dev T3's rubato-pi descriptor at <root>/agent/server/connection.json and the
// schedule route/CLI at RUBATO_SCHEDULE_HOME=<root>/schedule. Ctrl-C stops both.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSessionServer } from '../../../pi-server/src/host.mjs';
import { RpcWorker } from '../../../pi-server/src/rpc-worker.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'tick-ms': { type: 'string', default: '5000' } } });
if (!values.root) { console.error('usage: serve-fixture-engine.mjs --root <dir>'); process.exit(2); }
const root = path.resolve(values.root);
const agentDir = path.join(root, 'agent');
const scheduleHome = path.join(root, 'schedule');
mkdirSync(path.join(agentDir, 'server'), { recursive: true, mode: 0o700 });
const socketPath = path.join(agentDir, 'server', 'pi.sock');
const agent = fileURLToPath(new URL('./agent.mjs', import.meta.url));
let service;
try {
  service = await startSessionServer({ socketPath, sessionsDir: path.join(agentDir, 'sessions'), idleMs: 60_000,
    workerFactory: (metadata) => new RpcWorker(metadata, { cliPath: agent }), onError: (error) => console.error('engine:', error?.message ?? error) });
} catch (error) {
  // A T3 bridge left attached to this root starts a normal engine here when the fixture one
  // stops. Stop T3 (and that engine) first, then start this launcher, then T3.
  console.error(`Could not start the fixture engine at ${socketPath}: ${error?.message ?? error}\n`
    + 'Another engine owns this root — usually one a still-open T3 started after the fixture engine stopped. '
    + 'Quit T3, stop that engine, start this launcher again, then open T3.');
  process.exit(1);
}
const descriptorPath = path.join(agentDir, 'server', 'connection.json');
writeFileSync(descriptorPath, JSON.stringify({ version: 1, serverId: service.serverId, socketPath }, null, 2) + '\n', { mode: 0o600 });
const daemon = spawn(process.execPath, [fileURLToPath(new URL('../../src/daemon.mjs', import.meta.url)),
  '--root', scheduleHome, '--agent-dir', agentDir, '--tick-ms', values['tick-ms']], { stdio: ['ignore', 'inherit', 'inherit'] });
console.log(JSON.stringify({ descriptorPath, agentDir, scheduleHome, serverId: service.serverId, daemonPid: daemon.pid }));
const stop = async () => { daemon.kill('SIGTERM'); await new Promise((resolve) => daemon.once('exit', resolve)); await service.close(); process.exit(0); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
