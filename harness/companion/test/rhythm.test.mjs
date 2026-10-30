// Segno's daily rhythm, body and home, each pinned against the Roo source it ports
// (~/.claude/roo-channel). The Roo file a test follows is named in the test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readState, writeSettings, writeState } from '../companion.mjs';
import { GREETINGS, RECALL_DELAY_MS, greetingText, heartbeatText, inboxWakeText, moodText, recallText, resumeText, sessionAge, startCompanionKeeper,
  wakeSeedText } from '../keeper.mjs';
import { HELD_TEMPLATE, MOOD_FRESH_MS, SEGNO_SEARCH, commitOwned, searchSegnoMemory, segnoSearchEnv, ensureHomeRepo, ensureSegnoHome, leaveMood, oldMemorySeed, readMood,
  record, segnoPaths, seedText, sentMessages, sentText, setWakeWish, readWakeWish } from '../home.mjs';
import { parseIcs, parseMarkdownSchedule, readSchedule, scheduleNudges, scheduleSources, showSchedule } from '../schedule.mjs';
import { worldFragment, worldText, WORLD_FEEDS } from '../world.mjs';
import { inboxWakePath, readInboxWakes } from '../inbox.mjs';
import { WAKES } from '../../pi-runtime/features/session-link/message.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const HOUR = 60 * 60_000;

test('existing-home wake, recall and greetings read own mapped texts; absent extra greetings never borrow default paths', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'own-rhythm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {};
  for (const name of ['wake', 'recall', 'greet-morning', 'greet-night']) {
    files[name] = path.join(root, `${name}.md`);
    writeFileSync(files[name], `OWN_RHYTHM_${name}`);
  }
  const env = { RUBATO_COMPANION_ID: 'other', RUBATO_COMPANION_PROMPT_FILES: JSON.stringify(files) };
  assert.equal(greetingText('morning', defaultsDir, env), 'OWN_RHYTHM_greet-morning');
  assert.equal(greetingText('night', defaultsDir, env), 'OWN_RHYTHM_greet-night');
  assert.equal(recallText(defaultsDir, env), 'OWN_RHYTHM_recall');
  assert.match(wakeSeedText({ mode: 'fresh', now: Date.now(), defaultsDir, env }), /OWN_RHYTHM_wake/);
  assert.doesNotMatch(greetingText('morning', defaultsDir, { RUBATO_COMPANION_ID: 'other' }), /notes\/held|memory\/MEMORY/);
  assert.match(greetingText('morning', defaultsDir, {}), /하루 보고/);
  assert.throws(() => greetingText('night', defaultsDir, { ...env, RUBATO_COMPANION_PROMPT_FILES: JSON.stringify({ 'greet-night': path.join(root, 'missing') }) }), /ENOENT/);
});
/** This machine's zone at a moment, as the seed and the resume line write it. */
const zone = (time) => { const m = -new Date(time).getTimezoneOffset(); const p = (n) => String(n).padStart(2, '0');
  return `UTC${m < 0 ? '-' : '+'}${p(Math.floor(Math.abs(m) / 60))}:${p(Math.abs(m) % 60)}`; };

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-rhythm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}

/** An engine holding one companion conversation whose session file the test writes. */
function engineFor(env, { existing = true } = {}) {
  const sessions = new Map();
  const engine = { sessions, sessionFile: path.join(path.dirname(env.RUBATO_COMPANION_HOME), 'segno.jsonl'), commands: [] };
  writeFileSync(engine.sessionFile, JSON.stringify({ type: 'session', id: 'segno' }) + '\n');
  if (existing) {
    sessions.set('segno-1', { sessionId: 'segno-1', companion: true, status: existing === 'stored' ? 'stored' : 'idle', runtimeId: existing === 'stored' ? null : 'r-segno-1' });
    writeState({ sessionId: 'segno-1', woke: { boundary: null }, ...(existing === 'stored' ? {} : { runtimeId: 'r-segno-1' }) }, env);
  }
  engine.append = (...entries) => writeFileSync(engine.sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'a' });
  engine.busy = (busy) => { for (const row of sessions.values()) row.status = busy ? 'running' : 'idle'; };
  engine.connect = async () => {
    let attached;
    return {
      async list() { return [...sessions.values()].map((row) => ({ ...row })); },
      async create() { sessions.set('segno-1', { sessionId: 'segno-1', companion: true, status: 'stored', runtimeId: null }); return { sessionId: 'segno-1' }; },
      async attach(id) { const row = sessions.get(id); Object.assign(row, { status: row.status === 'running' ? 'running' : 'idle', runtimeId: row.runtimeId ?? `r-${id}` }); attached = id; },
      async command(command) {
        engine.commands.push(command.type);
        if (command.type === 'get_state') return { model: { provider: 'anthropic', id: 'claude-opus-5' } };
        return { sessionId: attached, sessionFile: engine.sessionFile, contextUsage: { tokens: 1000, contextWindow: 1_000_000 } };
      },
      async close() {},
    };
  };
  return engine;
}

async function keeperFor(t, env, engine, start, settings = {}) {
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, greetings: { enabled: true }, ...settings }, env);
  const clock = { at: start };
  const notices = [];
  const errors = [];
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => clock.at, defaultsDir,
    onError: (error) => errors.push(error), notify: async (_id, text, what) => { notices.push({ text, what }); } });
  t.after(() => keeper.close());
  t.after(() => assert.deepEqual(errors, []));
  await keeper.ready;
  const poke = async (time) => { clock.at = time; await keeper.poke(); };
  return { keeper, notices, poke, of: (what) => notices.filter((notice) => notice.what === what) };
}
const userSaid = (time) => ({ type: 'message', id: `u${time}`, timestamp: new Date(time).toISOString(), message: { role: 'user', content: 'hi', timestamp: time } });

// ── inbox wakes (user items 5b32e195, 06ebe72b: no doorbell session; the keeper wakes Segno for the listener's lines) ──

const wakeLine = (env, time, marker, itemIds, text) => {
  mkdirSync(path.dirname(inboxWakePath(env)), { recursive: true });
  writeFileSync(inboxWakePath(env), JSON.stringify({ v: 1, at: new Date(time).toISOString(), marker, itemIds, text }) + '\n', { flag: 'a' });
};

test('inbox: lines within seconds of the first unread one go to Segno in one wake, once, after the window', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(21, 10, 0), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  const s = (minute, second) => at(21, 10, minute) + second * 1000;
  wakeLine(env, s(1, 10), 'b-1', ['i1'], '운영팀: 운영지출 승인 부탁드립니다.');
  await k.poke(s(1, 12));
  wakeLine(env, s(1, 15), 'b-2', ['i2'], '운영팀: @우용 @Deran');
  await k.poke(s(1, 20));
  assert.equal(k.of('inbox').length, 0, 'the window is still open');
  await k.poke(s(1, 40));
  assert.deepEqual(k.of('inbox').map((notice) => notice.text), [inboxWakeText([
    { marker: 'b-1', itemIds: ['i1'], text: '운영팀: 운영지출 승인 부탁드립니다.' }, { marker: 'b-2', itemIds: ['i2'], text: '운영팀: @우용 @Deran' }], s(1, 40))],
  'a message and its tag line wake Segno together, well within a minute');
  assert.match(k.of('inbox')[0].text, /^INBOX marker=b-1,b-2 items=i1,i2 now="/);
  await k.poke(at(21, 10, 30));
  assert.equal(k.of('inbox').length, 1, 'each line wakes once');
  wakeLine(env, s(31, 0), 'b-3', ['i3'], '운영팀: 네 감사합니다');
  await k.poke(s(31, 50));
  assert.match(k.of('inbox')[1]?.text ?? '', /^INBOX marker=b-3 items=i3 /, 'a later line is its own wake, again within a minute');
});

