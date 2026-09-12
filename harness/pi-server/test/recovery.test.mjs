import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveProfile, readDescriptor } from '../src/profile-server.mjs';
import { SessionClient } from '../src/client.mjs';
import { SessionFiles } from '../src/session-files.mjs';
import { RpcWorker } from '../src/rpc-worker.mjs';
const fixture = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const workers = (metadata) => new RpcWorker(metadata, { cliPath: fixture });

test('profile has one owner across different sockets; restart keeps identity and stored history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-recover-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  let first = await serveProfile({ agentDir: root, workerFactory: workers });
  t.after(() => first.close());
  const client = await new SessionClient(first.descriptor).connect();
  t.after(() => client.close());
  const record = await client.create({ cwd: root, title: 'Restart' });
  await client.attach(record.sessionId);
  const original = await client.snapshot();
  await client.command({ type: 'prompt', message: 'background' });
  await assert.rejects(serveProfile({ agentDir: root, socketPath: path.join(root, 'other.sock'), workerFactory: workers }), /lock/i);
  await client.close(); await first.close();
  const second = await serveProfile({ agentDir: root, workerFactory: workers });
  t.after(() => second.close());
  assert.equal(second.serverId, first.serverId);
  assert.deepEqual(await readDescriptor(second.descriptorPath), second.descriptor);
  const resumed = await new SessionClient(second.descriptor).connect();
  t.after(() => resumed.close());
  assert.equal((await resumed.list()).length, 1);
  assert.deepEqual((await resumed.catalogue(root)).models, []);
  assert.equal((await resumed.list()).length, 1);
  assert.equal(second.host.metrics.runtimeStarts, 0);
  assert.equal((await resumed.transcript(record.sessionId)).messages[0].content, 'background');
  assert.equal(second.host.metrics.runtimeStarts, 0);
  await resumed.attach(record.sessionId);
  assert.notEqual((await resumed.snapshot()).runtimeId, original.runtimeId);
});

test('invalid child stdout fails and physically terminates even if SIGTERM is ignored', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-bad-child-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const metadata = await new SessionFiles(root).create({ cwd: root });
  const bad = path.join(root, 'bad.mjs');
  await writeFile(bad, "process.on('SIGTERM',()=>{});process.stdout.write('null\\n');setInterval(()=>{},1000);");
  const worker = new RpcWorker(metadata, { cliPath: bad, timeoutMs: 3000 });
  await assert.rejects(worker.start(), /Invalid JSON/);
  assert.equal(worker.exited, true);
  assert.throws(() => process.kill(worker.child.pid, 0), { code: 'ESRCH' });
});

test('snapshot watermark is captured at the RPC response, before later events in the same frame', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'rb-boundary-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const metadata = await new SessionFiles(root).create({ cwd: root });
  const script = path.join(root, 'boundary.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);
const data=c.type==='get_state'?{sessionId:${JSON.stringify(metadata.id)}}:{messages:[]};
process.stdout.write(JSON.stringify({id:c.id,type:'response',success:true,data})+'\\n'+
(c.type==='get_messages'?JSON.stringify({type:'agent_start'})+'\\n':''));});`);
  const worker = new RpcWorker(metadata, { cliPath: script });
  t.after(() => worker.stop());
  await worker.start();
  const result = await worker.request({ type: 'get_messages' }, { withBoundary: true });
  assert.equal(result.eventSequence, 0);
  assert.equal(worker.eventSequence, 1);
});
