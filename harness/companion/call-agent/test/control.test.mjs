import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCompanionCall, CALL_USER_TOOL } from '../../../pi-runtime/features/companion-home/call.mjs';
import { createCallLog } from '../calls.mjs';
import { createControl, listen } from '../control.mjs';

const tmp = t => { const dir = mkdtempSync(path.join(tmpdir(), 'call-log-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const companions = () => [{ id: 'roo', title: 'Roo', ready: true, voices: [{ id: 'fish:drama-3', ready: true }] },
  { id: 'segno', title: 'Segno', ready: false, reason: 'no voice is chosen for Segno yet' }];
const livekit = { key: 'devkey', secret: 'a-secret-long-enough-for-hmac-signing-0123456789', url: 'ws://127.0.0.1:7880' };
const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

async function service(t, options = {}) {
  const log = createCallLog({ dir: tmp(t), ...options });
  const server = await listen(createControl({ livekit, log, companions }), { port: 0 });
  t.after(() => { log.close(); server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { log, base, post };
}
const waitFor = async (check, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) { const value = await check(); if (value) return value; }
  throw new Error('timed out');
};

test('a companion rings; the first device to answer takes the call and the next is told it went elsewhere', async t => {
  const box = await service(t);
  const ringing = box.post('/ring', { companion: 'roo', reason: '오늘 얘기하고 싶어서' });
  const call = await waitFor(async () => (await (await fetch(`${box.base}/live`)).json()).find(item => item.status === 'ringing'));
  const desk = await box.post('/answer', { callId: call.id });
  assert.equal(desk.status, 200);
  const joined = await desk.json();
  assert.equal(joined.room, call.id);
  const job = JSON.parse(claims(joined.token).roomConfig.agents[0].metadata);
  assert.deepEqual([job.companion, job.callId, job.calledBy, job.reason], ['roo', call.id, 'companion', '오늘 얘기하고 싶어서']);
  const phone = await box.post('/answer', { callId: call.id });
  assert.equal(phone.status, 409);
  assert.equal((await phone.json()).error, 'answered elsewhere');
  assert.equal((await (await ringing).json()).status, 'active');
});

test('a ring nobody picks up is missed, a declined one is declined, and the caller hears which', async t => {
  const box = await service(t, { ringMs: 150 });
  assert.equal((await (await box.post('/ring', { companion: 'roo', reason: 'r' })).json()).status, 'missed');
  const ringing = box.post('/ring', { companion: 'roo', reason: 'r' });
  const call = await waitFor(async () => (await (await fetch(`${box.base}/live`)).json())[0]);
  await box.post('/decline', { callId: call.id });
  assert.equal((await (await ringing).json()).status, 'declined');
  assert.deepEqual(box.log.history({ companion: 'roo' }).map(item => item.status), ['missed', 'declined']);
});

test('the person dials; one call per companion; a companion that cannot be called is refused with its reason', async t => {
  const box = await service(t);
  const dialed = await (await box.post('/dial', { companion: 'roo', voice: 'fish:drama-3' })).json();
  assert.equal(dialed.call.direction, 'outgoing');
  assert.equal(JSON.parse(claims(dialed.token).roomConfig.agents[0].metadata).voice, 'fish:drama-3');
  assert.equal((await box.post('/dial', { companion: 'roo' })).status, 409);
  assert.equal((await box.post('/ring', { companion: 'roo', reason: 'r' })).status, 409);
  const refused = await box.post('/dial', { companion: 'segno' });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /no voice is chosen/);
});

test('what both sides said is kept on the call while it is live, and the call ends once', async t => {
  const box = await service(t);
  const { call } = await (await box.post('/dial', { companion: 'roo' })).json();
  await box.post('/event', { callId: call.id, type: 'heard', text: '루야 들려?' });
  await box.post('/event', { callId: call.id, type: 'said', text: '응, 들려!' });
  await box.post('/event', { callId: call.id, type: 'ended' });
  await box.post('/event', { callId: call.id, type: 'said', text: 'too late' });
  const [kept] = await (await fetch(`${box.base}/calls?companion=roo`)).json();
  assert.equal(kept.status, 'ended');
  assert.deepEqual(kept.transcript.map(line => [line.who, line.text]), [['me', '루야 들려?'], ['companion', '응, 들려!']]);
});

test('after an engine restart a ring that was ringing is missed and a live call is over', t => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', companion: 'roo', status: 'ringing', transcript: [], createdAt: 1 }));
  writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ id: 'b', companion: 'roo', status: 'active', transcript: [], createdAt: 2 }));
  const log = createCallLog({ dir });
  t.after(() => log.close());
  assert.deepEqual(log.history().map(call => call.status), ['missed', 'ended']);
  assert.deepEqual(log.live(), []);
  assert.ok(readdirSync(dir).every(name => name.endsWith('.json')));
});

test("a companion's call_user rings through the service and ends its turn only when the person picks up", async t => {
  const box = await service(t, { ringMs: 150 });
  const tools = new Map();
  const home = tmp(t);
  const pi = { on() {}, registerTool(tool) { tools.set(tool.name, tool); }, sendMessage() {}, sendUserMessage() {} };
  createCompanionCall(pi, { env: { HOME: home, RUBATO_COMPANION_HOME: home, RUBATO_COMPANION_ID: 'roo', RUBATO_CALL_CONTROL: box.base },
    config: { enabled: true, host: '127.0.0.1', port: 0 } });
  const ring = args => tools.get(CALL_USER_TOOL).execute('tool-1', args);
  const missed = await ring({ reason: '보고 싶어서' });
  assert.equal(missed.terminate, undefined);
  assert.match(missed.content[0].text, /missed/);
  const answering = ring({ reason: '보고 싶어서' });
  const call = await waitFor(() => box.log.live()[0]);
  assert.equal(call.reason, '보고 싶어서');
  await box.post('/answer', { callId: call.id });
  const picked = await answering;
  assert.equal(picked.terminate, true);
  assert.match(picked.content[0].text, /picked up/);
  const refused = await ring({ reason: 'again' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /already on a call/);
});