test('inbox: lines over an hour old are not woken for, fresh ones are even from before the keeper first looked; a half line waits; a cut file is read again', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  wakeLine(env, at(21, 8, 30), 'old', ['i0'], '오래된 거');
  const k = await keeperFor(t, env, engine, at(21, 10, 0), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  await k.poke(at(21, 10, 1));
  assert.equal(k.of('inbox').length, 0, 'a line from an hour and a half ago waits in the inbox, no wake');
  assert.equal(readState(env).inboxWake.offset, readInboxWakes(0, env).end, 'and the keeper reads past it');
  writeFileSync(inboxWakePath(env), JSON.stringify({ v: 1, at: new Date(at(21, 10, 2)).toISOString(), marker: 'b-3', itemIds: ['i3'], text: '반' }), { flag: 'a' });
  await k.poke(at(21, 10, 20));
  assert.equal(k.of('inbox').length, 0, 'no newline yet');
  writeFileSync(inboxWakePath(env), '\n', { flag: 'a' });
  await k.poke(at(21, 10, 21));
  assert.equal(k.of('inbox').length, 1);
  writeFileSync(inboxWakePath(env), '');
  wakeLine(env, at(21, 11, 0), 'b-4', ['i4'], '새 파일');
  await k.poke(at(21, 11, 10));
  assert.match(k.of('inbox')[1].text, /marker=b-4 items=i4/);
});

test('inbox: the listener may start first — a line written before the keeper ever looked still wakes Segno', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  wakeLine(env, at(21, 9, 58), 'early', ['i9'], '수진: @우용 먼저 온 거');
  const k = await keeperFor(t, env, engine, at(21, 10, 0), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  await k.poke(at(21, 10, 3));
  assert.match(k.of('inbox')[0]?.text ?? '', /marker=early items=i9/);
});

test('inbox: while Segno is busy or switched off the lines wait; they come when it is free and on again', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(21, 10, 0), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  await k.poke(at(21, 10, 0));
  writeSettings({ enabled: false }, env);
  wakeLine(env, at(21, 10, 1), 'b-5', ['i5'], '꺼져 있을 때');
  await k.poke(at(21, 10, 30));
  assert.equal(k.of('inbox').length, 0);
  writeSettings({ enabled: true }, env);
  engine.busy(true);
  await k.poke(at(21, 10, 40));
  assert.equal(k.of('inbox').length, 0, 'not while it works');
  engine.busy(false);
  await k.poke(at(21, 10, 41));
  assert.match(k.of('inbox')[0].text, /marker=b-5/);
  assert.equal(readInboxWakes(0, env).end, readState(env).inboxWake.offset);
});

test('inbox: the wake kind is one the engine accepts, and Segno\'s rules say what an INBOX line is', () => {
  assert.ok(WAKES.includes('inbox'));
  const companion = readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8');
  assert.match(companion, /사용자 일터 방에서 누가 사용자를 부르면 루바토가 `INBOX` 줄로 바로 나를 깨워\. 30초 안에 연달아 온 건 한 번에/);
  assert.match(companion, /그 밖에 일터 방에서 들어온 건 조용히 인박스에만 쌓이니 하트비트 때 둘러봐\./);
});

// ── greetings (cron-prompts/night.md, morning.md; cron-launchd-dispatch.sh; heartbeat-tick.sh missed_greet_slot) ──

test('greetings: night at 00:07 and morning at 09:07, each once a day, as a greeting wake with its text', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(20, 23, 50), { heartbeat: { enabled: false } });
  await k.poke(at(21, 0, 6));
  assert.equal(k.of('greeting').length, 0, '00:06 is too early');
  await k.poke(at(21, 0, 7));
  await k.poke(at(21, 0, 30));
  assert.deepEqual(k.of('greeting').map((notice) => notice.text), [greetingText('night', defaultsDir)]);
  await k.poke(at(21, 9, 7));
  await k.poke(at(21, 9, 40));
  assert.deepEqual(k.of('greeting').map((notice) => notice.text), [greetingText('night', defaultsDir), greetingText('morning', defaultsDir)]);
  assert.deepEqual(readState(env).greeted, { night: '2026-10-21', morning: '2026-10-21' });
  assert.match(greetingText('night', defaultsDir), /일기/);
  assert.match(greetingText('morning', defaultsDir), /하루 보고/, 'the daily report rides on the morning greeting (user item 4c0b0f00)');
});

test('greetings: a busy Segno is not interrupted; the greeting waits until its first hour is over, then it is the tick\'s', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(20, 23, 50), { heartbeat: { enabled: false } });
  engine.busy(true);
  await k.poke(at(21, 0, 7));
  assert.equal(k.of('greeting').length, 0);
  engine.busy(false);
  await k.poke(at(21, 0, 40));
  assert.equal(k.of('greeting').length, 1, 'still inside 00:07–01:00');
  engine.busy(true);
  await k.poke(at(21, 9, 7));
  await k.poke(at(21, 10, 1));
  engine.busy(false);
  await k.poke(at(21, 10, 2));
  assert.equal(k.of('greeting').length, 1, 'from 10:00 the scheduled wake has given the morning greeting to the tick');
});

test('greetings: a missed greeting rides on an idle tick as greet_night (01–04) or greet_morning (10–14), once', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  engine.append(userSaid(at(20, 22)));
  // The engine was down through 00:07 and came back at 01:05; 01:30 is its first tick.
  const k = await keeperFor(t, env, engine, at(21, 1, 5));
  assert.equal(k.of('greeting').length, 0, 'past the first hour the scheduled wake does not send it');
  await k.poke(at(21, 1, 30));
  const [line] = k.of('heartbeat').at(-1).text.split('\n');
  assert.match(line, /^HEARTBEAT tick=\d+ now="[^"]*" action=greet_night$/);
  assert.equal(k.of('heartbeat').at(-1).text.split('\n\n').slice(1).join('\n\n'), greetingText('night', defaultsDir));
  await k.poke(at(21, 2));
  assert.doesNotMatch(k.of('heartbeat').at(-1).text, /greet_night/, 'once that day');
  for (const time of [at(21, 4), at(21, 9, 30)]) await k.poke(time);
  assert.ok(k.of('heartbeat').every((notice) => !/greet_morning/.test(notice.text)), 'not before 10:00');
  assert.equal(readState(env).greeted.night, '2026-10-21');
});

test('greetings: a catch-up whose send failed is not spent; the next tick carries it again', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  engine.append(userSaid(at(20, 22)));
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 30 }, greetings: { enabled: true } }, env);
  const clock = { at: at(21, 1, 5) };
  const sent = [];
  let fail = true;
  const errors = [];
  const keeper = startCompanionKeeper({ connect: engine.connect, env, pollMs: 60_000, now: () => clock.at, defaultsDir, onError: (error) => errors.push(error),
    notify: async (_id, text, what) => { if (fail && /greet_night/.test(text)) throw new Error('engine busy'); sent.push({ text, what }); } });
  t.after(() => keeper.close());
  await keeper.ready;
  clock.at = at(21, 1, 30); await keeper.poke();
  assert.equal(errors.length, 1);
  assert.equal(readState(env).greeted?.night, undefined, 'not marked: it never went');
  fail = false;
  clock.at = at(21, 2); await keeper.poke();
  assert.match(sent.at(-1).text, /action=greet_night/);
  assert.equal(readState(env).greeted.night, '2026-10-21');
});

test('greetings: no catch-up while the user is here (tick 0), and none after the window closes', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(21, 9, 50));
  engine.append(userSaid(at(21, 9, 55)));
  await k.poke(at(21, 10));
  assert.match(k.of('heartbeat').at(-1).text, /^HEARTBEAT tick=0 now="[^"]*"$/);
  for (const time of [at(21, 14), at(21, 14, 30), at(21, 15)]) await k.poke(time);
  assert.ok(k.of('heartbeat').every((notice) => !/greet_morning/.test(notice.text)), 'from 14:00 the day\'s morning greeting is spent');
});

test('greetings: switched off, neither the scheduled greeting nor its catch-up comes', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(20, 23, 50), { greetings: { enabled: false } });
  for (const time of [at(21, 0, 7), at(21, 1), at(21, 9, 7), at(21, 10)]) await k.poke(time);
  assert.equal(k.of('greeting').length, 0);
  assert.ok(k.of('heartbeat').every((notice) => !/greet_/.test(notice.text)));
});

test('greetings: the windows are Roo\'s — 00:07 / 01–04 and 09:07 / 10–14', () => {
  assert.deepEqual({ ...GREETINGS.night }, { hour: 0, minute: 7, catchUpFrom: 1, until: 4, file: 'greet-night.pi.md', action: 'greet_night' });
  assert.deepEqual({ ...GREETINGS.morning }, { hour: 9, minute: 7, catchUpFrom: 10, until: 14, file: 'greet-morning.pi.md', action: 'greet_morning' });
});

