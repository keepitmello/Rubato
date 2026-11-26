import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPANION_TITLE, PIECES, defaultPiecePath, basePiecePath, companionPaths, personalPiecePath, readPersonaReviewRequest,
  readState, requestPersonaReview, seedPromptPieces, writeSettings, writeState } from '../companion.mjs';
import { SLEEP_CONTEXT_TOKENS, SLEEP_TEXT, heartbeatText, locationLine, readUserLocation, localIso, timeLabel, lastUserMessageAt, localDate, nextBoundary, sleepText, startControlTower } from '../control-tower.mjs';
import { CAPABILITY_LEASE_MS, capabilityActive, renewCapability, clearCapability, noteCompanionActivity, readWakeWish, setWakeWish } from '../home.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
/** A control tower whose default pieces are the ones in this repository, not whatever this Mac has. */
const startTower = (options) => startControlTower({ defaultsDir, readQuota: async () => '', ...options });

/** Rubato's defaults, copied so a test can change one the way an update would. */
function defaultsCopy(t, edits = {}) {
  // Laid out as shipped: the companion's pieces in companion/, a shared piece beside that folder.
  const root = mkdtempSync(path.join(tmpdir(), 'rubato-companion-defaults-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'companion');
  mkdirSync(dir);
  for (const { id } of PIECES) copyFileSync(defaultPiecePath(defaultsDir, id), defaultPiecePath(dir, id));
  for (const [id, text] of Object.entries(edits)) writeFileSync(path.join(dir, `${id}.pi.md`), text);
  return dir;
}

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-control-tower-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
}

/** An engine with sessions and attachments, seen through session clients. */
function fakeEngine() {
  const sessions = new Map();
  const engine = { sessions, created: [], clients: 0, contextTokens: null, sessionFile: undefined,
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
        sessions.set(sessionId, { sessionId, status: 'stored', runtimeId: null, attachments: 0,
          companion: true, companionId: options.companionId ?? 'segno' });
        return { sessionId };
      },
      async attach(id) {
        const row = sessions.get(id);
        if (!row) throw new Error('unknown session');
        Object.assign(row, { status: 'idle', runtimeId: `r-${id}` });
        row.attachments++;
        attachedTo = id;
      },
      async command(command) {
        if (!attachedTo) throw new Error('No session is attached');
        if (command.type === 'get_state') return { model: engine.model ?? { provider: 'anthropic', id: 'claude-test' } };
        if (command.type !== 'get_session_stats') throw new Error(`unexpected command ${command.type}`);
        return { sessionId: attachedTo, sessionFile: engine.sessionFile, contextUsage: { tokens: engine.contextTokens, contextWindow: 1_000_000 } };
      },
      async close() {
        const row = attachedTo && sessions.get(attachedTo);
        if (row && row.attachments > 0) row.attachments--;
        attachedTo = undefined;
      },
    };
  };
  /** A companion conversation that already exists and was already woken: the control tower attaches to it. */
  engine.existing = (env) => {
    const sessionId = 'segno-1';
    // Already loaded, as after the control tower's first start: no resume line is owed.
    sessions.set(sessionId, { sessionId, status: 'idle', runtimeId: `r-${sessionId}`, attachments: 0, companion: true, companionId: 'segno' });
    writeState({ sessionId, woke: { boundary: null }, runtimeId: `r-${sessionId}` }, env);
    return sessionId;
  };
  return engine;
}

test('turned off, the control tower creates and holds nothing', async (t) => {
  const env = sandbox(t);
  const engine = fakeEngine();
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(engine.clients, 0);
  assert.equal(engine.sessions.size, 0);
});

test('turned on, the control tower creates the companion in its home once and keeps it attached', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.deepEqual(engine.created, [{ cwd: companionPaths(env).home, title: COMPANION_TITLE, titleLocked: true, companion: true }]);
  const { sessionId } = readState(env);
  assert.equal(tower.sessionId, sessionId);
  assert.equal(engine.attached(sessionId), 1);
  await tower.poke();
  assert.equal(engine.created.length, 1, 'a known companion is not created again');
  assert.equal(engine.attached(sessionId), 1, 'and is not attached twice');
});

