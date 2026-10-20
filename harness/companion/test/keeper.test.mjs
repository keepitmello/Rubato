import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPANION_TITLE, PIECES, basePiecePath, companionPaths, personalPiecePath, readPersonaReviewRequest,
  readState, requestPersonaReview, seedPromptPieces, writeSettings, writeState } from '../companion.mjs';
import { DAILY_REPORT_TEXT, SLEEP_CONTEXT_TOKENS, SLEEP_QUIET_MS, SLEEP_TEXT, heartbeatText, kstLabel, lastUserMessageAt, localDate, nextBoundary, startCompanionKeeper } from '../keeper.mjs';
import { readWakeWish, setWakeWish } from '../home.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
/** A keeper whose default pieces are the ones in this repository, not whatever this Mac has. */
const startKeeper = (options) => startCompanionKeeper({ defaultsDir, ...options });

/** Rubato's defaults, copied so a test can change one the way an update would. */
function defaultsCopy(t, edits = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-defaults-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const { id } of PIECES) copyFileSync(path.join(defaultsDir, `${id}.pi.md`), path.join(dir, `${id}.pi.md`));
  for (const [id, text] of Object.entries(edits)) writeFileSync(path.join(dir, `${id}.pi.md`), text);
  return dir;
}

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-keeper-'));
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
      async command(command) {
        if (!attachedTo) throw new Error('No session is attached');
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
  assert.deepEqual(notices, [{ sessionId, text: heartbeatText({ tick: 1, at }), what: 'heartbeat' }]);
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

/** A sleepy night: Segno's context is long and the user last wrote in the app at `lastUser`. */
async function night(t, { tokens = 600_000, entries, start, sleepCheckMs = 0 } = {}) {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.contextTokens = tokens;
  engine.sessionFile = path.join(path.dirname(env.RUBATO_COMPANION_HOME), 'segno.jsonl');
  const write = (list) => writeFileSync(engine.sessionFile, [{ type: 'session', id: 'segno' }, ...list].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  write(entries);
  const clock = { at: start };
  const notices = [];
  const errors = [];
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => clock.at, sleepCheckMs,
    onError: (error) => errors.push(error), notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  const poke = async (time) => { clock.at = time; await keeper.poke(); };
  t.after(() => assert.deepEqual(errors, []));
  return { env, engine, keeper, notices, poke, write, sleeps: () => notices.filter((notice) => notice.what === 'sleep').length };
}

test('sleep: at night, three quiet hours and a long context put Segno to sleep, as a wake', async (t) => {
  const n = await night(t, { start: at(20, 23), entries: [userMessage(at(20, 22)), assistantMessage(at(20, 22, 1))] });
  await n.poke(at(21, 2));
  assert.deepEqual(n.notices, [{ text: SLEEP_TEXT, what: 'sleep' }]);
  assert.equal(readState(n.env).sleptOn, '2026-10-21');
});

test('sleep: once per night, and again the next night', async (t) => {
  const n = await night(t, { start: at(20, 23), entries: [userMessage(at(20, 20))] });
  await n.poke(at(21, 1, 30));
  await n.poke(at(21, 3));
  await n.poke(at(21, 6, 59));
  assert.equal(n.sleeps(), 1, 'one sleep however long the night');
  await n.poke(at(22, 1, 30));
  assert.equal(n.sleeps(), 2);
});

test('sleep: once per night holds across a keeper restart (the night is stored)', async (t) => {
  const n = await night(t, { start: at(20, 23), entries: [userMessage(at(20, 20))] });
  await n.poke(at(21, 2));
  await n.keeper.close();
  const again = [];
  const keeper = startCompanionKeeper({ connect: n.engine.connect, env: n.env, pollMs: 60_000, now: () => at(21, 4), sleepCheckMs: 0,
    notify: async (_sessionId, text, what) => { again.push(what); } });
  t.after(() => keeper.close());
  await keeper.ready;
  await keeper.poke();
  assert.deepEqual(again, []);
});

test('sleep: the user must have been quiet for three hours — the boundary is inclusive', async (t) => {
  const last = at(21, 0, 30);
  const n = await night(t, { start: at(21, 1), entries: [userMessage(last)] });
  await n.poke(last + SLEEP_QUIET_MS - 1);
  assert.equal(n.sleeps(), 0, 'one millisecond short of three hours');
  await n.poke(last + SLEEP_QUIET_MS);
  assert.equal(n.sleeps(), 1);
});

test('sleep: only from 01:00 up to 07:00 local time', async (t) => {
  const n = await night(t, { start: at(20, 18), entries: [userMessage(at(20, 12))] });
  await n.poke(at(21, 0, 59));
  await n.poke(at(21, 7, 0));
  await n.poke(at(21, 12, 0));
  assert.equal(n.sleeps(), 0);
  const m = await night(t, { start: at(20, 18), entries: [userMessage(at(20, 12))] });
  await m.poke(at(21, 1, 0));
  assert.equal(m.sleeps(), 1);
});

test('sleep: only with a context of 500k tokens or more', async (t) => {
  const short = await night(t, { tokens: SLEEP_CONTEXT_TOKENS - 1, start: at(20, 23), entries: [userMessage(at(20, 20))] });
  await short.poke(at(21, 2));
  assert.equal(short.sleeps(), 0);
  const unknown = await night(t, { tokens: null, start: at(20, 23), entries: [userMessage(at(20, 20))] });
  await unknown.poke(at(21, 2));
  assert.equal(unknown.sleeps(), 0, 'right after a compaction the size is unknown: not long');
  const exact = await night(t, { tokens: SLEEP_CONTEXT_TOKENS, start: at(20, 23), entries: [userMessage(at(20, 20))] });
  await exact.poke(at(21, 2));
  assert.equal(exact.sleeps(), 1);
});

test('sleep: not while Segno is mid-turn; it sleeps once the turn ends', async (t) => {
  const n = await night(t, { start: at(20, 23), entries: [userMessage(at(20, 20))] });
  const { sessionId } = readState(n.env);
  n.engine.sessions.get(sessionId).status = 'running';
  await n.poke(at(21, 2));
  assert.equal(n.sleeps(), 0);
  n.engine.sessions.get(sessionId).status = 'idle';
  await n.poke(at(21, 2, 5));
  assert.equal(n.sleeps(), 1);
});

test('sleep: heartbeats, lead endings, other wakes and other people do not count as the user', async (t) => {
  const quiet = at(20, 22);
  const n = await night(t, { start: at(20, 23), entries: [
    userMessage(quiet), assistantMessage(quiet + 60_000),
    wake(at(21, 0), 'heartbeat'), assistantMessage(at(21, 0, 1)),
    leadEnded(at(21, 0, 30)), wake(at(21, 0, 40), 'daily-report'), telegram(at(21, 1, 50), false),
  ] });
  await n.poke(at(21, 2));
  assert.equal(n.sleeps(), 1, 'the user last wrote at 22:00; nothing after that is the user');
});

test('sleep: a Telegram message from the user counts like one in the app', async (t) => {
  const n = await night(t, { start: at(20, 23), entries: [userMessage(at(20, 20)), telegram(at(21, 0, 30), true)] });
  await n.poke(at(21, 2));
  assert.equal(n.sleeps(), 0, 'the user wrote on Telegram at 00:30');
  await n.poke(at(21, 3, 30));
  assert.equal(n.sleeps(), 1);
});

test('sleep: the keeper asks the engine at most every ten minutes at night, and never by day', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.contextTokens = 100_000;
  let asked = 0;
  const connect = async () => { const client = await engine.connect(); const command = client.command; client.command = (c) => { asked++; return command(c); }; return client; };
  let now = at(20, 12);
  const keeper = startCompanionKeeper({ connect, env, pollMs: 60_000, now: () => now, notify: async () => {} });
  t.after(() => keeper.close());
  await keeper.ready;
  await keeper.poke();
  assert.equal(asked, 0, 'by day the keeper does not ask');
  for (const minute of [0, 3, 9, 10, 15]) { now = at(21, 2, minute); await keeper.poke(); }
  assert.equal(asked, 2, 'at 02:00 and 02:10');
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
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { enabled: false } }, env);
  seedPromptPieces({ defaultsDir, env });
  const moved = defaultsCopy(t, { soul: '# I am Segno\n\nA new default voice.\n' });
  const engine = fakeEngine();
  const notices = [];
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000, defaultsDir: moved,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  await keeper.poke();
  assert.deepEqual(notices.map((notice) => notice.what), ['persona-review']);
  assert.match(notices[0].text, /Rubato's default soul changed/);
  assert.match(notices[0].text, new RegExp(path.join(moved, 'soul.pi.md').replace(/[.[\]{}()*+?^$|\\]/g, '\\$&')));
  assert.match(notices[0].text, /prompt\/\.base\/soul\.md/);
  assert.doesNotMatch(notices[0].text, /identity/, 'only the piece that moved');
  assert.doesNotMatch(notices[0].text, /A new default voice/, 'the wake does not carry the default text');
  assert.equal(readFileSync(basePiecePath(env, 'soul'), 'utf8').trim(), '# I am Segno\n\nA new default voice.',
    'the base moved to the default Segno was told about');
  await keeper.poke();
  assert.equal(notices.length, 1, 'the same default does not wake it twice');
  const again = defaultsCopy(t, { soul: '# I am Segno\n\nA third default voice.\n' });
  const next = startKeeper({ connect: engine.connect, env, pollMs: 60_000, defaultsDir: again,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => next.close());
  await next.ready;
  await next.poke();
  assert.deepEqual(notices.map((notice) => notice.what), ['persona-review', 'persona-review'],
    'a newer default is a new review');
});

test('a default that changes while the engine runs waits for the next engine start', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { enabled: false } }, env);
  const under = defaultsCopy(t);
  seedPromptPieces({ defaultsDir: under, env });
  const engine = fakeEngine();
  const notices = [];
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000, defaultsDir: under,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  await keeper.poke();
  assert.deepEqual(notices, []);
  // The defaults folder changes under a running engine: no polling, so nothing is sent.
  writeFileSync(path.join(under, 'soul.pi.md'), '# changed while running\n');
  await keeper.poke();
  assert.deepEqual(notices, []);
});