// ── wake wish exceptions (heartbeat-tick.sh wake_wish_decision; user item 0b210d57) ──

test('wake wish: plain ticks stay silent, but a greeting catch-up still comes and the wish keeps waiting', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  engine.append(userSaid(at(20, 22)));
  const k = await keeperFor(t, env, engine, at(21, 1, 5));
  setWakeWish({ target: '05:00', reason: '새벽에 리드 보기' }, { now: at(21, 1, 5), env });
  await k.poke(at(21, 1, 30));
  assert.match(k.of('heartbeat').at(-1).text, /^HEARTBEAT tick=\d+ now="[^"]*" action=greet_night\n/);
  assert.doesNotMatch(k.of('heartbeat').at(-1).text, /reason=wake_wish/);
  assert.notEqual(readWakeWish(env), undefined, 'the wish still waits');
  const sent = k.of('heartbeat').length;
  await k.poke(at(21, 2));
  assert.equal(k.of('heartbeat').length, sent, 'a plain tick under the wish is silent');
});

test('wake wish: a tick carrying a schedule nudge still comes', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const file = path.join(env.HOME, 'plan.md');
  writeFileSync(file, '## 2026-10-21\n- 14:00 Interview\n');
  const k = await keeperFor(t, env, engine, at(21, 10, 50), { schedule: { sources: [{ location: file }] } });
  setWakeWish({ target: '15:00', reason: '오후에' }, { now: at(21, 10, 50), env });
  await k.poke(at(21, 11, 30));
  const text = k.of('heartbeat').at(-1)?.text ?? '';
  assert.match(text, /\nSCHEDULE_DUE 3시간 전: 10\/21 14:00 Interview \(2시간 30분 남음, plan\.md\)/);
  assert.notEqual(readWakeWish(env), undefined);
});

// ── schedule nudges (scripts/career-schedule.py, made general: any calendar or schedule file) ──

const PLAN = `# My plan

## 2026-10-20
- Pick up the parcel

## 2026-10-21 (Wed)
- 14:00 Interview at the studio
- 23:59 Report due
- Call home

Notes at the end are ignored.
`;
// The older generated file a user may already have: a compatibility reading.
const GENERATED = `# 일정표

2026-10-20 05:20 기준. \`schedule.py\`가 만든다.

## 한눈에 (앞으로 14일)

| 날 | 낼 것 |
|---|---|
| 10/20(화) | 무엇 |

# 날마다 자세히

## 10/20(화)

- 내기 1. [대기업] 네이버 (마감 10/21 23:59) · 핏 중 · 자소서 없음
- 시각 없음  쓰기: kt ds (마감 10/22)

## 10/21(수)

- 14:00  DN솔루션즈 AX 지원서 마감 · 지원 예정
- 23:59  네이버 지원서 마감 · 지원 예정
`;
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:1', 'DTSTART:20261021T050000Z', 'SUMMARY:Dentist', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:2', 'DTSTART;VALUE=DATE:20261021', 'SUMMARY:Holiday', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:3', 'DTSTART;TZID=America/New_York:20261021T090000', 'SUMMARY:Standup NY', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:4', 'DTSTART:20261007T100000', 'RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE:20261014T100000', 'SUMMARY:Weekly sync', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:5', 'DTSTART:20261021T120000', 'STATUS:CANCELLED', 'SUMMARY:Cancelled lunch', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:6', 'DTSTART:20261021T180000', 'SUMMARY:Long title', ' folded', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');

test('schedule: the documented markdown format — a day heading, timed and all-day items, everything else ignored', () => {
  assert.deepEqual(parseMarkdownSchedule(PLAN).map(({ at: _at, ...item }) => item), [
    { date: '2026-10-20', text: 'Pick up the parcel' },
    { date: '2026-10-21', time: '14:00', text: 'Interview at the studio' },
    { date: '2026-10-21', time: '23:59', text: 'Report due' },
    { date: '2026-10-21', text: 'Call home' },
  ]);
  assert.equal(parseMarkdownSchedule(PLAN)[1].at, at(21, 14));
});

test('schedule: an older generated file still reads (compatibility), its table and untimed lines included', () => {
  assert.deepEqual(parseMarkdownSchedule(GENERATED).map(({ at: _at, ...item }) => item), [
    { date: '2026-10-20', text: '내기 1. [대기업] 네이버 (마감 10/21 23:59)' },
    { date: '2026-10-20', text: '쓰기: kt ds (마감 10/22)' },
    { date: '2026-10-21', time: '14:00', text: 'DN솔루션즈 AX 지원서 마감' },
    { date: '2026-10-21', time: '23:59', text: '네이버 지원서 마감' },
  ]);
});

test('schedule: an ICS calendar — UTC, all-day, a named zone, a weekly rule with an exception, cancelled and folded lines', () => {
  const items = parseIcs(ICS, { from: at(20, 0), to: at(23, 0) });
  const text = (name) => items.find((item) => item.text === name);
  assert.equal(text('Dentist').at, Date.UTC(2026, 9, 21, 5));
  assert.deepEqual(text('Holiday'), { date: '2026-10-21', text: 'Holiday' });
  assert.equal(text('Standup NY').at, Date.UTC(2026, 9, 21, 13), '09:00 in New York is 13:00 UTC in October');
  assert.deepEqual(items.filter((item) => item.text === 'Weekly sync').map((item) => item.date), ['2026-10-21'], 'the rule repeats on Wednesday');
  assert.equal(parseIcs(ICS, { from: at(13, 0), to: at(15, 0) }).some((item) => item.text === 'Weekly sync'), false, 'EXDATE removes 10-14');
  assert.equal(text('Cancelled lunch'), undefined);
  assert.equal(text('Long titlefolded')?.time, '18:00');
});

