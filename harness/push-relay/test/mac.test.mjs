// The Mac's senders against the real relay code: a phone registers and mints a grant, the Mac keeps
// it, and the call service's ring and the server's thread alerts arrive at (fake) APNs for that phone.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGrantStore, validRelay } from '../mac/grants.mjs';
import { createPushSender, ringMessage } from '../mac/sender.mjs';
import { createRelay } from '../src/relay.mjs';
import { fakeD1 } from './d1.mjs';

const BUNDLE = 'com.keepitmello.rubato';

async function relayServer(t) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const apns = [];
  const handle = createRelay({ DB: fakeD1(), APNS_TEAM_ID: 'TEAM', APNS_KEY_ID: 'KEY', BUNDLE_IDS: BUNDLE,
    APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----` },
  { fetch: async (url, init) => { apns.push({ url, headers: init.headers, payload: JSON.parse(init.body) }); return new Response(null, { status: 200 }); } });
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const answer = await handle(new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers,
      ...(body ? { body } : {}) }));
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(await answer.text());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const phone = async (apnsToken, voipToken) => {
    const device = await (await fetch(`${url}/v1/devices`, { method: 'POST', body: JSON.stringify({ bundleId: BUNDLE, environment: 'sandbox', apnsToken, voipToken }) })).json();
    const minted = await (await fetch(`${url}/v1/devices/${device.deviceId}/grants`, { method: 'POST',
      headers: { authorization: `Bearer ${device.deviceSecret}` }, body: JSON.stringify({ label: 'wy-mac' }) })).json();
    return { ...device, ...minted };
  };
  return { url, apns, phone };
}

function home(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rubato-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a companion ringing reaches every paired phone as one VoIP push', async t => {
  const relay = await relayServer(t);
  const grants = createGrantStore({ home: home(t) });
  const one = await relay.phone('1'.repeat(64), 'a'.repeat(64));
  const two = await relay.phone('2'.repeat(64), 'b'.repeat(64));
  for (const phone of [one, two]) grants.add({ relay: relay.url, grant: phone.grant, grantId: phone.grantId, deviceId: phone.deviceId, label: 'iPhone' });
  const sender = createPushSender({ grants });
  const call = { id: 'call-roo-1', uuid: '6c1e3c1b-34c4-4c7e-9a2e-5e3f1d2c9b01', companion: 'roo', title: 'Roo', direction: 'incoming',
    status: 'ringing', reason: 'checking in', createdAt: Date.now(), ringUntil: Date.now() + 40_000 };
  sender.callChanged(call);
  sender.callChanged({ ...call });                                   // the same ring saved again
  sender.callChanged({ ...call, status: 'active' });                 // answered: nothing to push
  sender.callChanged({ ...call, id: 'call-x', direction: 'outgoing', status: 'active' }); // the person dialled
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(relay.apns.map(item => item.url.split('/').at(-1)).sort(), ['a'.repeat(64), 'b'.repeat(64)]);
  for (const item of relay.apns) {
    assert.equal(item.headers['apns-push-type'], 'voip');
    assert.deepEqual(item.payload, { rubato: { kind: 'call.ring', callId: 'call-roo-1', uuid: call.uuid, companion: 'roo', title: 'Roo',
      reason: 'checking in', ringUntil: call.ringUntil } });
  }
});

test('a ring without ringUntil on the record still expires 40 s after it started', () => {
  assert.equal(ringMessage({ id: 'c', uuid: 'u', companion: 'segno', createdAt: 1000 }).ringUntil, 41_000);
  assert.equal(ringMessage({ id: 'c', uuid: 'u', companion: 'segno', createdAt: 1000 }).title, 'segno');
});

test('a grant the phone revoked is dropped from this Mac; the rest keep working', async t => {
  const relay = await relayServer(t);
  const dir = home(t);
  const grants = createGrantStore({ home: dir });
  const kept = await relay.phone('3'.repeat(64));
  const gone = await relay.phone('4'.repeat(64));
  for (const phone of [kept, gone]) grants.add({ relay: relay.url, grant: phone.grant, grantId: phone.grantId, deviceId: phone.deviceId });
  assert.equal(statSync(path.join(dir, 'grants.json')).mode & 0o777, 0o600);
  await fetch(`${relay.url}/v1/devices/${gone.deviceId}/grants/${gone.grantId}`, { method: 'DELETE', headers: { authorization: `Bearer ${gone.deviceSecret}` } });
  const results = await grants.pushAll({ kind: 'alert', title: 't', body: 'b' }, { preference: 'threads' });
  assert.deepEqual(results.map(item => [item.deviceId, item.ok, item.reason]).sort(),
    [[kept.deviceId, true, undefined], [gone.deviceId, false, 'grant-revoked']].sort());
  assert.deepEqual(grants.list().map(item => item.deviceId), [kept.deviceId]);
  assert.ok(!JSON.stringify(grants.list()).includes(kept.grant), 'listing never shows the grant');
  assert.ok(readFileSync(path.join(dir, 'grants.json'), 'utf8').includes(kept.grant));
});

test('an unreachable relay never throws into the caller', async t => {
  const grants = createGrantStore({ home: home(t) });
  grants.add({ relay: 'http://127.0.0.1:9', grant: 'g', grantId: 'gid', deviceId: 'd' });
  assert.deepEqual(await grants.pushAll({ kind: 'alert', title: 't', body: 'b' }, { preference: 'threads' }), [{ deviceId: 'd', ok: false, reason: 'relay-unreachable' }]);
});

test('only an https relay, or one on this machine, is accepted', () => {
  assert.equal(validRelay('https://push.example.workers.dev/'), 'https://push.example.workers.dev');
  assert.equal(validRelay('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const bad of ['http://evil.example', 'ftp://x', 'https://user:pw@x.dev', 'https://x.dev/?q=1', 42, null])
    assert.equal(validRelay(bad), null, String(bad));
});

test("a phone's choices are kept per phone, and a kind it turned off never leaves this Mac", async t => {
  const relay = await relayServer(t);
  const grants = createGrantStore({ home: home(t) });
  const quiet = await relay.phone('5'.repeat(64), 'c'.repeat(64));
  const loud = await relay.phone('6'.repeat(64), 'd'.repeat(64));
  assert.deepEqual(grants.add({ relay: relay.url, grant: quiet.grant, grantId: quiet.grantId, deviceId: quiet.deviceId,
    preferences: { companionCalls: false } }).preferences, { threads: true, companionMessages: true, companionCalls: false });
  grants.add({ relay: relay.url, grant: loud.grant, grantId: loud.grantId, deviceId: loud.deviceId });
  createPushSender({ grants }).callChanged({ id: 'call-1', uuid: 'u-1', companion: 'roo', direction: 'incoming', status: 'ringing', createdAt: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(relay.apns.map(item => item.url.split('/').at(-1)), ['d'.repeat(64)]);
  assert.deepEqual(grants.setPreferences(loud.deviceId, { threads: false }), { threads: false, companionMessages: true, companionCalls: true });
  const results = await grants.pushAll({ kind: 'alert', title: 't', body: 'b' }, { preference: 'threads' });
  assert.deepEqual(results.map(item => item.deviceId), [quiet.deviceId]);
  // A phone pairing again keeps what it chose unless it says otherwise.
  grants.add({ relay: relay.url, grant: loud.grant, grantId: loud.grantId, deviceId: loud.deviceId });
  assert.equal(grants.list().find(item => item.deviceId === loud.deviceId).preferences.threads, false);
  assert.equal(grants.setPreferences('nobody', { threads: true }), null);
  await assert.rejects(grants.pushAll({ kind: 'alert', title: 't', body: 'b' }), /preference must be/);
});