test('the page can ask Segno to review even when no default moved', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true, heartbeat: { enabled: false }, dailyReport: { enabled: false } }, env);
  const engine = fakeEngine();
  const notices = [];
  const keeper = startKeeper({ connect: engine.connect, env, pollMs: 60_000, defaultsDir,
    notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  await keeper.poke();
  assert.deepEqual(notices, []);
  requestPersonaReview(env);
  await keeper.poke();
  assert.deepEqual(notices.map((notice) => notice.what), ['persona-review']);
  assert.match(notices[0].text, /The user asked you to look over who you are/);
  assert.match(notices[0].text, new RegExp(defaultsDir.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&')));
  assert.equal(readPersonaReviewRequest(env), undefined, 'the request is cleared once Segno is told');
  await keeper.poke();
  assert.equal(notices.length, 1, 'a request does not repeat by itself');
});

// ── heartbeat: Roo's tick, ported ───────────────────────────────────────────────────────────

/** A day with the heartbeat on every 30 minutes and Segno's session file under the test's control. */
async function heartbeatDay(t, { entries = [], start = at(20, 12), env = sandbox(t) } = {}) {
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, dailyReport: { enabled: false } }, env);
  const engine = fakeEngine();
  engine.sessionFile = path.join(path.dirname(env.RUBATO_COMPANION_HOME), 'segno.jsonl');
  const write = (list) => writeFileSync(engine.sessionFile, [{ type: 'session', id: 'segno' }, ...list].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  write(entries);
  const clock = { at: start };
  const notices = [];
  const errors = [];
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => clock.at, defaultsDir,
    onError: (error) => errors.push(error), notify: async (_sessionId, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  t.after(() => assert.deepEqual(errors, []));
  const poke = async (time) => { clock.at = time; await keeper.poke(); };
  const lines = () => notices.filter((notice) => notice.what === 'heartbeat').map((notice) => notice.text);
  return { env, keeper, poke, write, lines, notices: () => notices };
}
const firstLine = (text) => text.split('\n')[0];

test("heartbeat: Roo's line — HEARTBEAT tick=N kst=\"…\", and nothing else on a plain tick", () => {
  const moment = Date.UTC(2026, 9, 20, 9, 30); // 18:30 in Seoul
  assert.equal(kstLabel(moment), '10월 20일(화) 오후 6:30');
  assert.equal(heartbeatText({ tick: 2, at: moment }), 'HEARTBEAT tick=2 kst="10월 20일(화) 오후 6:30"');
  assert.equal(heartbeatText({ tick: 3, at: moment, action: 'reflect' }), 'HEARTBEAT tick=3 kst="10월 20일(화) 오후 6:30" action=reflect');
  assert.equal(kstLabel(Date.UTC(2026, 9, 19, 15, 5)), '10월 20일(화) 오전 12:05');
});

test('heartbeat: ticks land on :00 and :30, count up while the user is away, and reflect on 3, 6 and 9 only', async (t) => {
  const { poke, lines } = await heartbeatDay(t, { start: at(20, 12, 10) });
  await poke(at(20, 12, 29));
  assert.equal(lines().length, 0, 'the first boundary is 12:30');
  for (let n = 0; n < 12; n += 1) await poke(at(20, 12, 30) + n * 30 * 60_000);
  assert.deepEqual(lines().map((line) => line.replace(/ kst="[^"]*"/, '')), [
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
  assert.match(lines().at(-1), /^HEARTBEAT tick=0 kst=/, 'they wrote ten minutes ago');
  await poke(at(20, 14));
  assert.match(lines().at(-1), /^HEARTBEAT tick=1 kst=/, 'forty minutes since their last word');
  write([userMessage(at(20, 13, 20)), userMessage(at(20, 14, 10))]);
  await poke(at(20, 15));
  assert.match(lines().at(-1), /^HEARTBEAT tick=1 kst=/, 'they wrote between ticks, more than thirty minutes ago: reset, then one');
});

test('heartbeat: the tick survives an engine restart', async (t) => {
  const env = sandbox(t);
  const first = await heartbeatDay(t, { env });
  await first.poke(at(20, 12, 30));
  await first.poke(at(20, 13));
  await first.keeper.close();
  const second = await heartbeatDay(t, { env, start: at(20, 13, 10) });
  await second.poke(at(20, 13, 30));
  assert.match(second.lines().at(-1), /^HEARTBEAT tick=3 kst="[^"]*" action=reflect$/);
});

test('heartbeat: while a wake wish waits no tick is sent but they are counted; its tick reflects with the reason, once', async (t) => {
  const { env, poke, lines } = await heartbeatDay(t);
  setWakeWish({ target: '15:10', reason: '로그인 버그 리드가 끝났는지 본다' }, { now: at(20, 12, 5), env });
  for (const time of [at(20, 12, 30), at(20, 13), at(20, 13, 30), at(20, 14), at(20, 14, 30), at(20, 15)]) await poke(time);
  assert.equal(lines().length, 0, 'Segno rests: no tick until the wish');
  await poke(at(20, 15, 30));
  const due = lines().at(-1).split('\n');
  assert.match(due[0], /^HEARTBEAT tick=7 kst="[^"]*" action=reflect reason=wake_wish$/, 'the rest counted as seven ticks away');
  assert.equal(due[1], 'WAKE_WISH at=2026-10-20T15:10:00+09:00 clamped=0 reason=로그인 버그 리드가 끝났는지 본다');
  assert.equal(readWakeWish(env), undefined, 'the wish is used up');
  await poke(at(20, 16));
  assert.equal(firstLine(lines().at(-1)).replace(/ kst="[^"]*"/, ''), 'HEARTBEAT tick=8');
});

test('heartbeat: a wake wish keeps the ticks quiet while the user is here too, and does not hold back the daily report', async (t) => {
  const { env, poke, write, lines, notices } = await heartbeatDay(t, { start: at(20, 8) });
  writeSettings({ dailyReport: { enabled: true, time: '09:00' } }, env);
  setWakeWish({ target: '120', reason: '오전에 다시' }, { now: at(20, 8, 5), env });
  write([userMessage(at(20, 8, 50))]);
  await poke(at(20, 9));
  await poke(at(20, 9, 1));
  assert.deepEqual(notices().map((notice) => notice.what), ['daily-report']);
  assert.equal(lines().length, 0);
});

test('heartbeat: a wish further than six hours from when it was set comes due at six, marked clamped', async (t) => {
  const { env, poke, lines } = await heartbeatDay(t);
  setWakeWish({ target: String(10 * 60), reason: '저녁에' }, { now: at(20, 12), env });
  await poke(at(20, 17, 30));
  assert.equal(lines().length, 0);
  await poke(at(20, 18));
  assert.match(lines().at(-1), /\nWAKE_WISH at=2026-10-20T18:00:00\+09:00 clamped=1 reason=저녁에$/);
});

test('nextBoundary: the interval on the local clock', () => {
  assert.equal(nextBoundary(at(20, 12, 10), 30 * 60_000), at(20, 12, 30));
  assert.equal(nextBoundary(at(20, 12, 30), 30 * 60_000), at(20, 13));
  assert.equal(nextBoundary(at(20, 12, 50), 15 * 60_000), at(20, 13));
});