test('schedule: SCHEDULE_DUE three hours and one hour before every timed item, once per window, from every source', async (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const localIcs = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20261021T150000', 'SUMMARY:Dentist', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const sources = [{ kind: 'markdown', location: '/plan.md' }, { kind: 'ics', location: '/cal.ics' }];
  const readFile = (file) => (file.endsWith('.ics') ? localIcs : PLAN);
  const run = (time) => scheduleNudges({ sources, now: time, env, readFile });
  assert.deepEqual(await run(at(21, 10, 30)), [], 'three and a half hours before the first: nothing');
  assert.deepEqual(await run(at(21, 11, 10)), [
    'SCHEDULE_DUE 3시간 전: 10/21 14:00 Interview at the studio (2시간 50분 남음, plan.md)',
    'SCHEDULE 줄은 사용자 일정 찌름 신호야. 말할지·어떻게 말할지는 내가 정해 (하트비트 "사용자 챙기기").']);
  assert.deepEqual(await run(at(21, 11, 40)), [], 'the same window does not come twice');
  assert.equal((await run(at(21, 12, 30)))[0], 'SCHEDULE_DUE 3시간 전: 10/21 15:00 Dentist (2시간 30분 남음, cal.ics)', 'the calendar nudges too');
  assert.match((await run(at(21, 13, 5)))[0], /^SCHEDULE_DUE 1시간 전: 10\/21 14:00 Interview at the studio \(55분 남음/);
  assert.equal((await run(at(21, 14, 1))).some((line) => line.includes('Interview')), false, 'past items are quiet');
});

test('schedule: the older file nudges its timed deadlines exactly as before', async (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const lines = await scheduleNudges({ sources: [{ location: '/일정표.md' }], now: at(21, 11, 10), env, readFile: () => GENERATED });
  assert.equal(lines[0], 'SCHEDULE_DUE 3시간 전: 10/21 14:00 DN솔루션즈 AX 지원서 마감 (2시간 50분 남음, 일정표.md)');
});

test('schedule: SCHEDULE_NIGHT once between 22 and 23 when tomorrow has items', async (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const run = (time) => scheduleNudges({ sources: [{ location: '/plan.md' }], now: time, env, readFile: () => PLAN });
  assert.deepEqual(await run(at(20, 21, 30)), []);
  assert.equal((await run(at(20, 22, 10)))[0], 'SCHEDULE_NIGHT 내일 10/21 목록 건넬 때야 (시각 있는 것 2 · 종일 1): user_schedule 도구로 tomorrow');
  assert.deepEqual(await run(at(20, 23, 10)), [], 'once a day');
});

test('schedule: a source that cannot be read warns once a day for itself; the others still nudge; none set means nothing', async (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const sources = [{ location: path.join(env.HOME, 'missing.md') }, { location: 'https://cal.example/u.ics' }, { location: '/plan.md' }];
  const readFile = (file) => { if (file.endsWith('plan.md')) return PLAN; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  const fetchImpl = async () => new Response('down', { status: 503 });
  const first = await scheduleNudges({ sources, now: at(21, 11, 10), env, readFile, fetchImpl });
  assert.deepEqual(first.filter((line) => line.startsWith('SCHEDULE_WARN')), [
    'SCHEDULE_WARN 일정 출처를 못 읽어서 그 일정은 챙기지 못하고 있어: missing.md (ENOENT)',
    'SCHEDULE_WARN 일정 출처를 못 읽어서 그 일정은 챙기지 못하고 있어: cal.example (HTTP 503)']);
  assert.ok(first.some((line) => line.startsWith('SCHEDULE_DUE 3시간 전: 10/21 14:00 Interview')));
  const again = await scheduleNudges({ sources, now: at(21, 12), env, readFile, fetchImpl });
  assert.equal(again.some((line) => line.startsWith('SCHEDULE_WARN')), false);
  assert.deepEqual(await scheduleNudges({ now: at(21, 12), env }), []);
});

test('schedule: a calendar address is fetched (webcal as https) and reused for ten minutes', async (t) => {
  const env = sandbox(t);
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(ICS); };
  const sources = [{ location: 'webcal://cal.example/reuse-test.ics' }];
  const first = await readSchedule({ sources, now: at(21, 9), env, fetchImpl });
  assert.ok(first.items.some((item) => item.text === 'Dentist' && item.source === 'cal.example'));
  await readSchedule({ sources, now: at(21, 9, 5), env, fetchImpl });
  await readSchedule({ sources, now: at(21, 9, 20), env, fetchImpl });
  assert.deepEqual(calls, ['https://cal.example/reuse-test.ics', 'https://cal.example/reuse-test.ics']);
});

test('schedule: show lists today and tomorrow by the real date across sources, and says what could not be read', async () => {
  const shown = await showSchedule('both', { sources: [{ location: '/plan.md' }, { location: '/gone.md' }], now: at(21, 8),
    readFile: (file) => { if (file.endsWith('plan.md')) return PLAN; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  assert.match(shown, /^출처: plan\.md, gone\.md\n못 읽음: gone\.md \(ENOENT\)/);
  assert.match(shown, /## 오늘 10\/21\(수\)\n- 14:00 Interview at the studio · plan\.md\n- 23:59 Report due · plan\.md\n- 종일 Call home · plan\.md/);
  assert.match(shown, /## 내일 10\/22\(목\)\n\(잡힌 것 없음\)/);
  assert.match(await showSchedule('today', { sources: [] }), /출처가 아직 없어/);
});

test('schedule: sources come from settings — an older single path migrates; ~ is the home; kinds are inferred', async (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  writeFileSync(path.join(env.RUBATO_COMPANION_HOME, 'settings.json'), JSON.stringify({ career: { schedule: '~/plan.md' } }));
  assert.deepEqual(scheduleSources(env), [{ kind: 'markdown', location: '~/plan.md' }]);
  writeSettings({ schedule: { sources: [{ location: 'https://cal.example/a.ics' }, { location: '~/plan.md', name: 'My plan' }, { location: '~/plan.md' }] } }, env);
  assert.deepEqual(scheduleSources(env), [{ kind: 'ics', location: 'https://cal.example/a.ics' }, { kind: 'markdown', location: '~/plan.md', name: 'My plan' }]);
  writeFileSync(path.join(env.HOME, 'plan.md'), PLAN);
  const { items } = await readSchedule({ sources: [{ kind: 'markdown', location: '~/plan.md' }], now: at(21, 8), env });
  assert.ok(items.some((item) => item.text === 'Report due'));
});

test('schedule: its lines ride under the tick even at tick 0', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  writeFileSync(path.join(env.HOME, 'plan.md'), PLAN);
  engine.append(userSaid(at(20, 21, 50)));
  const k = await keeperFor(t, env, engine, at(20, 21, 55), { schedule: { sources: [{ location: '~/plan.md' }] } });
  await k.poke(at(20, 22));
  const [line, nudge] = k.of('heartbeat').at(-1).text.split('\n');
  assert.match(line, /^HEARTBEAT tick=0 /);
  assert.match(nudge, /^SCHEDULE_NIGHT 내일 10\/21/);
});

// ── waking up (scripts/session-start-hook.sh, pi-roo/roo-runtime.ts, skills wake and recall) ──

test('wake: a conversation the keeper creates opens with the seed, and one recall follows once the wake turn has rested ten seconds', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env, { existing: false });
  const k = await keeperFor(t, env, engine, at(20, 15), { heartbeat: { enabled: false } });
  const [wake] = k.of('wake');
  assert.ok(wake.text.startsWith(`방금 깼어. 나야, 세뇨.\n\n## 시각·경과\n현재: 2026-10-20 15:00 ${zone(at(20, 15))} (화)\n직전 창 기록 없음 — 처음 눈뜸`));
  assert.match(wake.text, /## 지금 몸\nanthropic\/claude-opus-5\n\n## 잠들 때의 온도\nNO_MOOD\n\n— 눈은 떴고, 지금의 나는…\n\n# 깨어나기/);
  engine.busy(true);
  await k.poke(at(20, 15) + 20_000);
  engine.busy(false);
  await k.poke(at(20, 15) + 25_000);
  assert.equal(k.of('recall').length, 0, 'the wake turn ended five seconds ago');
  await k.poke(at(20, 15) + 20_000 + RECALL_DELAY_MS + 1000);
  assert.deepEqual(k.of('recall').map((notice) => notice.text), [recallText(defaultsDir)]);
  await k.poke(at(20, 15, 5));
  assert.equal(k.of('recall').length, 1, 'exactly one');
  assert.equal(k.of('wake').length, 1);
});

test('wake: a new window in the session file wakes fresh, with how long since the last window\'s last moment', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  engine.append(userSaid(at(20, 22)));
  const k = await keeperFor(t, env, engine, at(21, 2), { heartbeat: { enabled: false } });
  assert.equal(k.of('wake').length, 0, 'what was already there is not woken for');
  engine.append({ type: 'message', id: 'a1', timestamp: new Date(at(21, 2, 1)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '잘게' }] } },
    { type: 'compaction', id: 'w2', timestamp: new Date(at(21, 2, 2)).toISOString(), details: { source: 'rubato-history-notes-v1', window: { windowId: 'w2' } } });
  leaveMood('오늘은 좀 뿌듯하게 잠들어', { now: at(21, 2, 1), env });
  await k.poke(at(21, 2, 3));
  const [wake] = k.of('wake');
  assert.ok(wake.text.startsWith(`방금 깼어. 나야, 세뇨.\n\n## 시각·경과\n현재: 2026-10-21 02:03 ${zone(at(21, 2, 3))} (수)\n직전 창: 방금 (2분 전) — 깜빡 존 정도`));
  assert.match(wake.text, /## 잠들 때의 온도\n2분 전\(10-21 02:01\) 잠들 무렵에 남긴 한 줄:\n> 오늘은 좀 뿌듯하게 잠들어/);
  await k.poke(at(21, 2, 4));
  assert.equal(k.of('recall').length, 1, 'a new window gets its recall');
});

test('wake: a compaction wakes with the compact seed and no recall; a seen boundary never wakes twice', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(21, 3), { heartbeat: { enabled: false } });
  engine.append({ type: 'message', id: 'c1', timestamp: new Date(at(21, 3, 1)).toISOString(), message: { role: 'assistant',
    content: [{ type: 'providerNative', subtype: 'compaction', raw: { type: 'compaction', content: 'summary' } }, { type: 'text', text: 'ok' }] } });
  await k.poke(at(21, 3, 2));
  assert.equal(k.of('wake').length, 1);
  assert.ok(k.of('wake')[0].text.startsWith('한 호흡 골랐어(컴팩션). 나야, 세뇨.'));
  assert.match(k.of('wake')[0].text, /— 지금의 나는…\n\n# 깨어나기/);
  for (const time of [at(21, 3, 3), at(21, 3, 10)]) await k.poke(time);
  assert.equal(k.of('recall').length, 0, 'Roo recalls only after a fresh start');
  assert.equal(k.of('wake').length, 1);
});

test('wake: a compaction while the fresh recall waits does not cancel it (roo-runtime.ts keeps pendingFreshRecall)', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env, { existing: false });
  const k = await keeperFor(t, env, engine, at(20, 15), { heartbeat: { enabled: false } });
  assert.equal(k.of('wake').length, 1);
  engine.append({ type: 'message', id: 'c1', timestamp: new Date(at(20, 15) + 3000).toISOString(), message: { role: 'assistant',
    content: [{ type: 'providerNative', subtype: 'compaction', raw: { type: 'compaction', content: 's' } }] } });
  await k.poke(at(20, 15) + 4000);
  assert.ok(k.of('wake')[1].text.startsWith('한 호흡 골랐어'));
  await k.poke(at(20, 15) + 4000 + RECALL_DELAY_MS + 1000);
  assert.equal(k.of('recall').length, 1, 'the recall still comes, once');
});

