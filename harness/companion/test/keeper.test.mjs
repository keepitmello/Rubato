import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMPANION_TITLE, companionPaths, personalPiecePath, readState, writeSettings, writeState } from '../companion.mjs';
import { fileURLToPath } from 'node:url';
import { DAILY_REPORT_TEXT, HEARTBEAT_TEXT, localDate, startCompanionKeeper } from '../keeper.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
/** A keeper whose default pieces are the ones in this repository, not whatever this Mac has. */
const startKeeper = (options) => startCompanionKeeper({ defaultsDir, ...options });

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-keeper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
}

/** An engine with sessions and attachments, seen through session clients. */
function fakeEngine() {
  const sessions = new Map();
  const engine = { sessions, created: [], clients: 0,
    attached(id) { return sessions.get(id)?.attachments ?? 0; },
    crash(id) { const row = sessions.get(id); row.status = 'stored'; row.runtimeId = null; row.attachments = 0; },
  };
  engine.connect = async () => {
    engine.clients++;
    let attachedTo;
    return {
      async list() { return [...sessions.values()].map(({ attachments: _a, ...row }) => ({ ...row })); },
      async create(options) {
        const sessionId = `s${sessions.size + 1}`;
        engine.created.push(options);
        sessions.set(sessionId, { sessionId, status: 'stored', runtimeId: null, attachments: 0 });
        return { sessionId };
      },
      async attach(id) {
        const row = sessions.get(id);
        if (!row) throw new Error('unknown session');
        Object.assign(row, { status: 'idle', runtimeId: `r-${id}` });
        row.attachments++;
        attachedTo = id;
      },
      async close() {
        const row = attachedTo && sessions.get(attachedTo);
        if (row && row.attachments > 0) row.attachments--;
        attachedTo = undefined;
      },
    };
  };
  return engine;
}

test('turned off, the keeper creates and holds nothing', async (t) => {
  const env = sandbox(t);
  const engine = fakeEngine();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(engine.clients, 0);
  assert.equal(engine.sessions.size, 0);
});

test('turned on, the keeper creates the companion in its home once and keeps it attached', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.deepEqual(engine.created, [{ cwd: companionPaths(env).home, title: COMPANION_TITLE, titleLocked: true, companion: true }]);
  const { sessionId } = readState(env);
  assert.equal(keeper.sessionId, sessionId);
  assert.equal(engine.attached(sessionId), 1);
  await keeper.poke();
  assert.equal(engine.created.length, 1, 'a known companion is not created again');
  assert.equal(engine.attached(sessionId), 1, 'and is not attached twice');
});

test('the keeper comes back to the same conversation, and re-attaches when its runtime ended', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  engine.sessions.set('segno', { sessionId: 'segno', status: 'stored', runtimeId: null, attachments: 0 });
  writeState({ sessionId: 'segno' }, env);
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(engine.created.length, 0);
  assert.equal(engine.attached('segno'), 1);
  engine.crash('segno');
  await keeper.poke();
  assert.equal(engine.attached('segno'), 1);
  assert.equal(engine.sessions.get('segno').status, 'idle');
});

test('a recorded conversation the engine no longer has is replaced by a new one', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'gone' }, env);
  const engine = fakeEngine();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(engine.created.length, 1);
  assert.notEqual(readState(env).sessionId, 'gone');
});

test('turning the companion off releases it, and closing the keeper does too', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  await keeper.ready;
  const { sessionId } = readState(env);
  writeSettings({ enabled: false }, env);
  await keeper.poke();
  assert.equal(engine.attached(sessionId), 0);
  assert.equal(keeper.sessionId, undefined);
  writeSettings({ enabled: true }, env);
  await keeper.poke();
  assert.equal(engine.attached(sessionId), 1);
  await keeper.close();
  assert.equal(engine.attached(sessionId), 0);
});

test('an engine error is reported and the next poll tries again', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  let fail = true;
  const errors = [];
  const connect = async () => { if (fail) throw new Error('engine is starting'); return engine.connect(); };
  const keeper = startKeeper({ connect, env, pollMs: 60_000, onError: (error) => errors.push(error.message) });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.deepEqual(errors, ['engine is starting']);
  fail = false;
  await keeper.poke();
  assert.equal(engine.attached(readState(env).sessionId), 1);
});

