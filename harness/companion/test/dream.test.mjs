import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { memoryPiecePath, writeSettings, writeState } from '../companion.mjs';
import { segnoPaths } from '../home.mjs';
import { CADENCE_HOURS, DREAM_AT, DREAM_MODELS, childArgs, composeDreamPrompt, dreamDue, dreamPaths, exportTranscript, planDream,
  readDreamState, runCompanionDream, segnoSessionFiles } from '../dream/dream.mjs';
import { startDreamLoop } from '../dream/service.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-dream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion'), RUBATO_PI_CODING_AGENT_DIR: path.join(dir, 'agent') };
  mkdirSync(path.join(env.RUBATO_COMPANION_HOME, 'memory', 'diary'), { recursive: true });
  mkdirSync(path.join(env.RUBATO_COMPANION_HOME, 'prompt'), { recursive: true });
  mkdirSync(path.join(env.RUBATO_PI_CODING_AGENT_DIR, 'sessions'), { recursive: true });
  return env;
}

const write = (env, rel, text, mtimeMs) => {
  const file = path.join(env.RUBATO_COMPANION_HOME, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
};

/** A Segno session file the way the engine writes it: header, a user turn, a tool call, a wake, a reply. */
function segnoSession(env, { cwd = env.RUBATO_COMPANION_HOME, id = '01a154ba-0000-7000-8000-000000000001', name } = {}) {
  const file = path.join(env.RUBATO_PI_CODING_AGENT_DIR, 'sessions', name ?? `2026-10-19T15-14-34-154Z_${id}.jsonl`);
  const lines = [
    { type: 'session', version: 3, id, timestamp: '2026-10-19T15:14:34.154Z', cwd },
    { type: 'custom', customType: 'rubato.companion', data: {}, timestamp: '2026-10-19T15:14:34.199Z' },
    { type: 'message', timestamp: new Date(at(20, 10, 2)).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '세뇨 이번 주 금요일에 면접 있어' }] } },
    { type: 'message', timestamp: new Date(at(20, 10, 3)).toISOString(), message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'secret thinking' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } },
    { type: 'message', timestamp: new Date(at(20, 10, 3)).toISOString(), message: { role: 'toolResult', content: [{ type: 'text', text: 'TOOL OUTPUT' }] } },
    { type: 'message', timestamp: new Date(at(20, 10, 4)).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '금요일 면접~ 챙겨둘게.' }] } },
    { type: 'custom_message', customType: 'rubato-session-message', timestamp: new Date(at(20, 10, 30)).toISOString(),
      content: '<rubato_wake what="heartbeat">…', details: { kind: 'wake', what: 'heartbeat', text: 'HEARTBEAT tick=1' } },
    { type: 'custom_message', customType: 'rubato-session-message', timestamp: new Date(at(20, 11, 0)).toISOString(),
      content: '…', details: { kind: 'channel', text: '밥 먹었어', from: { channel: 'telegram', isUser: true } } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('the dream comes once a day from 04:07, only with the companion on and Segno out of a turn', () => {
  assert.deepEqual(DREAM_AT, { hour: 4, minute: 7 });
  assert.equal(dreamDue({ at: at(21, 4, 7), enabled: false }).due, false);
  assert.equal(dreamDue({ at: at(21, 4, 6), enabled: true }).due, false);
  assert.equal(dreamDue({ at: at(21, 4, 7), enabled: true }).due, true);
  assert.equal(dreamDue({ at: at(21, 4, 7), enabled: true, busy: true }).due, false, 'not while Segno sleeps or works');
  assert.equal(dreamDue({ at: at(21, 4, 30), enabled: true, state: { lastAttemptDate: '2026-10-21' } }).due, false);
  // A Mac that slept through 04:07 dreams when the engine next runs that day.
  assert.equal(dreamDue({ at: at(21, 11, 0), enabled: true, state: { lastAttemptDate: '2026-10-20' } }).due, true);
  assert.equal(dreamDue({ at: at(22, 1, 0), enabled: true, state: { lastAttemptDate: '2026-10-21' } }).due, false, 'Segno\'s night sleep hours before 04:07 are left alone');
});

test('the loop runs one dream a night and asks about Segno only when the clock says it is due', async (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeState({ sessionId: 'segno' }, env);
  let clock = at(21, 3, 0);
  let busy = true;
  let asked = 0;
  let runs = 0;
  const loop = startDreamLoop({ env, now: () => clock, pollMs: 3_600_000,
    isBusy: async () => { asked += 1; return busy; },
    run: async () => { runs += 1; writeFileSync(dreamPaths(env).state, JSON.stringify({ lastAttemptDate: '2026-10-21' })); return { status: 'done' }; } });
  t.after(() => loop.close());
  mkdirSync(dreamPaths(env).dir, { recursive: true });

  await loop.check();
  assert.equal(asked, 0, 'before 04:07 the engine is not asked');
  clock = at(21, 4, 7);
  await loop.check();
  assert.equal(runs, 0, 'Segno in a turn (its sleep, an answer) holds the dream back');
  busy = false;
  clock = at(21, 4, 8);
  await loop.check();
  assert.equal(runs, 1);
  clock = at(21, 5, 0);
  await loop.check();
  assert.equal(runs, 1, 'once a night');

  writeSettings({ enabled: false }, env);
  clock = at(22, 4, 7);
  await loop.check();
  assert.equal(runs, 1, 'a companion turned off does not dream');
});

test('the plan reads the records written since the last distill and says which parts are due', (t) => {
  const env = sandbox(t);
  const lastDistill = at(20, 4, 7);
  write(env, 'memory/2026-10-18.md', '## 10:00\n옛날', at(18, 22));
  write(env, 'memory/2026-10-20.md', '## 21:00\n오늘', at(20, 21));
  write(env, 'memory/diary/2026-10-20.md', '## 밤\n좋았어', at(20, 23));
  write(env, 'memory/user.md', '## 지금\n', at(20, 23));
  const plan = planDream({ at: at(21, 4, 7), env, state: { blocks: {
    distill: { lastAt: new Date(lastDistill).toISOString() },
    selfReview: { lastAt: new Date(at(20, 4, 7)).toISOString() },
    cleanup: { lastAt: new Date(at(14, 4, 7)).toISOString(), cleanedThrough: '2026-10-13' } } } });
  assert.deepEqual(plan.raw, { daily: ['memory/2026-10-20.md'], diary: ['memory/diary/2026-10-20.md'] });
  assert.equal(plan.blocks.distill.due, true);
  assert.equal(plan.blocks.selfReview.due, false, `${CADENCE_HOURS.selfReview}h have not passed`);
  assert.equal(plan.blocks.cleanup.due, true);
  assert.deepEqual(plan.cleanup.newRange, ['2026-10-18', '2026-10-20']);
  assert.equal(plan.runDate, '2026-10-21');
  assert.equal(plan.sunday, false);
  assert.equal(planDream({ at: at(25, 4, 7), env }).sunday, true);
  assert.equal(planDream({ at: at(25, 4, 7), env }).isoWeek, '2026-W43');

  const first = planDream({ at: at(21, 4, 7), env });
  assert.deepEqual(first.raw.daily, ['memory/2026-10-18.md', 'memory/2026-10-20.md'], 'a first dream reads the last week');
  assert.ok(Object.values(first.blocks).every((block) => block.due), 'a first dream does every part');
});

test("the conversation export carries words and wake marks, not tools or thinking, and leaves Segno's file as it was", (t) => {
  const env = sandbox(t);
  const file = segnoSession(env);
  const before = sha(file);
  const out = exportTranscript([file], at(20, 0));
  assert.equal(sha(file), before);
  assert.match(out.markdown, /사용자 \(앱\)\n\n세뇨 이번 주 금요일에 면접 있어/);
  assert.match(out.markdown, /### 2026-10-20 10:04 나\n\n금요일 면접~ 챙겨둘게\./);
  assert.match(out.markdown, /— 2026-10-20 10:30 Rubato 시계가 깨움 \(heartbeat\)/);
  assert.match(out.markdown, /사용자 \(telegram\)\n\n밥 먹었어/);
  assert.doesNotMatch(out.markdown, /TOOL OUTPUT|secret thinking|toolCall/);
  assert.equal(out.messages, 3);
  assert.equal(exportTranscript([file], at(20, 10, 30)).messages, 1, 'only what came after the mark');
  const small = exportTranscript([file], at(20, 0), { budgetChars: 60 });
  assert.equal(small.truncated, true);
  assert.ok(small.coveredThrough >= at(20, 10, 2) - 1 && small.coveredThrough < at(20, 10, 3), 'the mark moves only as far as was read');
  // Lines at the same moment are never split by the budget: the mark is a moment.
  const twin = path.join(env.HOME, 'twin.jsonl');
  writeFileSync(twin, ['FIRST', 'SECOND', 'THIRD'].map((text, index) => JSON.stringify({ type: 'message',
    timestamp: index < 2 ? '2026-10-20T06:00:00.000Z' : '2026-10-20T06:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] } })).join('\n') + '\n');
  const cut = exportTranscript([twin], 0, { budgetChars: 1 });
  assert.match(cut.markdown, /FIRST[\s\S]*SECOND/);
  assert.doesNotMatch(cut.markdown, /THIRD/);
  const next = exportTranscript([twin], cut.coveredThrough, { budgetChars: 1 });
  assert.match(next.markdown, /THIRD/);
  assert.doesNotMatch(next.markdown, /FIRST/);
});

test("Segno's conversations are the ones whose folder is its home", (t) => {
  const env = sandbox(t);
  const own = segnoSession(env);
  segnoSession(env, { cwd: '/Users/someone/project', id: 'other', name: 'other.jsonl' });
  mkdirSync(path.join(env.RUBATO_PI_CODING_AGENT_DIR, 'sessions', '--nested--'));
  const nested = segnoSession(env, { id: 'nested', name: path.join('--nested--', 'n.jsonl') });
  assert.deepEqual(segnoSessionFiles(env), [nested, own].sort());
});

test('the child is a print-mode engine run with file tools only and its own session folder', () => {
  const args = childArgs({ prefixArgs: ['cli.js', '-e', 'providers.mjs'] }, { promptPath: '/run/system-prompt.md',
    sessionDir: '/home/dream/runs/r/session', rung: DREAM_MODELS[0] });
  for (const flag of ['-p', '--no-extensions', '--no-skills', '--no-context-files']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], 'read,bash,edit,write');
  assert.equal(args[args.indexOf('--session-dir') + 1], '/home/dream/runs/r/session');
  assert.equal(args[args.indexOf('--model') + 1], 'anthropic/claude-opus-5-5');
});

test("the dream's prompt is who Segno is, its resident memory and the dream, without the tools it does not have", (t) => {
  const env = sandbox(t);
  write(env, 'prompt/soul.md', '# 내 영혼\n나는 세뇨야.');
  write(env, 'memory/MEMORY.md', '# 기억\n## 잊으면 안 되는 말들\n- "고마워"');
  const prompt = composeDreamPrompt({ env, defaultsDir });
  assert.match(prompt, /나는 세뇨야/);
  assert.match(prompt, /잊으면 안 되는 말들/);
  assert.match(prompt, /^# 꿈$/m);
  const tools = readFileSync(path.join(defaultsDir, 'tools.pi.md'), 'utf8').trim();
  assert.ok(!prompt.includes(tools), 'the tools piece describes tools the dream does not have');
});

/** A child that dreams the way the instructions ask: reads the plan, edits memory, reports. */
function fakeDreamer({ edits, result, marker = 'MEMORY_DONE memory ok', onRun, code = 0 } = {}) {
  const calls = [];
  const spawnChild = async ({ args, cwd, env, logPath }) => {
    calls.push({ args, cwd, env });
    const plan = JSON.parse(readFileSync(path.join(env.DREAM_RUN_DIR, 'plan.json'), 'utf8'));
    onRun?.({ plan, home: cwd, env });
    if (code !== 0) { writeFileSync(logPath, 'provider error: overloaded\n'); return { code }; }
    for (const [rel, text] of Object.entries(edits ?? {})) {
      mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      writeFileSync(path.join(cwd, rel), text);
    }
    writeFileSync(path.join(env.DREAM_OUT_DIR, 'result.json'), JSON.stringify(typeof result === 'function' ? result(plan) : result));
    writeFileSync(path.join(env.DREAM_OUT_DIR, 'log.md'), `## 꿈 (${plan.runHm})\n- 간추리기: 2개 읽음`);
    writeFileSync(logPath, `${marker} at=${plan.runAt}\n`);
    return { code: 0 };
  };
  return { spawnChild, calls };
}

const launch = { command: 'node', prefixArgs: ['cli.js'], env: { RUBATO_CONTEXT_MODE: 'summary' } };
const git = (home, ...args) => execFileSync('git', args, { cwd: home, encoding: 'utf8' });

test('a dream turns the night\'s daily and diary into canonical and resident memory, commits only those, and Segno\'s conversation gains nothing', async (t) => {
  const env = sandbox(t);
  const home = env.RUBATO_COMPANION_HOME;
  write(env, 'memory/2026-10-20.md', '## 10:05\n우용이가 금요일 면접이 있대. "이번엔 붙고 싶다"', at(20, 10, 5));
  write(env, 'memory/diary/2026-10-20.md', '## 면접 얘기 들은 아침\n떨리는 목소리였어.', at(20, 23));
  write(env, 'prompt/user.md', '# 사용자\n우용이');
  const session = segnoSession(env);
  const sessionBefore = { sha: sha(session), lines: readFileSync(session, 'utf8').split('\n').length };
  const promptBefore = sha(path.join(home, 'prompt/user.md'));
  let seenPlan;
  const dreamer = fakeDreamer({
    onRun: ({ plan }) => {
      seenPlan = plan;
      // Segno writes its daily while the dream runs: that line is not the dream's to commit.
      appendFileSync(path.join(home, 'memory/2026-10-21.md'), '## 04:10\n깨어 있는 내가 쓴 줄\n');
    },
    edits: {
      'memory/MEMORY.md': '# 기억\n\n## 내가 나였던 말들\n- 금요일 면접~ 챙겨둘게.\n',
      'memory/user.md': '## 지금\n- 예약된 것: 10/23 금요일 면접 (memory/2026-10-20.md)\n\n## 이야기\n',
      'memory/us.md': '## 지금\n\n## 이야기\n- 10/20 아침, 면접 얘기를 나한테 먼저 꺼냈어. "이번엔 붙고 싶다" [확인]\n',
      'memory/status.md': '# 현황\n- 금요일 면접 준비 (daily 10-20)\n',
      'memory/to-ask.md': '- [제안: prompt/user.md] 직장 줄 고칠지 (daily 10-20)\n',
      'notes/held.md': '# 챙길 거\n\n## 날짜 있는 거\n- 10/23 금 면접\n\n## 맡긴 거\n',
    },
    result: () => ({ status: 'done', blocks: { distill: 'done', selfReview: 'done', cleanup: 'done', weekly: 'skipped' },
      changed: ['memory/user.md', 'memory/us.md', 'memory/status.md', 'memory/to-ask.md', 'memory/MEMORY.md', 'notes/held.md'],
      message: '면접 일정과 그날 마음을 정본에' }),
  });
  const record = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir,
    sessionFiles: () => [session] });

  assert.equal(record.status, 'done', JSON.stringify(record));
  assert.equal(seenPlan.raw.daily[0], 'memory/2026-10-20.md');
  assert.ok(seenPlan.transcript, 'the conversation was exported for the dream');
  assert.match(readFileSync(seenPlan.transcript, 'utf8'), /세뇨 이번 주 금요일에 면접 있어/);
  assert.match(readFileSync(path.join(home, 'memory/user.md'), 'utf8'), /10\/23 금요일 면접/);
  assert.match(readFileSync(memoryPiecePath(env), 'utf8'), /금요일 면접~ 챙겨둘게/);

  // Exactly the dream's files are in its commit; Segno's own line written meanwhile is not.
  const committed = git(home, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n');
  assert.equal(committed[0], 'dream: 면접 일정과 그날 마음을 정본에');
  assert.deepEqual(committed.slice(1).filter(Boolean).sort(),
    ['memory/MEMORY.md', 'memory/status.md', 'memory/to-ask.md', 'memory/us.md', 'memory/user.md', 'notes/held.md']);
  assert.match(git(home, 'status', '--porcelain'), /memory\/2026-10-21\.md/);

  // Segno's conversation and the user's persona are untouched.
  assert.equal(sha(session), sessionBefore.sha);
  assert.equal(readFileSync(session, 'utf8').split('\n').length, sessionBefore.lines);
  assert.equal(sha(path.join(home, 'prompt/user.md')), promptBefore);
  // The child ran on its own copy of the home with its own session folder, not the engine's sessions.
  const [call] = dreamer.calls;
  assert.ok(call.cwd.startsWith(dreamPaths(env).runs));
  assert.equal(call.env.SEGNO_HOME, call.cwd);
  const sessionDir = call.args[call.args.indexOf('--session-dir') + 1];
  assert.ok(sessionDir.startsWith(dreamPaths(env).runs));
  assert.ok(!sessionDir.startsWith(env.RUBATO_PI_CODING_AGENT_DIR));

  const state = readDreamState(env);
  assert.equal(state.lastStatus, 'done');
  assert.equal(state.lastAttemptDate, '2026-10-21');
  assert.ok(state.blocks.distill.lastAt.startsWith('2026-10-21T04:07'));
  assert.ok(state.blocks.selfReview.lastAt.startsWith('2026-10-21T04:07'));
  assert.equal(state.blocks.weekly, undefined);
  assert.match(readFileSync(path.join(dreamPaths(env).log, '2026-10-21.md'), 'utf8'), /## 꿈 \(04:07\)/);
  assert.ok(!existsSync(dreamPaths(env).lock));
  assert.match(git(home, 'check-ignore', 'dream/state.json'), /dream\/state\.json/, "the dream's own state stays out of history");
});

test('a dream that cannot finish moves no watermark and commits nothing; the next model is tried first', async (t) => {
  const env = sandbox(t);
  write(env, 'memory/2026-10-20.md', '## 10:05\n하루', at(20, 10, 5));
  const dreamer = fakeDreamer({ code: 1 });
  const record = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(record.status, 'failed');
  assert.deepEqual(dreamer.calls.map((call) => call.args[call.args.indexOf('--model') + 1]), DREAM_MODELS.map((rung) => rung.model));
  assert.match(record.attempts[0].error, /overloaded/);
  const state = readDreamState(env);
  assert.equal(state.blocks, undefined);
  assert.equal(state.lastAttemptDate, '2026-10-21', 'a failed night is not retried every minute');
  assert.equal(git(env.RUBATO_COMPANION_HOME, 'log', '--format=%s').trim().split('\n').length, 1, 'only the home\'s first commit');
});

test('a child that touches the persona or another note changes only its copy, and the night is read again', async (t) => {
  const env = sandbox(t);
  const home = env.RUBATO_COMPANION_HOME;
  write(env, 'memory/2026-10-20.md', '## 10:05\n하루', at(20, 10, 5));
  write(env, 'prompt/soul.md', '# 내 영혼\n원래 문장');
  write(env, 'notes/mine.md', '깨어 있는 내 땅');
  const before = sha(path.join(home, 'prompt/soul.md'));
  const dreamer = fakeDreamer({
    edits: { 'memory/self.md': '## 지금\n', 'prompt/soul.md': '# 내 영혼\n꿈이 바꾼 문장', 'prompt/new.md': 'x', 'notes/mine.md': '꿈이 덮음' },
    result: { status: 'done', blocks: { distill: 'done', selfReview: 'failed', cleanup: 'skipped' }, changed: ['memory/self.md'], message: '나' },
  });
  const record = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(record.status, 'partial');
  assert.deepEqual(record.changed, ['memory/self.md']);
  assert.deepEqual(record.refused, ['notes/mine.md', 'prompt/new.md', 'prompt/soul.md']);
  assert.equal(sha(path.join(home, 'prompt/soul.md')), before);
  assert.ok(!existsSync(path.join(home, 'prompt/new.md')));
  assert.equal(readFileSync(path.join(home, 'notes/mine.md'), 'utf8'), '깨어 있는 내 땅');
  assert.equal(readDreamState(env).blocks, undefined, 'a refused change holds every mark');
});

test('a part the dream skipped keeps its old mark while the parts it did move', async (t) => {
  const env = sandbox(t);
  write(env, 'memory/2026-10-20.md', '## 10:05\n하루', at(20, 10, 5));
  const dreamer = fakeDreamer({ edits: { 'memory/self.md': '## 지금\n' },
    result: { status: 'partial', blocks: { distill: 'done', selfReview: 'failed', cleanup: 'skipped' } } });
  const record = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(record.status, 'partial');
  const state = readDreamState(env);
  assert.ok(state.blocks.distill.lastAt.startsWith('2026-10-21T04:07'));
  assert.equal(state.blocks.selfReview, undefined);
  assert.equal(state.blocks.cleanup, undefined);
});

test('what the user and Segno write while the dream runs stays: a persona saved in Settings, a daily line, a status edit', async (t) => {
  const env = sandbox(t);
  const home = env.RUBATO_COMPANION_HOME;
  write(env, 'memory/2026-10-20.md', '## 10:05\n첫 줄\n\n## 11:00\n둘째 줄\n\n## 12:00\n셋째 줄\n', at(20, 10, 5));
  write(env, 'memory/status.md', '# 현황\n- 하나\n');
  write(env, 'prompt/user.md', '# 사용자\n옛 선택\n');
  const dreamer = fakeDreamer({
    onRun: () => {
      writeFileSync(path.join(home, 'prompt/user.md'), '# 사용자\n새로 고른 것\n');
      appendFileSync(path.join(home, 'memory/2026-10-20.md'), '\n## 23:59\n깨어 있는 내가 쓴 줄\n');
      writeFileSync(path.join(home, 'memory/status.md'), '# 현황\n- 하나를 내가 고침\n');
    },
    edits: {
      // The sweep rewrites the first section of the day; Segno appended at the end: both stay.
      'memory/2026-10-20.md': '## 10:05\n첫 줄(걷음)\n\n## 11:00\n둘째 줄\n\n## 12:00\n셋째 줄\n',
      // Both rewrote the same line: Segno's stays and the dream's is reported.
      'memory/status.md': '# 현황\n- 하나를 꿈이 고침\n',
    },
    result: { status: 'done', blocks: { distill: 'done' }, changed: [] },
  });
  const record = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(readFileSync(path.join(home, 'prompt/user.md'), 'utf8'), '# 사용자\n새로 고른 것\n');
  const daily = readFileSync(path.join(home, 'memory/2026-10-20.md'), 'utf8');
  assert.match(daily, /첫 줄\(걷음\)/);
  assert.match(daily, /깨어 있는 내가 쓴 줄/);
  assert.equal(readFileSync(path.join(home, 'memory/status.md'), 'utf8'), '# 현황\n- 하나를 내가 고침\n');
  assert.deepEqual(record.conflicts, ['memory/status.md']);
  assert.deepEqual(record.changed, ['memory/2026-10-20.md']);
  assert.equal(record.status, 'partial');
  assert.equal(readDreamState(env).blocks, undefined, 'what did not come home is read again next night');
});

test('a child that breaks off after writing brings nothing home', async (t) => {
  const env = sandbox(t);
  const home = env.RUBATO_COMPANION_HOME;
  write(env, 'memory/2026-10-20.md', '## 10:05\n하루', at(20, 10, 5));
  write(env, 'prompt/user.md', '# 사용자\n원래\n');
  const record = await runCompanionDream({ env, launch, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [],
    spawnChild: async ({ cwd }) => {
      writeFileSync(path.join(cwd, 'prompt/user.md'), '# 사용자\n꿈이 실수로 고침\n');
      writeFileSync(path.join(cwd, 'memory/user.md'), '## 지금\n반쯤 쓴 것\n');
      throw new Error('the engine went away');
    } });
  assert.equal(record.status, 'failed');
  assert.equal(readFileSync(path.join(home, 'prompt/user.md'), 'utf8'), '# 사용자\n원래\n');
  assert.ok(!existsSync(path.join(home, 'memory/user.md')));
  assert.equal(readDreamState(env).blocks, undefined);
});

test('a night with nothing new calls no model, and a second dream waits for the first', async (t) => {
  const env = sandbox(t);
  const dreamer = fakeDreamer({ result: { status: 'done', blocks: {}, changed: [] } });
  // A first dream reads a week back; the week here is empty.
  const quiet = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(quiet.status, 'noop');
  assert.equal(dreamer.calls.length, 0);

  mkdirSync(dreamPaths(env).dir, { recursive: true });
  writeFileSync(dreamPaths(env).lock, JSON.stringify({ pid: 1, at: at(22, 4, 0) }));
  const busy = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(22, 4, 7), defaultsDir });
  assert.equal(busy.status, 'busy');
  // A lock left by a dream that died hours ago does not block the next night.
  write(env, 'memory/2026-10-23.md', '## 10:00\n하루', at(23, 10));
  const after = await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(24, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.notEqual(after.status, 'busy');
});

test('the dream starts its home history and resident memory once and leaves the person\'s files', async (t) => {
  const env = sandbox(t);
  const home = env.RUBATO_COMPANION_HOME;
  write(env, 'memory/2026-10-20.md', '## 10:05\n하루', at(20, 10, 5));
  write(env, 'memory/MEMORY.md', '# 내가 쓴 상주 기억');
  const dreamer = fakeDreamer({ result: { status: 'done', blocks: { distill: 'done' }, changed: [] } });
  await runCompanionDream({ env, launch, spawnChild: dreamer.spawnChild, now: () => at(21, 4, 7), defaultsDir, sessionFiles: () => [] });
  assert.equal(readFileSync(memoryPiecePath(env), 'utf8'), '# 내가 쓴 상주 기억');
  assert.ok(existsSync(path.join(home, '.git')));
  assert.equal(segnoPaths(env).home, home);
});
