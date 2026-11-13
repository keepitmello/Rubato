import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelay } from '../src/relay.mjs';
import { PROVIDER_TOKEN_TTL_S } from '../src/apns.mjs';
import { fakeD1 } from './d1.mjs';

const BUNDLE = 'com.keepitmello.rubato';
const tokenA = 'a'.repeat(64);
const voipA = 'b'.repeat(64);
const tokenB = 'c'.repeat(64);

async function apnsKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

async function setup({ apns = () => ({ status: 200 }) } = {}) {
  const key = await apnsKey();
  const db = fakeD1();
  const sent = [];
  let clock = Date.UTC(2026, 10, 13, 12);
  const fetch = async (url, init) => {
    sent.push({ url, init, payload: JSON.parse(init.body) });
    const { status, reason } = apns(sent.length);
    return new Response(reason ? JSON.stringify({ reason }) : null, { status, headers: { 'apns-id': `id-${sent.length}` } });
  };
  const env = { DB: db, APNS_TEAM_ID: '5WGZKZGPQS', APNS_KEY_ID: 'KEY1234567', APNS_PRIVATE_KEY: key.pem, BUNDLE_IDS: `${BUNDLE}, other.app` };
  const handle = createRelay(env, { fetch, now: () => clock });
  const call = async (method, path, { auth, body } = {}) => {
    const response = await handle(new Request(`https://relay.test${path}`, { method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json(), raw: response };
  };
  const phone = async (fields = {}) => {
    const { body } = await call('POST', '/v1/devices', { body: { bundleId: BUNDLE, environment: 'sandbox', apnsToken: tokenA, voipToken: voipA, ...fields } });
    return body;
  };
  const grantFor = async (device, label = 'wy-mac') => (await call('POST', `/v1/devices/${device.deviceId}/grants`, { auth: device.deviceSecret, body: { label } })).body;
  return { db, env, key, sent, call, phone, grantFor, tick: ms => { clock += ms; }, now: () => clock };
}

const alert = { kind: 'alert', title: 'Fix the login bug', body: 'Completed: rubato', threadId: 'env/thread-1',
  data: { environmentId: 'env', threadId: 'thread-1', deepLink: '/threads/env/thread-1' } };

test('a thread alert reaches APNs as Apple specifies, signed with the relay key', async () => {
  const { call, phone, grantFor, sent, key } = await setup();
  const device = await phone();
  const { grant } = await grantFor(device);
  const response = await call('POST', '/v1/push', { auth: grant, body: alert });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, apnsId: 'id-1' });
  const [request] = sent;
  assert.equal(request.url, `https://api.sandbox.push.apple.com/3/device/${tokenA}`);
  assert.equal(request.init.method, 'POST');
  const headers = request.init.headers;
  assert.equal(headers['apns-topic'], BUNDLE);
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-priority'], '10');
  assert.deepEqual(request.payload, {
    environmentId: 'env', threadId: 'thread-1', deepLink: '/threads/env/thread-1',
    aps: { alert: { title: 'Fix the login bug', body: 'Completed: rubato' }, sound: 'default', 'thread-id': 'env/thread-1' },
  });
  // The provider token: ES256 over { alg, kid } . { iss, iat }, verifiable with the key's public half.
  const jwt = headers.authorization.replace(/^bearer /, '');
  const [head, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, '5WGZKZGPQS');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${head}.${claims}`)));
});

test('a ringing companion goes out as a VoIP push that expires with the ring', async () => {
  const { call, phone, grantFor, sent, now } = await setup();
  const device = await phone({ environment: 'production' });
  const { grant } = await grantFor(device);
  const ringUntil = now() + 40_000;
  const ring = { kind: 'call.ring', callId: 'call-roo-1', uuid: '7f1f6a9e-1111-4c2b-9a77-0123456789ab', companion: 'roo', title: 'Roo', reason: 'missed you', ringUntil };
  assert.equal((await call('POST', '/v1/push', { auth: grant, body: ring })).status, 200);
  const [request] = sent;
  assert.equal(request.url, `https://api.push.apple.com/3/device/${voipA}`);
  assert.equal(request.init.headers['apns-topic'], `${BUNDLE}.voip`);
  assert.equal(request.init.headers['apns-push-type'], 'voip');
  assert.equal(request.init.headers['apns-priority'], '10');
  assert.equal(request.init.headers['apns-expiration'], String(Math.ceil(ringUntil / 1000)));
  const { kind: _kind, ...fields } = ring;
  assert.deepEqual(request.payload, { rubato: { kind: 'call.ring', ...fields } });
  // A ring that is already over is not sent at all.
  const late = await call('POST', '/v1/push', { auth: grant, body: { ...ring, ringUntil: now() - 1 } });
  assert.deepEqual(late.body, { ok: false, reason: 'ring-over' });
  assert.equal(sent.length, 1);
});

