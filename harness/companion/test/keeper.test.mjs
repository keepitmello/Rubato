import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMPANION_TITLE, companionPaths, readState, writeSettings, writeState } from '../companion.mjs';
import { startCompanionKeeper } from '../keeper.mjs';

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
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(engine.clients, 0);
  assert.equal(engine.sessions.size, 0);
});

test('turned on, the keeper creates the companion in its home once and keeps it attached', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000 });
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
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000 });
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
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.equal(engine.created.length, 1);
  assert.notEqual(readState(env).sessionId, 'gone');
});

test('turning the companion off releases it, and closing the keeper does too', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000 });
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
  const keeper = startCompanionKeeper({ connect, env, pollMs: 60_000, onError: (error) => errors.push(error.message) });
  t.after(() => keeper.close());
  await keeper.ready;
  assert.deepEqual(errors, ['engine is starting']);
  fail = false;
  await keeper.poke();
  assert.equal(engine.attached(readState(env).sessionId), 1);
});