test('the heartbeat wakes the companion on its interval, waits while it is busy, and stops when switched off', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, dailyReport: { enabled: false } }, env);
  const engine = fakeEngine();
  const notices = [];
  let at = new Date(2026, 9, 20, 12, 0).getTime();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => at,
    notify: async (sessionId, text, what) => { notices.push({ sessionId, text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  const { sessionId } = readState(env);
  at += 29 * 60_000;
  await keeper.poke();
  assert.deepEqual(notices, []);
  at += 60_000;
  engine.sessions.get(sessionId).status = 'running';
  await keeper.poke();
  assert.deepEqual(notices, [], 'a busy companion is not interrupted');
  engine.sessions.get(sessionId).status = 'idle';
  await keeper.poke();
  assert.deepEqual(notices, [{ sessionId, text: HEARTBEAT_TEXT, what: 'heartbeat' }]);
  at += 30 * 60_000;
  writeSettings({ heartbeat: { enabled: false } }, env);
  await keeper.poke();
  assert.equal(notices.length, 1);
});

test('the daily report goes out once a day at its time; a companion started after the time begins tomorrow', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { time: '09:00' } }, env);
  const engine = fakeEngine();
  const notices = [];
  let at = new Date(2026, 9, 20, 14, 0).getTime();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => at,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  await keeper.poke();
  assert.deepEqual(notices, [], 'turned on at 14:00, the 09:00 report waits for tomorrow');
  at = new Date(2026, 9, 21, 8, 59).getTime();
  await keeper.poke();
  assert.deepEqual(notices, []);
  at = new Date(2026, 9, 21, 9, 0).getTime();
  await keeper.poke();
  at = new Date(2026, 9, 21, 9, 5).getTime();
  await keeper.poke();
  assert.deepEqual(notices, [{ text: DAILY_REPORT_TEXT, what: 'daily-report' }]);
  assert.equal(readState(env).dailyReportOn, localDate(at));
});

test('a companion started before the report time gets that day\'s report', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false } }, env);
  const engine = fakeEngine();
  const notices = [];
  let at = new Date(2026, 9, 20, 7, 0).getTime();
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => at,
    notify: async (_sessionId, text) => { notices.push(text); } });
  t.after(() => keeper.close());
  await keeper.ready;
  at = new Date(2026, 9, 20, 9, 0).getTime();
  await keeper.poke();
  assert.deepEqual(notices, [DAILY_REPORT_TEXT]);
});

test("the keeper keeps the panel beside Segno's chat current from the engine's list", async (t) => {
  const { followingStore, readPanel } = await import('../companion.mjs');
  const env = sandbox(t);
  const engine = fakeEngine();
  engine.sessions.set('lead', { sessionId: 'lead', title: 'Login timeout', cwd: '/w/hash-game', status: 'running', runtimeId: 'r-lead', attachments: 1 });
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { enabled: false } }, env);
  followingStore(env).save({ lead: { companionId: 'x', base: { final: null, waiting: false, ui: [] }, since: 1000 } });
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.deepEqual(readPanel(env).leads, [{ sessionId: 'lead', title: 'Login timeout', cwd: '/w/hash-game', state: 'running', since: 1000 }]);
  engine.sessions.get('lead').status = 'waiting';
  await keeper.poke();
  assert.equal(readPanel(env).leads[0].state, 'asked');
});

test('an existing home with an empty prompt folder is seeded when the keeper starts', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'segno' }, env);
  const engine = fakeEngine();
  engine.sessions.set('segno', { sessionId: 'segno', status: 'stored', runtimeId: null, attachments: 0 });
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(engine.created.length, 0, 'the home already had its conversation');
  for (const id of ['preamble', 'soul', 'identity', 'user']) assert.ok(existsSync(personalPiecePath(env, id)), id);
  assert.equal(existsSync(personalPiecePath(env, 'companion')), false);
  assert.equal(existsSync(personalPiecePath(env, 'tools')), false);
});

test('the keeper leaves a prompt piece the person already has exactly as it is', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'segno' }, env);
  mkdirSync(companionPaths(env).prompt, { recursive: true });
  writeFileSync(personalPiecePath(env, 'soul'), 'my own soul\n');
  const engine = fakeEngine();
  engine.sessions.set('segno', { sessionId: 'segno', status: 'stored', runtimeId: null, attachments: 0 });
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(readFileSync(personalPiecePath(env, 'soul'), 'utf8'), 'my own soul\n');
  assert.ok(existsSync(personalPiecePath(env, 'preamble')), 'the pieces they have not touched are copied');
});