test('a Mac can push only to the phone whose grant it holds', async () => {
  const { call, phone, grantFor, sent } = await setup();
  const mine = await phone();
  const theirs = await phone({ apnsToken: tokenB, voipToken: undefined });
  const { grant } = await grantFor(mine);
  // No grant, an invented grant, or the phone's own secret: nothing is pushed.
  assert.equal((await call('POST', '/v1/push', { body: alert })).status, 401);
  assert.equal((await call('POST', '/v1/push', { auth: 'rpg_invented', body: alert })).status, 410);
  assert.equal((await call('POST', '/v1/push', { auth: theirs.deviceSecret, body: alert })).status, 410);
  assert.equal(sent.length, 0);
  // The grant reaches its own phone and no other; nothing in the request names a target.
  await call('POST', '/v1/push', { auth: grant, body: { ...alert, deviceId: theirs.deviceId, token: tokenB } });
  assert.deepEqual(sent.map(item => item.url.split('/').at(-1)), [tokenA]);
  // Another phone's secret cannot mint, list or revoke grants for this phone.
  assert.equal((await call('POST', `/v1/devices/${mine.deviceId}/grants`, { auth: theirs.deviceSecret, body: {} })).status, 401);
  assert.equal((await call('GET', `/v1/devices/${mine.deviceId}/grants`, { auth: theirs.deviceSecret })).status, 401);
  assert.equal((await call('PUT', `/v1/devices/${mine.deviceId}`, { auth: theirs.deviceSecret, body: { apnsToken: tokenB } })).status, 401);
  // And a grant is not a phone credential.
  assert.equal((await call('POST', `/v1/devices/${mine.deviceId}/grants`, { auth: grant, body: {} })).status, 401);
});

test('revoking a grant or forgetting the phone stops that Mac at once', async () => {
  const { call, phone, grantFor, sent } = await setup();
  const device = await phone();
  const first = await grantFor(device, 'wy-mac');
  const second = await grantFor(device, 'studio');
  const listed = await call('GET', `/v1/devices/${device.deviceId}/grants`, { auth: device.deviceSecret });
  assert.deepEqual(listed.body.grants.map(item => item.label), ['wy-mac', 'studio']);
  assert.ok(!JSON.stringify(listed.body).includes(first.grant), 'listing never shows a grant again');
  assert.equal((await call('DELETE', `/v1/devices/${device.deviceId}/grants/${first.grantId}`, { auth: device.deviceSecret })).status, 200);
  assert.equal((await call('POST', '/v1/push', { auth: first.grant, body: alert })).body.error, 'grant-revoked');
  assert.equal((await call('POST', '/v1/push', { auth: second.grant, body: alert })).status, 200);
  assert.equal((await call('DELETE', `/v1/devices/${device.deviceId}`, { auth: device.deviceSecret })).status, 200);
  assert.equal((await call('POST', '/v1/push', { auth: second.grant, body: alert })).status, 410);
  assert.equal(sent.length, 1);
});

test('the key stays in the secret: no response, row or error carries it', async () => {
  const { call, phone, grantFor, db, env } = await setup();
  const device = await phone();
  const { grant } = await grantFor(device);
  const bodies = [];
  bodies.push((await call('GET', '/v1/health')).body);
  bodies.push((await call('POST', '/v1/push', { auth: grant, body: alert })).body);
  assert.deepEqual(bodies[0], { ok: true, configured: true });
  const keyBody = env.APNS_PRIVATE_KEY.split('\n').slice(1, -2).join('');
  const stored = JSON.stringify(db.dump());
  for (const text of [stored, JSON.stringify(bodies)]) {
    assert.ok(!text.includes(keyBody.slice(0, 40)), 'key material leaked');
    assert.ok(!text.includes('PRIVATE KEY'));
  }
  // Secrets are kept as hashes only.
  assert.ok(!stored.includes(device.deviceSecret) && !stored.includes(grant));
  // A broken key fails closed with a bare error, not the parser's message.
  const broken = createRelay({ ...env, APNS_PRIVATE_KEY: 'not a key', DB: db }, { fetch: async () => new Response(null, { status: 200 }) });
  const original = console.error; console.error = () => {};
  try {
    await db.prepare('DELETE FROM provider_tokens').run();
    const response = await broken(new Request('https://relay.test/v1/push', { method: 'POST', headers: { authorization: `Bearer ${grant}` }, body: JSON.stringify(alert) }));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal' });
  } finally { console.error = original; }
  // Without a key the relay says it is not configured instead of pushing.
  const bare = createRelay({ ...env, APNS_PRIVATE_KEY: undefined });
  const response = await bare(new Request('https://relay.test/v1/push', { method: 'POST', headers: { authorization: `Bearer ${grant}` }, body: JSON.stringify(alert) }));
  assert.equal(response.status, 503);
});