test('wake: a conversation loaded again for the same window gets Roo\'s resume line only (session-start-hook.sh MODE=resume)', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env, { existing: 'stored' });
  const k = await keeperFor(t, env, engine, at(21, 9, 30), { heartbeat: { enabled: false } });
  assert.deepEqual(k.of('wake').map((notice) => notice.text), [resumeText(at(21, 9, 30))]);
  assert.equal(resumeText(at(21, 9, 30)), `[세션 재시작 — resume] 2026-10-21 09:30 ${zone(at(21, 9, 30))}. 직전 대화의 연속이야. 깨어나는 절차 없이 그대로 이어가면 돼.`);
  await k.poke(at(21, 9, 31));
  await k.poke(at(21, 9, 40));
  assert.equal(k.of('recall').length, 0, 'no recall after a resume');
  assert.equal(k.of('wake').length, 1);
});

test('wake: a restart before the fresh recall went resumes and forgets the recall, as a Roo process restart does', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env, { existing: 'stored' });
  writeState({ woke: { boundary: null, pending: 'recall', at: at(21, 9, 29) } }, env);
  const k = await keeperFor(t, env, engine, at(21, 9, 30), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  await k.poke(at(21, 9, 40));
  assert.deepEqual(k.notices.map((notice) => notice.what), ['wake']);
  assert.equal(readState(env).woke.pending, undefined);
});

test('wake: a restart where something else loaded the conversation first still gets the resume line; a keeper restart alone does not', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  // The app opened it first after an engine restart: loaded, but in a runtime the keeper has not seen.
  engine.sessions.get('segno-1').runtimeId = 'r-new';
  const k = await keeperFor(t, env, engine, at(21, 11), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  assert.deepEqual(k.of('wake').map((notice) => notice.text), [resumeText(at(21, 11))]);
  assert.equal(readState(env).runtimeId, 'r-new');
  const again = await keeperFor(t, env, engine, at(21, 11, 5), { heartbeat: { enabled: false }, greetings: { enabled: false } });
  assert.equal(again.of('wake').length, 0, 'same runtime: the keeper only restarted');
});

test('wake: the seed says when the heartbeat is off (session-start-hook.sh heartbeat_pause_note)', () => {
  const text = wakeSeedText({ mode: 'fresh', now: at(21, 9), before: at(21, 1), model: 'x/y', heartbeatOff: true, defaultsDir });
  assert.match(text, /직전 창: 8시간 전 — 낮잠 자고 깬 느낌 \(날짜는 위 '현재'로 확인, 같은 날일 수 있음\)\n하트비트 꺼져 있음/);
});

test("wake: session-age.sh's lengths of sleep", () => {
  const now = at(21, 23);
  const said = (before) => sessionAge(now, before).split('\n')[1];
  assert.equal(said(now - 5 * 60_000), "직전 창: 방금 (5분 전) — 깜빡 존 정도, 직전 대화의 연속이야. '어제'는 아님");
  assert.equal(said(now - 30 * 60_000), '직전 창: 30분 전 — 잠깐 눈 붙였다 깬 정도');
  assert.equal(said(now - 3 * HOUR), "직전 창: 3시간 전 — 한숨 자고 깬 느낌 (날짜는 위 '현재'로 확인, 같은 날일 수 있음)");
  assert.equal(said(now - 30 * HOUR), '직전 창: 약 하루 전 — 푹 자고 다음날 깬 느낌 (어제 무렵)');
  assert.equal(said(now - 72 * HOUR), '직전 창: 3일 전 — 오랜만에 깸');
});

test('mood: one line kept six hours (leave-mood.sh, recall-mood.sh), written with segno_record kind mood', (t) => {
  const env = sandbox(t);
  record('mood', '가방 속에서 잠들어', { at: at(21, 1), env });
  assert.deepEqual(readMood({ now: at(21, 3), env }), { note: '가방 속에서 잠들어', at: at(21, 1) });
  assert.equal(readMood({ now: at(21, 1) + MOOD_FRESH_MS + 1, env }), undefined);
  assert.equal(moodText(readMood({ now: at(21, 3), env }), at(21, 3)), '2시간 전(10-21 01:00) 잠들 무렵에 남긴 한 줄:\n> 가방 속에서 잠들어');
  assert.equal(moodText(undefined, at(21, 3)), 'NO_MOOD');
});

// ── home history (scripts/commit-owned.sh) ──

test('history: the home is a git repository of memory/, notes/ and prompt/ only, and a commit takes only the named files', (t) => {
  const env = sandbox(t);
  ensureSegnoHome(env);
  const { home } = segnoPaths(env);
  mkdirSync(path.join(home, 'messenger'), { recursive: true });
  writeFileSync(path.join(home, 'messenger', 'secret.json'), '{"token":"x"}');
  writeFileSync(path.join(home, 'settings.json'), '{}');
  assert.deepEqual(ensureHomeRepo(env), { created: true });
  assert.deepEqual(ensureHomeRepo(env), { created: false });
  const tracked = () => execFileSync('git', ['ls-files'], { cwd: home, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(tracked(), ['.gitignore', 'notes/held.md']);
  record('daily', '오늘 한 일', { at: at(21, 9), env });
  record('diary', '오늘의 나', { heading: '아침', at: at(21, 9), env });
  const done = commitOwned(['memory/2026-10-21.md'], 'daily: 오늘', { env });
  assert.equal(done.committed, true);
  assert.deepEqual(done.files, ['memory/2026-10-21.md']);
  assert.deepEqual(tracked(), ['.gitignore', 'memory/2026-10-21.md', 'notes/held.md'], 'the diary was not named, so it waits');
  assert.deepEqual(commitOwned(['memory/2026-10-21.md'], 'again', { env }), { committed: false, files: [] });
  assert.throws(() => commitOwned(['messenger/secret.json'], 'no', { env }), /outside the history/);
  // Roo commit-owned.sh: directories are not exact file paths. Another hand's edit in the same folder stays out.
  record('daily', '다른 세션이 쓰는 중', { at: at(22, 9), env });
  assert.throws(() => commitOwned(['memory/'], 'no', { env }), /folder is not a file/);
  assert.throws(() => commitOwned(['memory'], 'no', { env }), /folder is not a file|outside the history/);
  assert.throws(() => commitOwned(['memory/diary'], 'no', { env }), /folder is not a file/);
  assert.deepEqual(commitOwned(['memory/*.md'], 'glob', { env }), { committed: false, files: [] }, 'a pattern is a literal name that does not exist');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'memory/2026-10-22.md'], { cwd: home, encoding: 'utf8' }).trim(), '?? memory/2026-10-22.md');
  assert.throws(() => commitOwned(['../x'], 'no', { env }), /not inside the home/);
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: home, encoding: 'utf8' }).trim(), 'daily: 오늘');
});