test('the control tower reads the engine directory from its subscription, not by asking for the list each poll', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const sessionId = engine.existing(env);
  let lists = 0;
  let listeners = [];
  const connect = engine.connect;
  engine.connect = async () => {
    const client = await connect();
    const list = client.list;
    client.list = async () => { lists++; return list(); };
    client.subscribeDirectory = async (listener) => {
      listeners.push(listener);
      listener({ sessions: await list() });
      return async () => { listeners = listeners.filter((item) => item !== listener); };
    };
    return client;
  };
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(engine.attached(sessionId), 1);
  const afterAttach = lists;
  for (let i = 0; i < 5; i++) await tower.poke();
  assert.equal(lists, afterAttach, 'polls ask the engine for nothing');
  assert.equal(engine.attached(sessionId), 1);
  // The runtime ended; the delivered directory says so and the control tower attaches again.
  engine.crash(sessionId);
  for (const listener of listeners) listener({ sessions: [...engine.sessions.values()].map(({ attachments: _a, ...row }) => ({ ...row })) });
  await tower.poke();
  assert.equal(engine.attached(sessionId), 1);
  assert.equal(engine.created.length, 0);
});

test('a saved conversation missing from the delivered directory is looked up in the files before another is made', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const sessionId = engine.existing(env);
  const connect = engine.connect;
  engine.connect = async () => {
    const client = await connect();
    client.subscribeDirectory = async (listener) => { listener({ sessions: [] }); return async () => {}; };
    return client;
  };
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(engine.created.length, 0);
  assert.equal(engine.attached(sessionId), 1);
});

test('a saved conversation still on disk is never replaced, even when the engine list misses it', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  writeState({ sessionId: 'roo-old', woke: { boundary: null } }, env);
  let onDisk = true;
  const errors = [];
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000, sessionExists: async (id) => onDisk && id === 'roo-old',
    onError: (error) => errors.push(String(error?.message ?? error)) });
  t.after(() => tower.close());
  await tower.ready;
  await tower.poke();
  assert.equal(engine.created.length, 0, 'no second conversation while the first is on disk');
  assert.equal(readState(env).sessionId, 'roo-old');
  assert.match(errors[0], /roo-old is on disk but not in the engine's list \(0 rows\)/);
  onDisk = false;
  await tower.poke();
  assert.equal(engine.created.length, 1, 'a conversation that is really gone is made again');
});

test('the control tower comes back to the same conversation, and re-attaches when its runtime ended', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  engine.sessions.set('segno', { sessionId: 'segno', companion: true, status: 'stored', runtimeId: null, attachments: 0 });
  writeState({ sessionId: 'segno' }, env);
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(engine.created.length, 0);
  assert.equal(engine.attached('segno'), 1);
  engine.crash('segno');
  await tower.poke();
  assert.equal(engine.attached('segno'), 1);
  assert.equal(engine.sessions.get('segno').status, 'idle');
});

test('a recorded conversation the engine no longer has is replaced by a new one', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'gone' }, env);
  const engine = fakeEngine();
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(engine.created.length, 1);
  assert.notEqual(readState(env).sessionId, 'gone');
});

test('turning the companion off releases it, and closing the control tower does too', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  await tower.ready;
  const { sessionId } = readState(env);
  writeSettings({ enabled: false }, env);
  await tower.poke();
  assert.equal(engine.attached(sessionId), 0);
  assert.equal(tower.sessionId, undefined);
  writeSettings({ enabled: true }, env);
  await tower.poke();
  assert.equal(engine.attached(sessionId), 1);
  await tower.close();
  assert.equal(engine.attached(sessionId), 0);
});

test('an engine error is reported and the next poll tries again', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  const engine = fakeEngine();
  let fail = true;
  const errors = [];
  const connect = async () => { if (fail) throw new Error('engine is starting'); return engine.connect(); };
  const tower = startTower({ connect, env, pollMs: 60_000, onError: (error) => errors.push(error.message) });
  t.after(() => tower.close());
  await tower.ready;
  assert.deepEqual(errors, ['engine is starting']);
  fail = false;
  await tower.poke();
  assert.equal(engine.attached(readState(env).sessionId), 1);
});