test('one provider token serves until it ages out, and a rejected one is signed again', async () => {
  let reject = false;
  const { call, phone, grantFor, sent, tick } = await setup({ apns: () => (reject ? (reject = false, { status: 403, reason: 'ExpiredProviderToken' }) : { status: 200 }) });
  const { grant } = await grantFor(await phone());
  const jwtOf = index => sent[index].init.headers.authorization;
  await call('POST', '/v1/push', { auth: grant, body: alert });
  tick(10 * 60_000);
  await call('POST', '/v1/push', { auth: grant, body: alert });
  assert.equal(jwtOf(0), jwtOf(1));
  tick(PROVIDER_TOKEN_TTL_S * 1000);
  await call('POST', '/v1/push', { auth: grant, body: alert });
  assert.notEqual(jwtOf(2), jwtOf(1));
  tick(1000);
  reject = true;
  const retried = await call('POST', '/v1/push', { auth: grant, body: alert });
  assert.equal(retried.body.ok, true);
  assert.equal(sent.length, 5);
  assert.notEqual(jwtOf(4), jwtOf(3));
});

test('a token APNs no longer knows is forgotten; a reinstall moves the token to the new record', async () => {
  const { call, phone, grantFor, sent } = await setup({ apns: count => (count === 1 ? { status: 410, reason: 'Unregistered' } : { status: 200 }) });
  const old = await phone();
  const { grant } = await grantFor(old);
  assert.deepEqual((await call('POST', '/v1/push', { auth: grant, body: alert })).body, { ok: false, reason: 'token-unregistered' });
  assert.deepEqual((await call('POST', '/v1/push', { auth: grant, body: alert })).body, { ok: false, reason: 'no-apns-token' });
  // The phone registers the token again (it got it back from iOS): the old record lets go of it.
  assert.equal((await call('PUT', `/v1/devices/${old.deviceId}`, { auth: old.deviceSecret, body: { apnsToken: tokenA } })).status, 200);
  const fresh = await phone();
  const moved = await grantFor(fresh);
  assert.deepEqual((await call('POST', '/v1/push', { auth: grant, body: alert })).body, { ok: false, reason: 'no-apns-token' });
  assert.equal((await call('POST', '/v1/push', { auth: moved.grant, body: alert })).body.ok, true);
  assert.equal(sent.length, 2);
});

test('the relay refuses what it should not carry', async () => {
  const { call, phone, grantFor } = await setup({ apns: () => ({ status: 503 }) });
  assert.equal((await call('POST', '/v1/devices', { body: { bundleId: 'com.someone.else', environment: 'sandbox', apnsToken: tokenA } })).status, 403);
  assert.equal((await call('POST', '/v1/devices', { body: { bundleId: BUNDLE, environment: 'staging', apnsToken: tokenA } })).status, 400);
  assert.equal((await call('POST', '/v1/devices', { body: { bundleId: BUNDLE, environment: 'sandbox', apnsToken: 'nothex' } })).status, 400);
  const { grant } = await grantFor(await phone());
  for (const data of [{ aps: 'x' }, { rubato: 'x' }, { deep: { nested: 1 } }])
    assert.equal((await call('POST', '/v1/push', { auth: grant, body: { ...alert, data } })).status, 400);
  assert.equal((await call('POST', '/v1/push', { auth: grant, body: { kind: 'background' } })).status, 400);
  assert.equal((await call('POST', '/v1/push', { auth: grant, body: { ...alert, title: '' } })).status, 400);
  // APNs being down is the relay's 502, so a Mac can tell it from a refusal.
  assert.equal((await call('POST', '/v1/push', { auth: grant, body: alert })).status, 502);
});

test('a phone that keeps minting grants is capped', async () => {
  const { call, phone, grantFor } = await setup();
  const device = await phone();
  for (let index = 0; index < 20; index += 1) await grantFor(device, `mac-${index}`);
  assert.equal((await call('POST', `/v1/devices/${device.deviceId}/grants`, { auth: device.deviceSecret, body: {} })).status, 409);
});