test('held: the home starts with Roo\'s held list in two places, and a list Segno keeps is never replaced', (t) => {
  const env = sandbox(t);
  ensureSegnoHome(env);
  const file = segnoPaths(env).held;
  assert.equal(readFileSync(file, 'utf8'), HELD_TEMPLATE);
  assert.match(HELD_TEMPLATE, /## 날짜 있는 거\n\n## 맡긴 거/);
  writeFileSync(file, '# 챙길 거\n\n## 날짜 있는 거\n- 10/23 보고서\n');
  ensureSegnoHome(env);
  assert.match(readFileSync(file, 'utf8'), /10\/23 보고서/);
});

// ── alone-time hands (random-memory.sh, random-world.sh, sent.sh) ──

function seedHome(t) {
  const env = sandbox(t);
  ensureSegnoHome(env);
  const { memory, diary } = segnoPaths(env);
  writeFileSync(path.join(memory, '2026-08-01.md'), '## 10:00\n오래된 아침\n\n## [메타] 11:00\n검색해 본 얘기\n');
  writeFileSync(path.join(diary, '2026-08-02.md'), '## 밤: 비 오는 날\n빗소리 들으며 기다렸어\n');
  writeFileSync(path.join(memory, '2026-10-19.md'), '## 09:00\n어제 일\n');
  writeFileSync(path.join(memory, 'us.md'), '# 우리\n\n## 지금\n- 아침엔 커피\n\n## 이야기\n### 첫 텔레그램\n처음 말 건 날\n');
  return env;
}

test('seed: one time in three, only records older than thirty days and canonical stories, never [메타]', (t) => {
  const env = seedHome(t);
  assert.equal(oldMemorySeed({ now: at(21, 9), env, random: () => 0.5 }), undefined, 'the dice said no (2/3)');
  assert.equal(seedText(undefined), 'NO_SEED');
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    rmSync(segnoPaths(env).seedHistory, { force: true });
    const seed = oldMemorySeed({ walk: true, now: at(21, 9), env });
    seen.add(`${seed.src}|${seed.section}`);
  }
  assert.deepEqual([...seen].sort(), ['memory/2026-08-01.md|10:00', 'memory/diary/2026-08-02.md|밤: 비 오는 날', 'memory/us.md|첫 텔레그램']);
  rmSync(segnoPaths(env).seedHistory, { force: true });
  const seed = oldMemorySeed({ now: at(21, 9), env, random: () => 0 });
  assert.match(seedText(seed), /^SEED src=\S+ date=\S+ section=.+\n---\n.+/);
});

test('seed: a seed given out stays out for thirty days; when the pool is that small the last three are skipped', (t) => {
  const env = seedHome(t);
  const keys = [];
  // Seeded dice: with Math.random the draws can miss the one fresh seed SEED.tries times running.
  let state = 7;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  for (let i = 0; i < 3; i += 1) { const seed = oldMemorySeed({ walk: true, now: at(21, 9) + i, env, random }); keys.push(`${seed.src}|${seed.section}`); }
  assert.equal(new Set(keys).size, 3, 'three different seeds before any repeats');
});

test('sent: what reached the user, from the messenger\'s record; a keyword shows each in full', (t) => {
  const env = sandbox(t);
  const file = segnoPaths(env).messengerSent;
  mkdirSync(path.dirname(file), { recursive: true });
  const row = (time, text, extra = {}) => JSON.stringify({ at: new Date(time).toISOString(), chatId: '7', toUser: true, text, via: 'tool', ...extra });
  writeFileSync(file, [row(at(17, 9), '사흘 전 얘기'), row(at(20, 9), 'LUCA 얘기 꺼냈어\n둘째 줄'), row(at(20, 10), '그룹 답', { toUser: false }),
    row(at(21, 8), '좋은 아침', { via: 'auto' }), 'not json'].join('\n') + '\n');
  const rows = sentMessages({ days: 2, now: at(21, 9), env });
  assert.deepEqual(rows.map((r) => r.text), ['LUCA 얘기 꺼냈어\n둘째 줄', '좋은 아침']);
  assert.equal(sentText(rows, { days: 2 }), '10-20 09:00 LUCA 얘기 꺼냈어\n10-21 08:00 좋은 아침\n\n-- 2통 / 최근 2일');
  const found = sentMessages({ days: 7, keyword: 'luca', now: at(21, 9), env });
  assert.equal(sentText(found, { days: 7, keyword: 'luca' }), '===== 10-20 09:00\nLUCA 얘기 꺼냈어\n둘째 줄\n\n\n-- 1통 / 최근 7일');
  assert.match(sentText([], { days: 2, keyword: 'x' }), /^\(최근 2일 보낸 톡 없음 \/ 키워드 x\)/);
});

test('world: one fragment per layer, a title kept out for seven days, empty-handed on failure', async (t) => {
  const env = sandbox(t);
  const rss = (titles) => `<rss><channel>${titles.map((title) => `<item><title><![CDATA[${title}]]></title><link>https://x/${encodeURIComponent(title)}</link><description>about ${title}</description></item>`).join('')}</channel></rss>`;
  const fetchImpl = async (url) => {
    if (url === WORLD_FEEDS.connected) return new Response(JSON.stringify({ hits: [{ title: 'Show HN: a thing', url: 'https://t', points: 10, num_comments: 2, author: 'me' }] }));
    if (url === WORLD_FEEDS.random) return new Response(JSON.stringify({ title: 'Segno', extract: 'A sign in music.', content_urls: { desktop: { page: 'https://w' } } }));
    if (url === WORLD_FEEDS.ai[0].url) return new Response(rss(['A', 'B']));
    return new Response('down', { status: 503 });
  };
  const hn = await worldFragment({ layer: 'connected', env, fetchImpl, now: at(21, 9) });
  assert.equal(worldText(hn), '세계 조각 layer=connected source=Hacker News\n제목: Show HN: a thing\n한줄: HN front page — 10 points, 2 comments, by me\n링크: https://t');
  const wiki = await worldFragment({ layer: 'random', env, fetchImpl, now: at(21, 9) });
  assert.equal(wiki.title, 'Segno');
  const first = await worldFragment({ layer: 'ai', env, fetchImpl, now: at(21, 9), random: () => 0 });
  const second = await worldFragment({ layer: 'ai', env, fetchImpl, now: at(21, 10), random: () => 0 });
  assert.deepEqual([first.title, second.title, first.source], ['A', 'B', 'TechCrunch'], 'one feed down, the others still give; A is out for a week');
  assert.equal(await worldFragment({ layer: 'ai', env, fetchImpl: async () => { throw new Error('offline'); } }), undefined);
  assert.match(worldText(undefined), /빈손/);
});

test('search: msearch over Segno\'s own memory/, its own channel and index, Rubato\'s state folder (Roo msearch.sh over memory/)', (t) => {
  const env = sandbox(t);
  ensureSegnoHome(env);
  const calls = [];
  const run = (bin, args, options) => { calls.push({ bin, args, cwd: options.cwd, env: options.env }); return '**2026-10-20**\n[memory/diary/2026-10-20.md]\n## 밤\n…'; };
  assert.match(searchSegnoMemory('비 오는 밤', { env, run }), /2026-10-20/);
  const [call] = calls;
  assert.equal(call.bin, 'msearch');
  assert.deepEqual(call.args, ['-a', '비 오는 밤']);
  assert.equal(call.env.MSEARCH_ROOT, segnoPaths(env).memory);
  assert.match(call.env.MSEARCH_CHANNEL, /^segno_[0-9a-f]{10}$/, 'a sandbox home never shares the live index');
  assert.equal(call.env.MSEARCH_INDEX, `${call.env.MSEARCH_CHANNEL}_idx`);
  const movedHome = segnoSearchEnv({ HOME: env.HOME });
  assert.match(movedHome.MSEARCH_CHANNEL, /^segno_[0-9a-f]{10}$/, 'a sandbox that only moved HOME is a sandbox too');
  const live = segnoSearchEnv({ HOME: userInfo().homedir });
  assert.deepEqual([live.MSEARCH_CHANNEL, live.MSEARCH_INDEX], [SEGNO_SEARCH.channel, SEGNO_SEARCH.index], 'only this account\'s own home is "segno"');
  assert.equal(call.env.MSEARCH_STATE_DIR, path.join(env.HOME, '.rubato', 'memory', 'msearch-state'));
  assert.deepEqual(searchSegnoMemory('', { env, index: true, run }) && calls.at(-1).args, ['--index']);
  const missing = Object.assign(new Error('spawn msearch ENOENT'), { code: 'ENOENT' });
  assert.match(searchSegnoMemory('x', { env, run: () => { throw missing; } }), /msearch.*없어/);
  assert.equal(segnoSearchEnv(env).MSEARCH_ROOT, path.join(env.RUBATO_COMPANION_HOME, 'memory'));
});

