// Segno's daily rhythm, body and home, each pinned against the Roo source it ports
// (~/.claude/roo-channel). The Roo file a test follows is named in the test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readState, writeSettings, writeState } from '../companion.mjs';
import { GREETINGS, RECALL_DELAY_MS, greetingText, heartbeatText, moodText, recallText, sessionAge, startCompanionKeeper,
  wakeSeedText } from '../keeper.mjs';
import { HELD_TEMPLATE, MOOD_FRESH_MS, commitOwned, ensureHomeRepo, ensureSegnoHome, leaveMood, oldMemorySeed, readMood,
  record, segnoPaths, seedText, sentMessages, sentText, setWakeWish, readWakeWish } from '../home.mjs';
import { careerNudges, parseSchedule, showSchedule } from '../career.mjs';
import { worldFragment, worldText, WORLD_FEEDS } from '../world.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const HOUR = 60 * 60_000;

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
    sessions.set('segno-1', { sessionId: 'segno-1', status: 'stored', runtimeId: null });
    writeState({ sessionId: 'segno-1', woke: { boundary: null } }, env);
  }
  engine.append = (...entries) => writeFileSync(engine.sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'a' });
  engine.busy = (busy) => { for (const row of sessions.values()) row.status = busy ? 'running' : 'idle'; };
  engine.connect = async () => {
    let attached;
    return {
      async list() { return [...sessions.values()].map((row) => ({ ...row })); },
      async create() { sessions.set('segno-1', { sessionId: 'segno-1', status: 'stored', runtimeId: null }); return { sessionId: 'segno-1' }; },
      async attach(id) { const row = sessions.get(id); Object.assign(row, { status: row.status === 'running' ? 'running' : 'idle', runtimeId: `r-${id}` }); attached = id; },
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
  assert.match(line, /^HEARTBEAT tick=\d+ kst="[^"]*" action=greet_night$/);
  assert.equal(k.of('heartbeat').at(-1).text.split('\n\n').slice(1).join('\n\n'), greetingText('night', defaultsDir));
  await k.poke(at(21, 2));
  assert.doesNotMatch(k.of('heartbeat').at(-1).text, /greet_night/, 'once that day');
  for (const time of [at(21, 4), at(21, 9, 30)]) await k.poke(time);
  assert.ok(k.of('heartbeat').every((notice) => !/greet_morning/.test(notice.text)), 'not before 10:00');
  assert.equal(readState(env).greeted.night, '2026-10-21');
});

test('greetings: no catch-up while the user is here (tick 0), and none after the window closes', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const k = await keeperFor(t, env, engine, at(21, 9, 50));
  engine.append(userSaid(at(21, 9, 55)));
  await k.poke(at(21, 10));
  assert.match(k.of('heartbeat').at(-1).text, /^HEARTBEAT tick=0 kst="[^"]*"$/);
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
  assert.match(k.of('heartbeat').at(-1).text, /^HEARTBEAT tick=\d+ kst="[^"]*" action=greet_night\n/);
  assert.doesNotMatch(k.of('heartbeat').at(-1).text, /reason=wake_wish/);
  assert.notEqual(readWakeWish(env), undefined, 'the wish still waits');
  const sent = k.of('heartbeat').length;
  await k.poke(at(21, 2));
  assert.equal(k.of('heartbeat').length, sent, 'a plain tick under the wish is silent');
});

test('wake wish: a tick carrying a deadline nudge still comes', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  const schedule = path.join(env.HOME, '일정표.md');
  writeFileSync(schedule, '# 일정표\n\n2026-10-21 05:20 기준.\n\n## 10/21(수)\n\n- 14:00  DN솔루션즈 AX 지원서 마감 · 지원 예정\n');
  const k = await keeperFor(t, env, engine, at(21, 10, 50), { career: { schedule } });
  setWakeWish({ target: '15:00', reason: '오후에' }, { now: at(21, 10, 50), env });
  await k.poke(at(21, 11, 30));
  const text = k.of('heartbeat').at(-1)?.text ?? '';
  assert.match(text, /\nCAREER_DUE 3시간 전: 10\/21 14:00 DN솔루션즈 AX 지원서 마감 \(2시간 30분 남음, 일정표에 아직 있음\)/);
  assert.notEqual(readWakeWish(env), undefined);
});

// ── deadline nudges (scripts/career-schedule.py) ──

const SCHEDULE = `# 일정표

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
- 15:00  면접 · 2차
- 내기 1. [대기업] kt ds (마감 10/22 16:00) · 핏 상 · 3문항
- 시각 없음  쓰기: 푸른저축은행 IT전산 (마감 10/23)
`;