test('the heartbeat wakes the companion on its interval, waits while it is busy, and stops when switched off', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, greetings: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.existing(env);
  const notices = [];
  let at = new Date(2026, 9, 20, 12, 0).getTime();
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000, now: () => at,
    notify: async (sessionId, text, what) => { notices.push({ sessionId, text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  const { sessionId } = readState(env);
  at += 29 * 60_000;
  await tower.poke();
  assert.deepEqual(notices, []);
  at += 60_000;
  engine.sessions.get(sessionId).status = 'running';
  await tower.poke();
  assert.deepEqual(notices, [], 'a busy companion is not interrupted');
  engine.sessions.get(sessionId).status = 'idle';
  await tower.poke();
  assert.deepEqual(notices, [{ sessionId, text: heartbeatText({ tick: 1, at }), what: 'heartbeat' }]);
  at += 30 * 60_000;
  writeSettings({ heartbeat: { enabled: false } }, env);
  await tower.poke();
  assert.equal(notices.length, 1);
});

test("the control tower keeps the panel beside Segno's chat current from the engine's list", async (t) => {
  const { followingStore, readPanel } = await import('../companion.mjs');
  const env = sandbox(t);
  const engine = fakeEngine();
  engine.sessions.set('lead', { sessionId: 'lead', title: 'Login timeout', cwd: '/w/hash-game', status: 'running', runtimeId: 'r-lead', attachments: 1 });
  writeSettings({ enabled: true, heartbeat: { enabled: false }, greetings: { enabled: false } }, env);
  followingStore(env).save({ lead: { companionId: 'x', base: { final: null, waiting: false, ui: [] }, since: 1000 } });
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.deepEqual(readPanel(env).leads, [{ sessionId: 'lead', title: 'Login timeout', cwd: '/w/hash-game', state: 'running', since: 1000 }]);
  engine.sessions.get('lead').status = 'waiting';
  await tower.poke();
  assert.equal(readPanel(env).leads[0].state, 'asked');
});

test('an existing home with an empty prompt folder is seeded when the control tower starts', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'segno' }, env);
  const engine = fakeEngine();
  engine.sessions.set('segno', { sessionId: 'segno', companion: true, status: 'stored', runtimeId: null, attachments: 0 });
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(engine.created.length, 0, 'the home already had its conversation');
  for (const id of ['preamble', 'soul', 'identity', 'user']) assert.ok(existsSync(personalPiecePath(env, id)), id);
  assert.equal(existsSync(personalPiecePath(env, 'companion')), false);
  assert.equal(existsSync(personalPiecePath(env, 'tools')), false);
});

test('the control tower leaves a prompt piece the person already has exactly as it is', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'segno' }, env);
  mkdirSync(companionPaths(env).prompt, { recursive: true });
  writeFileSync(personalPiecePath(env, 'soul'), 'my own soul\n');
  const engine = fakeEngine();
  engine.sessions.set('segno', { sessionId: 'segno', companion: true, status: 'stored', runtimeId: null, attachments: 0 });
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(readFileSync(personalPiecePath(env, 'soul'), 'utf8'), 'my own soul\n');
  assert.ok(existsSync(personalPiecePath(env, 'preamble')), 'the pieces they have not touched are copied');
});

// ── sleep ─────────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60_000;
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const userMessage = (time) => ({ type: 'message', timestamp: new Date(time).toISOString(), message: { role: 'user', content: 'hi', timestamp: time } });
const assistantMessage = (time) => ({ type: 'message', timestamp: new Date(time).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: time } });
const sessionMessage = (time, details) => ({ type: 'custom_message', customType: 'rubato-session-message', display: details.kind !== 'wake',
  content: details.text ?? '', details, timestamp: new Date(time).toISOString() });
const telegram = (time, isUser) => sessionMessage(time, { v: 1, kind: 'channel', from: { channel: 'telegram', chatId: '7', isUser, ...(isUser ? {} : { name: 'Mina' }) }, text: 'hello' });
const wake = (time, what) => sessionMessage(time, { v: 1, kind: 'wake', what, from: { sessionId: 'rubato', title: 'Rubato', cwd: '' }, text: 'tick' });
const leadEnded = (time) => sessionMessage(time, { v: 1, kind: 'notice', from: { sessionId: 'lead-1', title: 'Login bug', cwd: '/w' }, text: 'Finished its turn.' });