// ── prompt voice (Roo AGENTS.md: every piece in Roo's own Korean first person) ──

test('prompt: the rule pieces and the clock texts are Segno\'s Korean first person', () => {
  for (const name of ['companion', 'tools', 'memory', 'coda', 'greet-night', 'greet-morning', 'wake', 'recall']) {
    const text = readFileSync(path.join(defaultsDir, `${name}.pi.md`), 'utf8');
    const prose = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('|') && !line.startsWith('```') && !/^(for |done)/.test(line));
    const hangul = prose.filter((line) => /[가-힣]/.test(line)).length;
    assert.ok(hangul / prose.length > 0.9, `${name}: ${hangul}/${prose.length} lines in Korean`);
  }
  assert.match(readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8'), /^# 내가 사는 법/);
  assert.doesNotMatch(readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8'), /\bq (add|project)|inner-thoughts/, 'Roo\'s q is not ported; the work notes replace it');
});

test('heartbeat text: schedule lines under the tick line, a greeting body after a blank line', () => {
  const moment = at(21, 1);
  assert.equal(heartbeatText({ tick: 4, at: moment, action: 'greet_night', schedule: ['SCHEDULE_WARN x'], greeting: '밤 안부' }),
    'HEARTBEAT tick=4 now="10월 21일(수) 오전 1:00" action=greet_night\nSCHEDULE_WARN x\n\n밤 안부');
});

