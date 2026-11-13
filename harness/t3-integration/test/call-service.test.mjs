import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCallService, handleCallRequest } from '../src/call/service.mjs';

// A stand-in for the call service's loopback control surface (harness/companion/call-agent/control.mjs).
async function control(t, answer) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    seen.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    const [status, value] = answer(request.url);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}
const ask = (service, action, body = {}) => handleCallRequest(service,
  new Request(`http://app/rubato/call/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test("the app's route passes the person's own call actions through", async t => {
  const box = await control(t, () => [200, { ok: true }]);
  const service = createCallService({ base: box.base });
  for (const [action, body] of [['live', {}], ['calls', { companion: 'roo', since: 5 }], ['dial', { companion: 'roo', voice: 'fish:drama-3' }],
    ['answer', { callId: 'c1' }], ['decline', { callId: 'c1' }], ['hangup', { callId: 'c1' }], ['companions', {}]])
    assert.equal((await ask(service, action, body)).status, 200, action);
  assert.deepEqual(box.seen.map(item => `${item.method} ${item.url}`), ['GET /live', 'GET /calls?companion=roo&since=5', 'POST /dial',
    'POST /answer', 'POST /decline', 'POST /hangup', 'GET /companions']);
  assert.deepEqual(box.seen[2].body, { companion: 'roo', voice: 'fish:drama-3' });
});

test('ringing the person and reporting speech are not reachable from the app', async t => {
  const box = await control(t, () => [200, {}]);
  const service = createCallService({ base: box.base });
  for (const action of ['ring', 'event']) assert.equal((await ask(service, action, { companion: 'roo' })).status, 404, action);
  assert.deepEqual(box.seen, []);
});

test('a taken call stays a conflict, and a stopped service says so', async t => {
  const box = await control(t, () => [409, { error: 'answered elsewhere' }]);
  const taken = await ask(createCallService({ base: box.base }), 'answer', { callId: 'c1' });
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: { code: 'conflict', message: 'answered elsewhere' } });
  const down = await ask(createCallService({ base: 'http://127.0.0.1:9' }), 'live');
  assert.equal(down.status, 503);
  assert.equal((await down.json()).error.code, 'call-service-down');
});

test('a join answers this Mac its loopback LiveKit and a tailnet device the tailnet one', async t => {
  const joined = { call: { id: 'c1' }, url: 'ws://127.0.0.1:7880', remoteUrl: 'wss://mac.tail.ts.net:7443', remoteReason: null, room: 'c1', token: 't' };
  const box = await control(t, url => [200, url === '/reach' ? { remoteUrl: joined.remoteUrl } : joined]);
  const service = createCallService({ base: box.base });
  const from = headers => handleCallRequest(service, new Request('http://127.0.0.1:3773/rubato/call/dial', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ companion: 'roo' }) }));
  const desk = await (await from({ host: '127.0.0.1:3773' })).json();
  assert.equal(desk.url, 'ws://127.0.0.1:7880');
  assert.equal('remoteUrl' in desk, false);
  for (const headers of [{ host: '127.0.0.1:3773', 'x-forwarded-for': '100.64.0.7' }, { host: 'mac.tail.ts.net' }]) {
    const phone = await (await from(headers)).json();
    assert.deepEqual([phone.url, phone.room, phone.token], ['wss://mac.tail.ts.net:7443', 'c1', 't'], JSON.stringify(headers));
  }
});

test('a tailnet device is told why when the Mac has no tailnet address for calls yet', async t => {
  const box = await control(t, url => [200, url === '/reach' ? { url: 'ws://127.0.0.1:7880', remoteUrl: null, remoteReason: 'Tailscale is Stopped' } : {}]);
  const answer = await handleCallRequest(createCallService({ base: box.base }), new Request('http://x/rubato/call/answer', { method: 'POST',
    headers: { host: 'mac.tail.ts.net', 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'c1' }) }));
  assert.equal(answer.status, 503);
  const { error } = await answer.json();
  assert.equal(error.code, 'call-unreachable');
  assert.match(error.message, /Tailscale is Stopped/);
  assert.deepEqual(box.seen.map(item => item.url), ['/reach'], 'the call is not taken');
});
