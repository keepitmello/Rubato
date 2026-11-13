import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCallLog, RING_MS } from '../calls.mjs';
import { exposeOnTailnet, startTailnetExposure } from '../remote.mjs';

const HOST = 'mac.tail1234.ts.net';
// A stand-in for the Tailscale CLI: `status --json`, `serve status --json` and `serve --bg …`.
function cli({ backend = 'Running', web = {}, tcp = {}, funnel } = {}) {
  const calls = [];
  const run = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return JSON.stringify({ BackendState: backend, Self: { DNSName: `${HOST}.` } });
    if (args.join(' ') === 'serve status --json') return JSON.stringify({ TCP: tcp, Web: web, ...(funnel ? { AllowFunnel: funnel } : {}) });
    if (args[0] === 'serve' && args[1] === '--bg') return '';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { run, calls };
}

test('LiveKit gets one tailnet-only HTTPS port, made once and reused', async () => {
  const fresh = cli({ web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } } }, tcp: { 443: { HTTPS: true } } });
  assert.deepEqual(await exposeOnTailnet({ run: fresh.run, localPort: 7880, httpsPort: 7443 }), { url: `wss://${HOST}:7443`, reason: null });
  assert.equal(fresh.calls.at(-1), 'serve --bg --https=7443 http://127.0.0.1:7880');
  assert.equal(fresh.calls.some(line => line.includes('funnel')), false);
  const kept = cli({ web: { [`${HOST}:7443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7880' } } } }, tcp: { 7443: { HTTPS: true } } });
  assert.equal((await exposeOnTailnet({ run: kept.run, localPort: 7880, httpsPort: 7443 })).url, `wss://${HOST}:7443`);
  assert.equal(kept.calls.some(line => line.startsWith('serve --bg')), false);
});

test("another tool's port or a Funnel is never taken over, and a stopped Tailscale says so", async () => {
  const taken = cli({ web: { [`${HOST}:7443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } }, tcp: { 7443: { HTTPS: true } } });
  const other = await exposeOnTailnet({ run: taken.run, localPort: 7880, httpsPort: 7443 });
  assert.equal(other.url, null); assert.match(other.reason, /already serves http:\/\/127\.0\.0\.1:9999/);
  assert.equal(taken.calls.some(line => line.startsWith('serve --bg')), false);
  const open = cli({ web: { [`${HOST}:7443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7880' } } } }, funnel: { [`${HOST}:7443`]: true } });
  assert.match((await exposeOnTailnet({ run: open.run, localPort: 7880, httpsPort: 7443 })).reason, /Funnel/);
  assert.deepEqual(await exposeOnTailnet({ run: cli({ backend: 'Stopped' }).run, localPort: 7880 }), { url: null, reason: 'Tailscale is Stopped' });
});

test('the exposure retries until Tailscale runs', async t => {
  let backend = 'Stopped';
  const fake = { run: async args => cli({ backend }).run(args) };
  const exposure = startTailnetExposure({ localPort: 7880, httpsPort: 7443, run: fake.run, every: 20 });
  t.after(() => exposure.close());
  await exposure.ready;
  assert.equal(exposure.state().url, null);
  backend = 'Running';
  for (const end = Date.now() + 2000; !exposure.state().url && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(exposure.state().url, `wss://${HOST}:7443`);
});

test('a reachable URL is withdrawn when Tailscale stops later', async t => {
  let backend = 'Running';
  const exposure = startTailnetExposure({ localPort: 7880, httpsPort: 7443, run: args => cli({ backend }).run(args), every: 20, recheck: 20 });
  t.after(() => exposure.close());
  await exposure.ready;
  assert.equal(exposure.state().url, `wss://${HOST}:7443`);
  backend = 'Stopped';
  for (const end = Date.now() + 2000; exposure.state().url && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(exposure.state(), { url: null, reason: 'Tailscale is Stopped' });
});

test('every call carries a CallKit uuid and the companion name; an incoming ring says when it stops', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'call-log-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const seen = [];
  const log = createCallLog({ dir, now: () => clock, onChange: call => seen.push(call) }); t.after(() => log.close());
  const ring = log.ring({ companion: 'roo', title: 'Roo', reason: 'hi' });
  assert.match(ring.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([ring.title, ring.ringUntil, seen[0].status, seen[0].direction], ['Roo', 1_000_000 + RING_MS, 'ringing', 'incoming']);
  log.decline(ring.id);
  clock += 5;
  const dial = log.dial({ companion: 'roo', title: 'Roo' });
  assert.equal(dial.ringUntil, null);
  assert.notEqual(dial.uuid, ring.uuid);
});

test('a call the engine was carrying when it stopped is over on disk too, ended when it was last heard', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'call-log-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const first = createCallLog({ dir, now: () => clock });
  const call = first.dial({ companion: 'roo', title: 'Roo' });
  clock += 4_000; first.say(call.id, 'companion', 'hi');
  const ring = first.ring({ companion: 'segno', title: 'Segno' });
  first.close();
  clock += 3_600_000;
  const second = createCallLog({ dir, now: () => clock }); t.after(() => second.close());
  const onDisk = id => JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  assert.equal(onDisk(call.id).status, 'ended');
  assert.ok(onDisk(call.id).endedAt < clock - 3_000_000, 'not the restart time');
  assert.equal(onDisk(ring.id).status, 'missed');
  assert.deepEqual(second.live(), []);
});
