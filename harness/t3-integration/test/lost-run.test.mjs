// A run T3 still shows as going while the engine has its session at rest is a turn whose end T3 lost
// (bridge settleLost). Seen on 2026-11-20: the disk fell to 117 MB, and three hash-game leads stopped
// reaching their threads while the engine finished them; the phone showed them working for hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOST_RUN_QUIET_MS, RubatoPiBridge } from '../src/bridge.mjs';

const minutesAgo = (minutes) => Date.now() - minutes * 60_000;
const user = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp });
const said = (text, timestamp) => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], timestamp,
  provider: 'anthropic', model: 'claude' });

/** A bridge over a fake engine row and a fake T3 thread that still shows one run going. */
function setup(t, row, { lostRuns = 1, keepsStream = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-lost-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, `${encodeURIComponent('T1')}.json`), JSON.stringify({ sessionId: 'S1' }));
  const calls = [];
  const started = row.modifiedAt - 10 * 60_000;
  // What reached T3 before its stream went quiet, and the end it never got.
  const session = [user('출금 막아 줘', started), said('테스트 돌려볼게.', started + 1000), said('배포까지 끝냈어.', row.modifiedAt)];
  const shown = [{ id: 'u', role: 'user', text: '출금 막아 줘', runId: 'run-1', createdAt: new Date(started).toISOString() },
    { id: 'a', role: 'assistant', text: '테스트 돌려볼게.', runId: 'run-1', createdAt: new Date(started + 1000).toISOString() }];
  const bridge = new RubatoPiBridge({ descriptorPath: path.join(dir, 'none.json'), instanceId: 'rubato-test', sessionStateDir: stateDir,
    backfillMs: 30,
    projectedThread: async (threadId) => (threadId === 'T1' ? { messages: shown, checkpoints: [] } : null),
    appendSessionMessage: async (threadId, item) => { calls.push(['append', threadId, item.text]); } });
  bridge.viaInventory = async (call) => call({ list: async () => [{ sessionId: 'S1', cwd: '/w', title: 'lead', ...row }],
    transcript: async () => ({ messages: session }) });
  // T3 says the thread had a stream the whole time, which is why the ordinary backfill found no hole.
  bridge.streamGaps = async () => [];
  let open = lostRuns;
  bridge.settleLostRuns = async (threadId, quietSince, { write }) => {
    calls.push([write ? 'settle' : 'check', threadId, quietSince]);
    const found = open;
    if (write) open = 0;
    return found;
  };
  bridge.keepsStream = () => keepsStream;
  t.after(() => bridge.close());
  return { bridge, calls };
}

const until = async (predicate, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
  return predicate();
};
const settle = (calls) => calls.filter(([kind]) => kind === 'settle');

test('a run left going on a session the engine finished gets its missed words, then closes, once', async (t) => {
  const moved = minutesAgo(5);
  const { calls } = setup(t, { status: 'idle', modifiedAt: moved, touchedAt: moved });
  assert.ok(await until(() => settle(calls).length === 1), 'the lost run was closed');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const order = calls.map(([kind, , detail]) => (kind === 'append' ? `append ${detail}` : kind));
  assert.deepEqual(order.slice(order.indexOf('check')), ['check', 'append 배포까지 끝냈어.', 'settle'],
    'the final words land before the run closes');
  assert.equal(settle(calls).length, 1, 'one session state is looked at once');
  assert.equal(settle(calls)[0][2], moved, 'runs begun before the session last moved are the lost ones');
});

test('a session still running, or quiet for less than the grace, keeps its run', async (t) => {
  for (const row of [{ status: 'running', modifiedAt: minutesAgo(5) },
    { status: 'idle', modifiedAt: Date.now() - LOST_RUN_QUIET_MS / 2 }]) {
    const { calls } = setup(t, row);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(calls.filter(([kind]) => kind !== 'append'), [], `${row.status} was left alone`);
  }
});

test("a companion's conversation, or one holding its stream for agents, keeps its run open on purpose", async (t) => {
  const moved = minutesAgo(5);
  const companion = setup(t, { status: 'idle', modifiedAt: moved, companion: true });
  const holding = setup(t, { status: 'idle', modifiedAt: moved }, { keepsStream: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settle(companion.calls).length + settle(holding.calls).length, 0);
});

test('a thread with nothing going is only checked, never written', async (t) => {
  const moved = minutesAgo(5);
  const { calls } = setup(t, { status: 'stored', modifiedAt: moved }, { lostRuns: 0 });
  assert.ok(await until(() => calls.some(([kind]) => kind === 'check')));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(calls.filter(([kind]) => kind === 'check').length, 1);
  assert.equal(settle(calls).length + calls.filter(([kind]) => kind === 'append').length, 0);
});