/** A long conversation: Segno's context is `tokens` long and its session file holds `entries`. */
async function night(t, { tokens = 600_000, entries = [], start, sleepCheckMs = 0, setup } = {}) {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, greetings: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.existing(env);
  engine.contextTokens = tokens;
  engine.sessionFile = path.join(path.dirname(env.RUBATO_COMPANION_HOME), 'segno.jsonl');
  const write = (list) => writeFileSync(engine.sessionFile, [{ type: 'session', id: 'segno' }, ...list].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  write(entries);
  // What holds before the control tower's first look (it checks once as it starts).
  await setup?.({ env, engine });
  const clock = { at: start };
  const notices = [];
  const errors = [];
  const tower = startControlTower({ connect: engine.connect, env, pollMs: 60_000, now: () => clock.at, sleepCheckMs, readQuota: async () => '',
    onError: (error) => errors.push(error), notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  const poke = async (time) => { clock.at = time; await tower.poke(); };
  t.after(() => assert.deepEqual(errors, []));
  return { env, engine, tower, notices, poke, write, sleeps: () => notices.filter((notice) => notice.what === 'sleep').length };
}

/** A lead Segno follows, as the engine lists it (`status`) and as the follower records it (`ended`). */
async function followLead({ env, engine }, { status = 'running', ended = false } = {}) {
  const { followingStore } = await import('../companion.mjs');
  engine.sessions.set('lead', { sessionId: 'lead', title: 'Login bug', cwd: '/w', status, runtimeId: 'r-lead', attachments: 1 });
  followingStore(env).save({ lead: { companionId: 'segno-1', base: { final: null, waiting: false, ui: [] }, since: 1000, ...(ended ? { ended: true } : {}) } });
}

const compaction = (id, time) => ({ type: 'compaction', id, timestamp: new Date(time).toISOString(), summary: 'earlier', tokensBefore: 600_000 });

test('sleep: a long context puts Segno to sleep at any hour, even right after the user wrote, as a wake', async (t) => {
  const n = await night(t, { start: at(21, 14, 59), entries: [userMessage(at(21, 14, 58)), assistantMessage(at(21, 14, 59))] });
  noteCompanionActivity({ now: at(21, 14, 59), env: n.env });
  await n.poke(at(21, 15));
  assert.deepEqual(n.notices, [{ text: sleepText(defaultsDir, n.env), what: 'sleep' }]);
  assert.match(n.notices[0].text, /# 잠 전 갈무리/);
  assert.equal(readState(n.env).sleptIn, null, 'slept in the window that has had no boundary yet');
});

test('sleepText: product companions read sleep.pi.md; private registered homes use promptFiles.sleep or path-free SLEEP_TEXT', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-sleep-text-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const custom = path.join(dir, 'sleep.md');
  writeFileSync(custom, 'CUSTOM_ROO_SLEEP');
  assert.match(sleepText(defaultsDir, {}), /# 잠 전 갈무리/);
  assert.match(sleepText(defaultsDir, { RUBATO_COMPANION_ID: 'nova', RUBATO_COMPANION_MADE_IN_APP: '1' }), /# 잠 전 갈무리/);
  assert.equal(sleepText(defaultsDir, { RUBATO_COMPANION_ID: 'roo' }), SLEEP_TEXT);
  assert.equal(sleepText(defaultsDir, { RUBATO_COMPANION_ID: 'roo', RUBATO_COMPANION_PROMPT_FILES: JSON.stringify({ sleep: custom }) }), 'CUSTOM_ROO_SLEEP');
});

test('an active call suppresses the control tower rhythm, but a crashed call expires and cannot hold it awake', async t => {
  const start = at(21, 1);
  const n = await night(t, { tokens: null, entries: [userMessage(at(20, 22))], start: start - 1 });
  renewCapability('call', 'new-connection', { now: start, env: n.env });
  clearCapability('call', 'old-connection', n.env);
  n.engine.contextTokens = 600_000;
  assert.equal(capabilityActive('call', { now: start, env: n.env }), true);
  await n.poke(start);
  assert.equal(n.sleeps(), 0);
  await n.poke(start + CAPABILITY_LEASE_MS);
  assert.equal(n.sleeps(), 1);
});

test('sleep: once per window; a compaction or a new window opens the next', async (t) => {
  const n = await night(t, { start: at(21, 10) });
  await n.poke(at(21, 10, 1));
  await n.poke(at(21, 13));
  await n.poke(at(22, 3));
  assert.equal(n.sleeps(), 1, 'Segno stayed in the window: it is not woken to sleep again');
  n.write([compaction('c1', at(22, 3, 1))]);
  await n.poke(at(22, 3, 2));
  assert.equal(n.notices.at(-1).what, 'wake', 'the compaction is woken for first');
  await n.poke(at(22, 3, 3));
  assert.equal(n.sleeps(), 2, 'still long after the compaction: the new window sleeps once too');
  assert.equal(readState(n.env).sleptIn, 'c1');
});

test('sleep: once per window holds across a control tower restart (the window is stored)', async (t) => {
  const n = await night(t, { start: at(21, 10) });
  await n.poke(at(21, 10, 1));
  await n.tower.close();
  const again = [];
  const tower = startControlTower({ connect: n.engine.connect, env: n.env, pollMs: 60_000, now: () => at(21, 12), sleepCheckMs: 0,
    notify: async (_sessionId, text, what) => { again.push(what); } });
  t.after(() => tower.close());
  await tower.ready;
  await tower.poke();
  assert.deepEqual(again, []);
});

test('sleep: only with a context of 500k tokens or more', async (t) => {
  const short = await night(t, { tokens: SLEEP_CONTEXT_TOKENS - 1, start: at(21, 10) });
  await short.poke(at(21, 11));
  assert.equal(short.sleeps(), 0);
  const unknown = await night(t, { tokens: null, start: at(21, 10) });
  await unknown.poke(at(21, 11));
  assert.equal(unknown.sleeps(), 0, 'right after a compaction the size is unknown: not long');
  const exact = await night(t, { tokens: SLEEP_CONTEXT_TOKENS, start: at(21, 10) });
  await exact.poke(at(21, 11));
  assert.equal(exact.sleeps(), 1);
});

test('sleep: not while Segno is mid-turn; it sleeps once the turn ends', async (t) => {
  const n = await night(t, { tokens: null, start: at(21, 10) });
  const { sessionId } = readState(n.env);
  n.engine.sessions.get(sessionId).status = 'running';
  n.engine.contextTokens = 600_000;
  await n.poke(at(21, 11));
  assert.equal(n.sleeps(), 0);
  n.engine.sessions.get(sessionId).status = 'idle';
  await n.poke(at(21, 11, 5));
  assert.equal(n.sleeps(), 1);
});

test('sleep: not while a lead Segno follows is working or still owes its turn; it sleeps once the lead ends', async (t) => {
  const n = await night(t, { start: at(21, 10), setup: (n) => followLead(n, { status: 'running' }) });
  await n.poke(at(21, 11));
  assert.equal(n.sleeps(), 0, 'the lead is running');
  await followLead(n, { status: 'idle' });
  await n.poke(at(21, 11, 5));
  assert.equal(n.sleeps(), 0, 'the lead is idle but its handed turn has not ended');
  await followLead(n, { status: 'idle', ended: true });
  await n.poke(at(21, 11, 10));
  assert.equal(n.sleeps(), 1);
});

test('sleep: the control tower asks the engine for the context at most every ten minutes, by day too', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, greetings: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.existing(env);
  engine.contextTokens = 100_000;
  let asked = 0;
  const connect = async () => { const client = await engine.connect(); const command = client.command; client.command = (c) => { asked++; return command(c); }; return client; };
  let now = at(21, 12);
  const tower = startControlTower({ connect, env, pollMs: 60_000, now: () => now, notify: async () => {} });
  t.after(() => tower.close());
  await tower.ready;
  assert.equal(asked, 2, 'where the session file is (the wake sequence follows it), then the context');
  for (const minute of [3, 9, 10, 15]) { now = at(21, 12, minute); await tower.poke(); }
  assert.equal(asked, 3, 'again at 12:10, not before');
});

test('lastUserMessageAt reads the newest user message, in the app or from Telegram', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-last-user-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const lines = (list) => writeFileSync(file, list.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  lines([{ type: 'session' }, assistantMessage(1000)]);
  assert.equal(await lastUserMessageAt(file), undefined);
  lines([{ type: 'session' }, userMessage(1000), telegram(5000, true), wake(9000, 'heartbeat'), telegram(9500, false)]);
  assert.equal(await lastUserMessageAt(file), 5000);
  lines([{ type: 'session' }, telegram(5000, true), userMessage(7000), 'not json']);
  assert.equal(await lastUserMessageAt(file), 7000);
});

test('a default that moved wakes Segno once at engine start, with where to look, and the base moves', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, greetings: { enabled: false } }, env);
  seedPromptPieces({ defaultsDir, env });
  const moved = defaultsCopy(t, { soul: '# I am Segno\n\nA new default voice.\n' });
  const engine = fakeEngine();
  engine.existing(env);
  const notices = [];
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000, defaultsDir: moved,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  await tower.poke();
  assert.deepEqual(notices.map((notice) => notice.what), ['persona-review']);
  assert.match(notices[0].text, /Rubato's default soul changed/);
  assert.match(notices[0].text, new RegExp(path.join(moved, 'soul.pi.md').replace(/[.[\]{}()*+?^$|\\]/g, '\\$&')));
  assert.match(notices[0].text, /prompt\/\.base\/soul\.md/);
  assert.doesNotMatch(notices[0].text, /identity/, 'only the piece that moved');
  assert.doesNotMatch(notices[0].text, /A new default voice/, 'the wake does not carry the default text');
  assert.equal(readFileSync(basePiecePath(env, 'soul'), 'utf8').trim(), '# I am Segno\n\nA new default voice.',
    'the base moved to the default Segno was told about');
  await tower.poke();
  assert.equal(notices.length, 1, 'the same default does not wake it twice');
  const again = defaultsCopy(t, { soul: '# I am Segno\n\nA third default voice.\n' });
  const next = startTower({ connect: engine.connect, env, pollMs: 60_000, defaultsDir: again,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => next.close());
  await next.ready;
  await next.poke();
  assert.deepEqual(notices.map((notice) => notice.what), ['persona-review', 'persona-review'],
    'a newer default is a new review');
});

test('a default that changes while the engine runs waits for the next engine start', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, greetings: { enabled: false } }, env);
  const under = defaultsCopy(t);
  seedPromptPieces({ defaultsDir: under, env });
  const engine = fakeEngine();
  engine.existing(env);
  const notices = [];
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000, defaultsDir: under,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  await tower.poke();
  assert.deepEqual(notices, []);
  // The defaults folder changes under a running engine: no polling, so nothing is sent.
  writeFileSync(path.join(under, 'soul.pi.md'), '# changed while running\n');
  await tower.poke();
  assert.deepEqual(notices, []);
});