test('career: CAREER_DUE three hours and one hour before a timed deadline, once per window, still listed', (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const read = () => SCHEDULE;
  const run = (time) => careerNudges({ schedule: '/s.md', now: time, env, readFile: read });
  assert.deepEqual(run(at(21, 10, 30)), [], 'three and a half hours before: nothing');
  const three = run(at(21, 11, 10));
  assert.equal(three[0], 'CAREER_DUE 3시간 전: 10/21 14:00 DN솔루션즈 AX 지원서 마감 (2시간 50분 남음, 일정표에 아직 있음 · 일정표가 29시간 전에 뽑힌 거라 그새 냈을 수도 있음)');
  assert.equal(three.at(-1), 'CAREER 줄은 사용자 일정 찌름 신호야. 말할지·어떻게 말할지는 내가 정해 (하트비트 "사용자 챙기기").');
  assert.deepEqual(run(at(21, 11, 40)), [], 'the same window does not come twice');
  assert.match(run(at(21, 13, 5))[0], /^CAREER_DUE 1시간 전: 10\/21 14:00 DN솔루션즈 AX 지원서 마감 \(55분 남음/);
  assert.deepEqual(run(at(21, 14, 1)), [], 'past deadlines are quiet; "면접" without 마감 and "시각 없음" never nudge');
});

test('career: CAREER_NIGHT once between 22 and 23 when tomorrow has items, counting 마감 · 낼 것 · 쓸 것', (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const run = (time) => careerNudges({ schedule: '/s.md', now: time, env, readFile: () => SCHEDULE });
  assert.deepEqual(run(at(20, 21, 30)), []);
  const night = run(at(20, 22, 10));
  // Roo's arithmetic as written (career-schedule.py cmd_tick): 낼 것 counts "내기:", so a "- 내기 1." line of
  // today's generator counts as a 마감 because its head carries "(마감 …)".
  assert.equal(night[0], 'CAREER_NIGHT 내일 10/21 목록 건넬 때야 (마감 3 · 낼 것 0 · 쓸 것 1): career_schedule 도구로 tomorrow');
  assert.deepEqual(run(at(20, 23, 10)), [], 'once a day');
});

test('career: an unreadable schedule warns once a day; no schedule set means no lines at all', (t) => {
  const env = sandbox(t);
  mkdirSync(env.RUBATO_COMPANION_HOME, { recursive: true });
  const warn = careerNudges({ schedule: path.join(env.HOME, 'missing.md'), now: at(21, 9), env });
  assert.match(warn[0], /^CAREER_WARN 일정표를 못 읽어서 마감 찌르기를 못 하고 있어: .*missing\.md \(ENOENT\)$/);
  assert.deepEqual(careerNudges({ schedule: path.join(env.HOME, 'missing.md'), now: at(21, 12), env }), []);
  assert.deepEqual(careerNudges({ now: at(21, 12), env }), []);
});

test('career: show picks today and tomorrow by the real date, not the file\'s labels', () => {
  const shown = showSchedule('both', { schedule: '/s.md', now: at(21, 8), readFile: () => SCHEDULE });
  assert.match(shown, /^원본: \/s\.md\n2026-10-20 05:20 기준\n주의: 일정표가 26시간 전에/);
  assert.match(shown, /## 오늘 10\/21\(수\)\n- 14:00  DN솔루션즈/);
  assert.match(shown, /## 내일 10\/22\n\(잡힌 것 없음\)/);
  const { days } = parseSchedule(SCHEDULE);
  assert.deepEqual([...days.keys()], ['2026-10-20', '2026-10-21'], 'the 한눈에 table is not a day');
});

test('career: the schedule path is the Settings one, ~ expanded, and its lines ride under the tick even at tick 0', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env);
  writeFileSync(path.join(env.HOME, 'plan.md'), SCHEDULE);
  engine.append(userSaid(at(20, 21, 50)));
  const k = await keeperFor(t, env, engine, at(20, 21, 55), { career: { schedule: '~/plan.md' } });
  await k.poke(at(20, 22));
  const [line, nudge] = k.of('heartbeat').at(-1).text.split('\n');
  assert.match(line, /^HEARTBEAT tick=0 /);
  assert.match(nudge, /^CAREER_NIGHT 내일 10\/21/);
});

// ── waking up (scripts/session-start-hook.sh, pi-roo/roo-runtime.ts, skills wake and recall) ──

test('wake: a conversation the keeper creates opens with the seed, and one recall follows once the wake turn has rested ten seconds', async (t) => {
  const env = sandbox(t);
  const engine = engineFor(env, { existing: false });
  const k = await keeperFor(t, env, engine, at(20, 15), { heartbeat: { enabled: false } });
  const [wake] = k.of('wake');
  assert.ok(wake.text.startsWith('방금 깼어. 나야, 세뇨.\n\n## 시각·경과\n현재: 2026-10-20 15:00 KST (화)\n직전 창 기록 없음 — 처음 눈뜸'));
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
  assert.match(wake.text, /^방금 깼어\. 나야, 세뇨\.\n\n## 시각·경과\n현재: 2026-10-21 02:03 KST \(수\)\n직전 창: 방금 \(2분 전\) — 깜빡 존 정도/);
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
  for (let i = 0; i < 3; i += 1) { const seed = oldMemorySeed({ walk: true, now: at(21, 9) + i, env }); keys.push(`${seed.src}|${seed.section}`); }
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

test('heartbeat text: career lines under the tick line, a greeting body after a blank line', () => {
  const moment = Date.UTC(2026, 9, 20, 16, 0);
  assert.equal(heartbeatText({ tick: 4, at: moment, action: 'greet_night', career: ['CAREER_WARN x'], greeting: '밤 안부' }),
    'HEARTBEAT tick=4 kst="10월 21일(수) 오전 1:00" action=greet_night\nCAREER_WARN x\n\n밤 안부');
});