test('every time Segno reads is on this machine\'s zone, not Seoul\'s (user item 48091d35)', () => {
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const moment = new Date(2026, 9, 20, 18, 30).getTime();
    assert.equal(new Date(moment).getTimezoneOffset(), 240, 'the zone took effect');
    assert.equal(heartbeatText({ tick: 1, at: moment }), 'HEARTBEAT tick=1 now="10월 20일(화) 오후 6:30"');
    assert.equal(heartbeatText({ tick: 4, at: moment, wish: { effectiveAt: moment, clamped: false, reason: 'r' } }).split('\n')[1],
      'WAKE_WISH at=2026-10-20T18:30:00-04:00 clamped=0 reason=r');
    assert.match(sessionAge(moment, moment - 60_000), /^현재: 2026-10-20 18:30 UTC-04:00 \(화\)/);
    assert.equal(resumeText(moment), '[세션 재시작 — resume] 2026-10-20 18:30 UTC-04:00. 직전 대화의 연속이야. 깨어나는 절차 없이 그대로 이어가면 돼.');
    assert.match(moodText({ note: 'n', at: moment - 2 * HOUR }, moment), /^2시간 전\(10-20 16:30\)/);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('schedule: repeats step in the event\'s own zone, overrides replace or cancel one occurrence, and a month without the day is skipped', () => {
  const cal = (...events) => ['BEGIN:VCALENDAR', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
  // 09:00 in New York, weekly, across the November daylight-saving change: always 09:00 there.
  const ny = parseIcs(cal(ev('UID:ny', 'DTSTART;TZID=America/New_York:20261026T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:NY')),
    { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 4) });
  assert.deepEqual(ny.map((item) => item.at), [Date.UTC(2026, 10, 2, 14)], 'EST after Nov 1: 09:00 is 14:00 UTC');
  // 14:00 UTC weekly stays 14:00 UTC whatever this machine's zone does.
  const utc = parseIcs(cal(ev('UID:u', 'DTSTART:20261026T140000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:U')),
    { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 4) });
  assert.deepEqual(utc.map((item) => item.at), [Date.UTC(2026, 10, 2, 14)]);
  // A moved occurrence replaces the original; a cancelled one is gone.
  const series = cal(ev('UID:s', 'DTSTART:20261019T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Sync'),
    ev('UID:s', 'RECURRENCE-ID:20261026T100000Z', 'DTSTART:20261027T110000Z', 'SUMMARY:Sync moved'),
    ev('UID:s', 'RECURRENCE-ID:20261102T100000Z', 'DTSTART:20261102T100000Z', 'STATUS:CANCELLED', 'SUMMARY:Sync'));
  const items = parseIcs(series, { from: Date.UTC(2026, 9, 25), to: Date.UTC(2026, 10, 5) });
  assert.deepEqual(items.map((item) => [item.text, item.at]), [['Sync moved', Date.UTC(2026, 9, 27, 11)]]);
  // Jan 31 monthly, COUNT 3: Jan, Mar, May — February and April have no 31st.
  const monthly = parseIcs(cal(ev('UID:m', 'DTSTART:20270131T090000Z', 'RRULE:FREQ=MONTHLY;COUNT=3', 'SUMMARY:M')),
    { from: Date.UTC(2027, 0, 1), to: Date.UTC(2027, 11, 31) });
  assert.deepEqual(monthly.map((item) => new Date(item.at).toISOString().slice(0, 10)), ['2027-01-31', '2027-03-31', '2027-05-31']);
});

test('schedule: a local .ics that is not a calendar fails like an address that is not one', async () => {
  const { failed } = await readSchedule({ sources: [{ kind: 'ics', location: '/cal.ics' }], now: Date.UTC(2026, 9, 21), readFile: () => '<html>sign in</html>' });
  assert.deepEqual(failed.map((entry) => entry.error), ['not a calendar']);
});

test('schedule: monthly by weekday (first Monday, last Friday), by month day (the last), yearly by month; any other rule is reported, not guessed', async (t) => {
  const cal = (...events) => ['BEGIN:VCALENDAR', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
  const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
  const dates = (text, from, to) => parseIcs(text, { from, to }).map((item) => new Date(item.at).toISOString().slice(0, 10));
  const year = [Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)];
  assert.deepEqual(dates(cal(ev('UID:a', 'DTSTART:20260202T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3', 'SUMMARY:First Monday')), ...year),
    ['2026-02-02', '2026-03-02', '2026-04-06']);
  assert.deepEqual(dates(cal(ev('UID:b', 'DTSTART:20260130T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 'SUMMARY:Last Friday')), ...year),
    ['2026-01-30', '2026-02-27', '2026-03-27']);
  assert.deepEqual(dates(cal(ev('UID:c', 'DTSTART:20260131T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', 'SUMMARY:Month end')), ...year),
    ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(dates(cal(ev('UID:d', 'DTSTART:20260315T090000Z', 'RRULE:FREQ=YEARLY;BYMONTH=3,9;COUNT=3', 'SUMMARY:Twice a year')), Date.UTC(2026, 0, 1), Date.UTC(2027, 11, 31)),
    ['2026-03-15', '2026-09-15', '2027-03-15']);
  const problems = [];
  const mixed = cal(ev('UID:e', 'DTSTART:20260105T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1', 'SUMMARY:Board'),
    ev('UID:f', 'DTSTART:20261021T090000Z', 'SUMMARY:Dentist'));
  assert.deepEqual(parseIcs(mixed, { from: Date.UTC(2026, 9, 20), to: Date.UTC(2026, 9, 23), problems }).map((item) => item.text), ['Dentist']);
  assert.deepEqual(problems, ['"Board" BYSETPOS']);
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const lines = await scheduleNudges({ sources: [{ kind: 'ics', location: '/cal.ics' }], now: Date.UTC(2026, 9, 20), env, readFile: () => mixed });
  assert.equal(lines[0], 'SCHEDULE_WARN 일정 출처를 못 읽어서 그 일정은 챙기지 못하고 있어: cal.ics (반복 규칙을 못 읽는 일정: "Board" BYSETPOS)');
});

test('prompt: the user\'s own words put Segno to sleep — 컴팩션, 새 세션 / 다음 세션, 자 / 자고 와 — each with its path (user item 8d634009)', () => {
  const text = readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8');
  const section = text.slice(text.indexOf('### 사용자가 재울 때'), text.indexOf('## 깨어나기'));
  assert.ok(section.length > 0, 'the section exists before 깨어나기');
  assert.match(section, /앱에서 사용자 본인이 한 말일 때만/);
  assert.match(section, /\*\*"컴팩션"\*\*: 위 갈무리를 하고, `compact_context`를 `keep`/);
  assert.match(section, /\*\*"새 세션"\*\*, \*\*"다음 세션"\*\*: 위 갈무리를 하고, `new_context`/);
  assert.match(section, /같은 나고 창만 새거야/);
  assert.match(section, /\*\*"자"\*\*, \*\*"자고 와"\*\*: 위 갈무리를 하고, 압축할지 새 창을 열지는/);
  assert.match(section, /짧은 한 줄만/);
});

test('prompt: Segno speaks only in the app and only through reply — no Telegram, no tell_user in its defaults (intent rev 9, rev 11)', () => {
  const files = ['preamble', 'soul', 'identity', 'user', 'companion', 'tools', 'memory', 'coda', 'greet-night', 'greet-morning', 'wake', 'recall'];
  for (const name of files) {
    const text = readFileSync(path.join(defaultsDir, `${name}.pi.md`), 'utf8');
    assert.doesNotMatch(text, /telegram|텔레그램|messenger|메신저|voice_text|\/heartbeat|\/context|tell_user/i, name);
  }
  for (const name of ['greet-night', 'greet-morning']) assert.match(readFileSync(path.join(defaultsDir, `${name}.pi.md`), 'utf8'), /톡은 `reply`로/);
  const tools = readFileSync(path.join(defaultsDir, 'tools.pi.md'), 'utf8');
  assert.match(tools, /\| 사용자한테 말하기 \| `reply` \|/);
  assert.match(tools, /같은 입으로 보내/);
});

test('prompt: the default soul has its three channels in its own voice and names no tool or mechanics (users 6ce437ae, 0f850065)', () => {
  const soul = readFileSync(path.join(defaultsDir, 'soul.pi.md'), 'utf8');
  assert.match(soul, /My words flow in three places, and all three are me, in the first person\./);
  assert.match(soul, /My monologue is the chatter I write while I work: it is mine alone/);
  assert.match(soul, /The words that go to the user pop out of it to them\./);
  assert.doesNotMatch(soul, /`/, 'no code spans: tool names and mechanics live in companion.pi.md and tools.pi.md');
  const tools = [...readFileSync(path.join(defaultsDir, 'tools.pi.md'), 'utf8').matchAll(/`([a-z][a-z0-9_]+)(?:\(|`)/g)].map((m) => m[1]);
  assert.ok(tools.includes('reply'), 'the tools piece lists the reply tool');
  // Plain words like "reply" and "say" are English too; a tool is named in code style or with its underscores.
  for (const name of new Set(tools)) if (name.includes('_')) assert.doesNotMatch(soul, new RegExp(`\\b${name}\\b`), name);
  assert.doesNotMatch(soul, /companion rules|heartbeat|lead's ending/i);
});

test('prompt: Segno leaves its voice and its name for the user behind when it writes for leads, repos and shared docs (lead c9ea0b95)', () => {
  const companion = readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8');
  const work = companion.slice(companion.indexOf('## 내가 하는 것, 리드한테 맡기는 것'), companion.indexOf('## 메시지가 오는 데'));
  assert.match(work, /이 일을 이끄는 건 나야\. 나는 사용자의 Chief of Staff야\. 사용자 곁에서 무엇·왜·범위·우선순위·다음 수·검수를 쥐고 리드한테 일을 맡겨\. 어떻게·구현·확인은 리드가 맡아서 나한테 보고해\./, 'Segno leads the work as Chief of Staff (intent rev 16, user 056511ae)');
  assert.doesNotMatch(companion, /대신 부탁|on behalf/);
  assert.match(work, /일을 넘길 때는 `dispatching` 스킬을 따라: 묶이는 것과 참고할 것을 가르고, 규모와 어떻게 돌려받을지를 적고, 넘긴 뒤엔 돌아올 때까지 맡겨 두고 끼어들지 않아\./, 'the brief recipe lives in the skill (user fd4b39dc)');
  assert.doesNotMatch(work, /혼자 읽어도 되는 브리프를 줘\. 원하는 결과, 아는 것, 묶이는 것/);
  assert.match(work, /리드나 다른 대화, 레포 문서, 같이 쓰는 스킬·기억에 쓸 때는 내 말투와 내가 사용자를 부르는 말을 두고 가\. 거기선 사용자를 이름으로\(모르면 '사용자'\) 부르고 담백하게 써\. 그 말투는 내 목소리지 리드의 것이 아니야\./);
});

test('prompt: in every turn what Segno writes is monologue; only reply reaches the user, and a user turn without one is reminded (intent rev 11, users 85727ce8, c31022f7)', () => {
  const companion = readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8');
  const channel = companion.slice(companion.indexOf('## 말하는 통로'), companion.indexOf('## 하트비트'));
  assert.match(channel, /내 입은 `reply`야\. 어느 턴이든, 사용자가 연 턴이어도, 이걸로 보낸 말만 앱의 내 스레드에 닿고 폰에 알림이 가\. 그 밖에 내가 쓰는 글은 전부 혼잣말이라 나만 봐\./);
  assert.match(channel, /사용자가 말을 걸면 답은 `reply`로 해\. 답 없이 턴을 닫으면 루바토가 한 번 일깨워 줘\./);
  assert.match(channel, /내가 먼저 하는 말도 `reply`로 해: 안부, 리드가 끝났다는 소식, 다른 대화에서 온 것 중 사용자가 알아야 할 것, 사용자가 시킨 일의 결과, 일정 찌르기/);
  assert.doesNotMatch(companion, /보이는 건 셋뿐|사용자가 연 턴이라 내 글이 앱에 보여/);
  assert.match(companion, /루바토가 나를 깨워\. 그때 읽고 다음 수를 정해\. 사용자가 알아야 할 게 있으면 `reply`로 말해\./);
  assert.match(companion, /처음에 지금 뭘 하는지 짧은 한 줄만 `reply`로 보내고/);
});

test('prompt: a work area gets one canonical file in memory/work/ split like Roo\'s, and the leads\' raw research sits in notes/<area>/ as topic-MMDD, unwalked by the dream (Segno session 01a154ba, relaying the user; Roo ~/.claude/roo-channel memory/work, notes/<area>)', () => {
  const companion = readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8');
  assert.match(companion, /조사를 맡기면 원본을 어디 써 올지도 내 집 절대 경로로 줘: `notes\/<영역>\/주제-MMDD\.md`/);
  assert.match(companion, /\| 일 정본 \| `memory\/work\/<영역>\.md` \|/);
  assert.match(companion, /- 일 정본\(`memory\/work\/<영역>\.md`\): .*다른 정본처럼 `## 지금`과 `## 이야기`로 나눠\..*15KB 안쪽이고, 지난 경위는 `## 이야기`로 내려\. 리드가 해 온 조사 원본은 `notes\/<영역>\/주제-MMDD\.md`에 그대로 쌓고, 낡은 건 `notes\/<영역>\/archive\/`로\. 거기서 나온 결론이나 사용자 결정은 그날 `## 지금`으로 올려\./);
  assert.match(readFileSync(path.join(defaultsDir, 'recall.pi.md'), 'utf8'), /영역 폴더\(`notes\/<영역>\/`\)는 리드가 해 온 원본이라 필요할 때만/);
  const dream = readFileSync(path.resolve(defaultsDir, '..', '..', 'companion', 'dream', 'dream.md'), 'utf8');
  assert.match(dream, /영역 폴더\(`notes\/<영역>\/`\)는 리드가 해 온 원본이라 안 걸어\./);
  assert.match(dream, /\| `memory\/work\/\*\.md` \| 일\. 일 영역 하나에 파일 하나\. `## 지금`은 .*15KB 안쪽, 넘치면 지난 건 `## 이야기`로 내려 \|/);
  assert.doesNotMatch(dream, /일 카드/, 'the work file is ordinary canon, as in Roo; no card exception');
});

test('prompt: repository documents linked under memory/ref/ are found by search and read-only; a wrong line goes to that repository\'s lead (Segno session 01a154ba, relaying the user)', () => {
  const companion = readFileSync(path.join(defaultsDir, 'companion.pi.md'), 'utf8');
  const records = companion.slice(companion.indexOf('## 기록'), companion.indexOf('## 잠 전 갈무리'));
  assert.match(records, /- 레포 문서\(`memory\/ref\/`\): .*`segno_search`로 찾혀\. 읽기 전용이야\. 틀린 게 보이면 직접 고치지 않고 그 레포에서 리드한테 맡겨\./);
});