test('the page can ask Segno to review even when no default moved', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, greetings: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.existing(env);
  const notices = [];
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000, defaultsDir,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  await tower.poke();
  assert.deepEqual(notices, []);
  requestPersonaReview(env);
  await tower.poke();
  assert.deepEqual(notices.map((notice) => notice.what), ['persona-review']);
  assert.match(notices[0].text, /The user asked you to look over who you are/);
  assert.match(notices[0].text, new RegExp(defaultsDir.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&')));
  assert.equal(readPersonaReviewRequest(env), undefined, 'the request is cleared once Segno is told');
  await tower.poke();
  assert.equal(notices.length, 1, 'a request does not repeat by itself');
});

// ── heartbeat: Roo's tick, ported ───────────────────────────────────────────────────────────

/** A day with the heartbeat on every 30 minutes and Segno's session file under the test's control. */
async function heartbeatDay(t, { entries = [], start = at(20, 12), env = sandbox(t) } = {}) {
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, greetings: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.existing(env);
  engine.sessionFile = path.join(path.dirname(env.RUBATO_COMPANION_HOME), 'segno.jsonl');
  const write = (list) => writeFileSync(engine.sessionFile, [{ type: 'session', id: 'segno' }, ...list].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  write(entries);
  const clock = { at: start };
  const notices = [];
  const errors = [];
  const tower = startControlTower({ connect: engine.connect, env, pollMs: 60_000, now: () => clock.at, defaultsDir, readQuota: async () => '',
    onError: (error) => errors.push(error), notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  t.after(() => assert.deepEqual(errors, []));
  const poke = async (time) => { clock.at = time; await tower.poke(); };
  const lines = () => notices.filter((notice) => notice.what === 'heartbeat').map((notice) => notice.text);
  return { env, tower, poke, write, lines, notices: () => notices };
}
const firstLine = (text) => text.split('\n')[0];

test("heartbeat: Roo's line — HEARTBEAT tick=N now=\"…\" on this machine's clock, and nothing else on a plain tick", () => {
  const moment = new Date(2026, 9, 20, 18, 30).getTime();
  assert.equal(timeLabel(moment), '10월 20일(화) 오후 6:30');
  assert.equal(heartbeatText({ tick: 2, at: moment }), 'HEARTBEAT tick=2 now="10월 20일(화) 오후 6:30"');
  assert.equal(heartbeatText({ tick: 3, at: moment, action: 'reflect' }), 'HEARTBEAT tick=3 now="10월 20일(화) 오후 6:30" action=reflect');
  assert.equal(timeLabel(new Date(2026, 9, 20, 0, 5).getTime()), '10월 20일(화) 오전 12:05');
});

test('heartbeat: ticks land on :00 and :30, count up while the user is away, and reflect on 3, 6 and 9 only', async (t) => {
  const { poke, lines } = await heartbeatDay(t, { start: at(20, 12, 10) });
  await poke(at(20, 12, 29));
  assert.equal(lines().length, 0, 'the first boundary is 12:30');
  for (let n = 0; n < 12; n += 1) await poke(at(20, 12, 30) + n * 30 * 60_000);
  assert.deepEqual(lines().map((line) => line.replace(/ now="[^"]*"/, '')), [
    'HEARTBEAT tick=1', 'HEARTBEAT tick=2', 'HEARTBEAT tick=3 action=reflect', 'HEARTBEAT tick=4', 'HEARTBEAT tick=5',
    'HEARTBEAT tick=6 action=reflect', 'HEARTBEAT tick=7', 'HEARTBEAT tick=8', 'HEARTBEAT tick=9 action=reflect',
    'HEARTBEAT tick=10', 'HEARTBEAT tick=11', 'HEARTBEAT tick=12',
  ]);
});

test('heartbeat: tick=0 while the user is here; after they leave the count starts again from 1', async (t) => {
  const { poke, write, lines } = await heartbeatDay(t);
  await poke(at(20, 12, 30));
  await poke(at(20, 13));
  write([userMessage(at(20, 13, 20))]);
  await poke(at(20, 13, 30));
  assert.match(lines().at(-1), /^HEARTBEAT tick=0 now=/, 'they wrote ten minutes ago');
  await poke(at(20, 14));
  assert.match(lines().at(-1), /^HEARTBEAT tick=1 now=/, 'forty minutes since their last word');
  write([userMessage(at(20, 13, 20)), userMessage(at(20, 14, 10))]);
  await poke(at(20, 15));
  assert.match(lines().at(-1), /^HEARTBEAT tick=1 now=/, 'they wrote between ticks, more than thirty minutes ago: reset, then one');
});

test('heartbeat: the tick survives an engine restart', async (t) => {
  const env = sandbox(t);
  const first = await heartbeatDay(t, { env });
  await first.poke(at(20, 12, 30));
  await first.poke(at(20, 13));
  await first.tower.close();
  const second = await heartbeatDay(t, { env, start: at(20, 13, 10) });
  await second.poke(at(20, 13, 30));
  assert.match(second.lines().at(-1), /^HEARTBEAT tick=3 now="[^"]*" action=reflect$/);
});

test('heartbeat: while a wake wish waits no tick is sent but they are counted; its tick reflects with the reason, once', async (t) => {
  const { env, poke, lines } = await heartbeatDay(t);
  setWakeWish({ target: '15:10', reason: '로그인 버그 리드가 끝났는지 본다' }, { now: at(20, 12, 5), env });
  for (const time of [at(20, 12, 30), at(20, 13), at(20, 13, 30), at(20, 14), at(20, 14, 30), at(20, 15)]) await poke(time);
  assert.equal(lines().length, 0, 'Segno rests: no tick until the wish');
  await poke(at(20, 15, 30));
  const due = lines().at(-1).split('\n');
  assert.match(due[0], /^HEARTBEAT tick=7 now="[^"]*" action=reflect reason=wake_wish$/, 'the rest counted as seven ticks away');
  assert.equal(due[1], `WAKE_WISH at=${localIso(at(20, 15, 10))} clamped=0 reason=로그인 버그 리드가 끝났는지 본다`);
  assert.match(due[1], /^WAKE_WISH at=2026-10-20T15:10:00[+-]\d\d:\d\d /);
  assert.equal(readWakeWish(env), undefined, 'the wish is used up');
  await poke(at(20, 16));
  assert.equal(firstLine(lines().at(-1)).replace(/ now="[^"]*"/, ''), 'HEARTBEAT tick=8');
});

test('heartbeat: a wake wish keeps the ticks quiet while the user is here too, and does not hold back the morning greeting', async (t) => {
  const { env, poke, write, lines, notices } = await heartbeatDay(t, { start: at(20, 8) });
  writeSettings({ greetings: { enabled: true } }, env);
  setWakeWish({ target: '120', reason: '오전에 다시' }, { now: at(20, 8, 5), env });
  write([userMessage(at(20, 8, 50))]);
  await poke(at(20, 9));
  await poke(at(20, 9, 7));
  assert.deepEqual(notices().map((notice) => notice.what), ['greeting']);
  assert.equal(lines().length, 0);
  assert.notEqual(readWakeWish(env), undefined, 'the wish still waits');
});

test('heartbeat: a companion set to keep its ticks during a wish gets them, a reflect going as a plain tick, and the reflect note on its reflects', async (t) => {
  const { env, poke, lines } = await heartbeatDay(t);
  const note = 'heartbeat 스킬 열고 내 것 하나 집은 다음에 일정 봐.';
  writeSettings({ heartbeat: { quietDuringWish: false, reflectNote: note } }, env);
  await poke(at(20, 12, 30));
  await poke(at(20, 13));
  await poke(at(20, 13, 30));
  assert.equal(lines().at(-1), `${lines().at(-1).split('\n')[0]}\n\n${note}`, 'tick 3 reflects with the note after a blank line');
  assert.match(lines().at(-1), /^HEARTBEAT tick=3 now="[^"]*" action=reflect\n/);
  assert.equal(lines()[0].includes(note), false, 'a plain tick carries no note');
  setWakeWish({ target: '16:10', reason: '점괘 채점' }, { now: at(20, 13, 35), env });
  for (const time of [at(20, 14), at(20, 14, 30), at(20, 15), at(20, 15, 30), at(20, 16)]) await poke(time);
  assert.deepEqual(lines().slice(3).map((line) => line.replace(/ now="[^"]*"/, '')),
    ['HEARTBEAT tick=4', 'HEARTBEAT tick=5', 'HEARTBEAT tick=6', 'HEARTBEAT tick=7', 'HEARTBEAT tick=8'],
    'the wish does not silence the ticks; tick 6 goes plain, without the note');
  await poke(at(20, 16, 30));
  const due = lines().at(-1).split('\n');
  assert.match(due[0], /^HEARTBEAT tick=9 now="[^"]*" action=reflect reason=wake_wish$/);
  assert.match(due[1], /^WAKE_WISH .* reason=점괘 채점$/);
  assert.equal(due.at(-1), note, 'the wish come due is a reflect, and carries the note');
});

test('heartbeat: Segno, with the defaults, rests through a wish even when it has a reflect note', async (t) => {
  const { env, poke, lines } = await heartbeatDay(t);
  writeSettings({ heartbeat: { reflectNote: '내 것부터.' } }, env);
  setWakeWish({ target: '14:10', reason: '다시 본다' }, { now: at(20, 12, 5), env });
  for (const time of [at(20, 12, 30), at(20, 13), at(20, 13, 30), at(20, 14)]) await poke(time);
  assert.equal(lines().length, 0);
  await poke(at(20, 14, 30));
  assert.match(lines().at(-1), /^HEARTBEAT tick=5 now="[^"]*" action=reflect reason=wake_wish\nWAKE_WISH .*\n\n내 것부터\.$/);
});

test('heartbeat: a wish further than six hours from when it was set comes due at six, marked clamped', async (t) => {
  const { env, poke, lines } = await heartbeatDay(t);
  setWakeWish({ target: String(10 * 60), reason: '저녁에' }, { now: at(20, 12), env });
  await poke(at(20, 17, 30));
  assert.equal(lines().length, 0);
  await poke(at(20, 18));
  assert.ok(lines().at(-1).endsWith(`\nWAKE_WISH at=${localIso(at(20, 18))} clamped=1 reason=저녁에`));
});

test('nextBoundary: the interval on the local clock', () => {
  assert.equal(nextBoundary(at(20, 12, 10), 30 * 60_000), at(20, 12, 30));
  assert.equal(nextBoundary(at(20, 12, 30), 30 * 60_000), at(20, 13));
  assert.equal(nextBoundary(at(20, 12, 50), 15 * 60_000), at(20, 13));
});

test("heartbeat: the user's place from the location file in settings rides under the tick, with its age, stale past six hours", async (t) => {
  const env = sandbox(t);
  const file = path.join(path.dirname(env.RUBATO_COMPANION_HOME), 'user.json');
  const now = new Date(2026, 10, 18, 23, 0).getTime();
  const place = (updatedAt, extra = {}) => writeFileSync(file, JSON.stringify({ name: 'u', location: { current: '세븐일레븐, "남현1길", 남현동', updatedAt, source: 'owntracks', ...extra } }));

  assert.equal(readUserLocation('', env), undefined, 'no source, no place');
  assert.equal(readUserLocation(file, env), undefined, 'no file, no place');
  place(new Date(2026, 10, 18, 22, 57).toISOString());
  assert.equal(locationLine(readUserLocation(file, env), now), `LOCATION now="세븐일레븐, '남현1길', 남현동" updated="22:57" (3분 전)`);
  place(new Date(2026, 10, 18, 16, 30).toISOString());
  assert.equal(locationLine(readUserLocation(file, env), now), `LOCATION now="세븐일레븐, '남현1길', 남현동" updated="16:30" (6시간 전) stale`);
  place(new Date(2026, 10, 15, 9, 5).toISOString());
  assert.equal(locationLine(readUserLocation(file, env), now), `LOCATION now="세븐일레븐, '남현1길', 남현동" updated="11월 15일 09:05" (3일 전) stale`);
  writeFileSync(file, JSON.stringify({ current: '남현동', updatedAt: new Date(now).toISOString() }));
  assert.equal(locationLine(readUserLocation(file, env), now), 'LOCATION now="남현동" updated="23:00" (방금)', 'a file that is only the place reads too');
  place('not a time');
  assert.equal(readUserLocation(file, env), undefined, 'a place without a readable time is no place');
  assert.equal(locationLine(undefined, now), '');

  assert.equal(heartbeatText({ tick: 1, at: now, location: 'LOCATION now="x" updated="22:57" (3분 전)', schedule: ['SCHEDULE_DUE y'] }),
    'HEARTBEAT tick=1 now="11월 18일(수) 오후 11:00"\nLOCATION now="x" updated="22:57" (3분 전)\nSCHEDULE_DUE y');

  // A real beat: the control tower reads the file named in settings on each tick.
  place(new Date(2026, 10, 18, 22, 57).toISOString());
  assert.throws(() => writeSettings({ location: { source: 5 } }, env), /location\.source/);
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, greetings: { enabled: false }, location: { source: file } }, env);
  const engine = fakeEngine();
  engine.existing(env);
  const notices = [];
  let at = new Date(2026, 10, 18, 22, 31).getTime();
  const tower = startTower({ connect: engine.connect, env, pollMs: 60_000, now: () => at,
    notify: async (sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => tower.close());
  await tower.ready;
  at = now;
  await tower.poke();
  assert.deepEqual(notices.filter((notice) => notice.what === 'heartbeat').map((notice) => notice.text.split('\n')[1]),
    [`LOCATION now="세븐일레븐, '남현1길', 남현동" updated="22:57" (3분 전)`]);
});
