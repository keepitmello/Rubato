import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateStats, isScratchFolder } from '../src/stats/aggregate.mjs';
import { buildExplainPrompt, countMarkers, createExplainer, parseExplanation, readThinking } from '../src/stats/explain.mjs';
import { dayKey, summarizeSession } from '../src/stats/scan.mjs';
import { createStatsService, handleStatsRequest } from '../src/stats/service.mjs';
import { TITLE_MODELS } from '../../pi-runtime/features/session-title/session-title.mjs';

// Local noon on 2026-10-17 (a Saturday), so day keys do not depend on the machine's zone.
const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime();
const at = (daysAgo, hour, minute = 0) => new Date(2026, 9, 17 - daysAgo, hour, minute, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
const line = (value) => JSON.stringify(value);
const header = (ms, cwd) => line({ type: 'session', version: 3, id: `s${seq++}`, timestamp: iso(ms), cwd });
const user = (ms, text) => line({ type: 'message', id: `u${seq++}`, timestamp: iso(ms), message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (ms, { model = 'claude-opus-5-5', usage = {}, content = [], id = `a${seq++}` } = {}) =>
  line({ type: 'message', id, timestamp: iso(ms), message: { role: 'assistant', model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage }, content } });
const toolResult = (ms) => line({ type: 'message', id: `t${seq++}`, timestamp: iso(ms), message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(50) }] } });

function sampleSession() {
  return [
    header(at(1, 23, 0), '/Users/me/work/app'),
    line({ type: 'thinking_level_change', id: 'l1', timestamp: iso(at(1, 23, 0)), thinkingLevel: 'high' }),
    user(at(1, 23, 1), 'fix the settlement total'),
    assistant(at(1, 23, 2), { usage: { input: 10, cacheRead: 900, cacheWrite: 50, output: 40 }, content: [{ type: 'thinking', thinking: 'Hmm. ' + 'a'.repeat(200) }, { type: 'toolCall', name: 'Agent', arguments: { model: 'openai-codex/gpt-6-astra' } }] }),
    toolResult(at(1, 23, 3)),
    assistant(at(1, 23, 10), { usage: { input: 5, cacheRead: 1000, output: 20 }, content: [{ type: 'thinking', thinking: 'longest ' + 'b'.repeat(900) }], id: 'think-1' }),
    assistant(at(1, 23, 20), { model: 'deepseek-v4.1-flash', usage: { input: 3, output: 7 }, content: [{ type: 'toolCall', name: 'team_create', arguments: {} }] }),
    user(at(1, 23, 30), '<runtime-notice>woke up</runtime-notice>'),
    line({ type: 'thinking_level_change', id: 'l2', timestamp: iso(at(1, 23, 31)), thinkingLevel: 'xhigh' }),
    user(at(0, 2, 0), 'and the September one'),
    assistant(at(0, 2, 1), { usage: { input: 1, output: 1 } }),
    line({ type: 'session_info', id: 'n1', timestamp: iso(at(0, 2, 2)), name: 'Settlement fix' }),
  ];
}

test('a session log reduces to typed turns, levels, usage, the longest think and the longest run', () => {
  const s = summarizeSession(sampleSession());
  assert.equal(s.cwd, '/Users/me/work/app');
  assert.equal(s.title, 'Settlement fix');
  assert.deepEqual(s.turns, [at(1, 23, 1), at(0, 2, 0)], 'the tagged runtime notice is not a typed message');
  assert.deepEqual(s.levels, ['high', 'xhigh']);
  assert.deepEqual(s.usage[`${dayKey(at(1, 0))}|claude-opus-5-5`], [2, 15, 1900, 50, 60]);
  assert.deepEqual(s.usage[`${dayKey(at(1, 0))}|deepseek-v4.1-flash`], [1, 3, 0, 0, 7]);
  assert.deepEqual(s.thinks[dayKey(at(1, 0))], [908, 'claude-opus-5-5', at(1, 23, 10), 'think-1']);
  assert.deepEqual(s.runs[dayKey(at(1, 0))], [3, 18 * 60, at(1, 23, 2)], 'a run ends at its last call, not when the person comes back');
  assert.deepEqual(s.agents, [[at(1, 23, 2), 'openai-codex/gpt-6-astra']]);
  assert.deepEqual(s.teams, [at(1, 23, 20)]);
  assert.deepEqual(s.work, [[at(1, 23, 1), at(1, 23, 20)], [at(0, 2, 0), at(0, 2, 1)]], 'a notice with no reply is no work');
});

test('a system wake or a runtime notice starts a new stretch, so idle time between is not work', () => {
  const s = summarizeSession([
    header(at(3, 9), '/Users/me/work/app'),
    user(at(3, 9, 0), 'start'),
    assistant(at(3, 9, 5)),
    line({ type: 'message', id: 'sys', timestamp: iso(at(1, 9, 0)), message: { role: 'system', content: [{ type: 'text', text: 'wake' }] } }),
    assistant(at(1, 9, 3)),
    line({ type: 'custom_message', customType: 'senpi-task.completion', content: 'x'.repeat(5000), display: false, id: 'c1', timestamp: iso(at(0, 9, 0)) }),
    assistant(at(0, 9, 2)),
  ]);
  assert.deepEqual(s.work, [[at(3, 9, 0), at(3, 9, 5)], [at(1, 9, 0), at(1, 9, 3)], [at(0, 9, 0), at(0, 9, 2)]]);
  assert.deepEqual(s.turns, [at(3, 9, 0)], 'a wake is not a typed message');
});

test('a file without a session header is not counted', () => {
  assert.equal(summarizeSession([line({ id: 'x', objective: 'goal history' })]), null);
  assert.equal(summarizeSession([]), null);
});

test('periods count by calendar day, skip scratch folders and score speed like the composer', () => {
  const summaries = {
    'a.jsonl': summarizeSession(sampleSession()),
    'old.jsonl': summarizeSession([header(at(40, 10), '/Users/me'), user(at(40, 10, 1), 'hello'), assistant(at(40, 10, 2), { model: 'gpt-6-astra', usage: { input: 100, output: 5 } })]),
    'bench.jsonl': summarizeSession([header(at(0, 9), '/private/tmp/bench/run-1'), user(at(0, 9, 1), 'bench'), assistant(at(0, 9, 2), { usage: { input: 1e6 } })]),
  };
  const speed = [
    ...Array.from({ length: 20 }, () => [dayKey(at(1, 0)), 'claude-opus-5-5', 2]),
    ...Array.from({ length: 20 }, () => [dayKey(at(35, 0)), 'claude-opus-5-5', 0.5]),
    ...Array.from({ length: 3 }, () => [dayKey(at(1, 0)), 'rare-model', 9]),
  ];
  const stats = aggregateStats(summaries, speed, { now: NOW, home: '/Users/me' });
  const { week, all } = stats.periods;
  assert.equal(week.sessions, 1);
  assert.equal(week.turns, 2);
  assert.equal(week.calls, 4);
  assert.deepEqual(week.tokens, { input: 19, cacheRead: 1900, cacheWrite: 50, output: 68 });
  assert.equal(week.daily.length, 7);
  assert.deepEqual(week.daily.at(-1), [dayKey(NOW), 1]);
  assert.deepEqual(week.levels, { high: 1, xhigh: 1 });
  assert.equal(week.heat[4][23], 1, 'Friday 23:00, Monday first');
  assert.equal(week.hourly[2], 1);
  assert.equal(week.nightShare, 0.5);
  assert.deepEqual(week.speed, [{ model: 'claude-opus-5-5', score: 200, samples: 20 }], 'too few samples hide a model');
  assert.equal(all.speed[0].score, 100, 'all time pools both weeks');
  assert.equal(week.think.key, 'a.jsonl#think-1');
  assert.equal(week.think.title, 'Settlement fix');
  assert.deepEqual(week.delegation, { agents: 1, teams: 1, models: [{ model: 'openai-codex/gpt-6-astra', count: 1 }] });
  assert.equal(week.projects[0].name, 'app');
  assert.equal(week.projects[0].topModel, 'claude-opus-5-5');
  assert.equal(all.sessions, 2, 'the scratch-folder benchmark is not counted');
  assert.equal(all.projects.find((p) => p.name === '~').turns, 1);
  assert.equal(stats.firstDay, dayKey(at(40, 0)));
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.bestStreak, 2);
  assert.equal(stats.attendance[dayKey(NOW)], 1);
  assert.equal(all.daily[0][0], dayKey(at(40, 0)), 'all time starts at the first active day');
  assert.equal(week.work.seconds, 20 * 60, 'Friday 23:01–23:20 and Saturday 02:00–02:01');
  assert.equal(week.work.agentSeconds, 20 * 60);
  assert.deepEqual(week.work.longestDay, { day: dayKey(at(1, 0)), seconds: 19 * 60 });
  assert.equal(week.work.activeDays, 2);
  assert.equal(week.work.averageSeconds, 10 * 60);
  assert.equal(week.work.daily.length, 7);
  assert.equal(isScratchFolder('/tmp'), true);
  assert.equal(isScratchFolder('/Users/me/tmp'), false);
});

test('time two sessions worked side by side counts once on the clock and twice for the agents, split at midnight', () => {
  const work = (startDay, startHour, endDay, endHour) => summarizeSession([
    header(at(startDay, startHour), '/Users/me/x'),
    user(at(startDay, startHour), 'go'),
    assistant(at(endDay, endHour)),
  ]);
  const stats = aggregateStats({ 'a.jsonl': work(1, 22, 1, 23), 'b.jsonl': work(1, 22, 0, 1) }, [], { now: NOW, home: '/Users/me' });
  const { work: time } = stats.periods.week;
  assert.equal(time.seconds, 3 * 3600);
  assert.equal(time.agentSeconds, 4 * 3600);
  assert.deepEqual(time.daily.slice(-2), [[dayKey(at(1, 0)), 2 * 3600, 3 * 3600], [dayKey(NOW), 3600, 3600]]);
});

test('the explain prompt carries counts the model cannot do, and replies parse into a card', () => {
  assert.deepEqual(countMarkers('Hmm. hmm — What if... ✗ ✓ ✓ wait, no'), { Hmm: 2, Wait: 1, 'What if': 1, '✗': 1, '✓': 2 });
  const prompt = buildExplainPrompt({ thinking: 'Hmm. x', title: 'T', userText: '정산 고쳐줘', model: 'm' });
  assert.match(prompt, /Hmm: 1/);
  assert.match(prompt, /정산 고쳐줘/);
  assert.deepEqual(parseExplanation('sure\n{"headline":" H ","body":"B","chips":["a",3,"b","c","d"]}'), { headline: 'H', body: 'B', chips: ['a', 'b', 'c'] });
  assert.equal(parseExplanation('{"headline":"","body":"B"}'), null);
  assert.equal(parseExplanation('no json'), null);
  assert.match(prompt, /Do not answer it/);
  assert.match(prompt, /Write the card now as the JSON object\.$/);
});

test('the explainer falls through the ladder until a model returns a card', async () => {
  const tried = [];
  const explain = createExplainer({
    models: () => [{ provider: 'a', id: 'broke' }, { provider: 'b', id: 'chatty' }, { provider: 'c', id: 'good', reasoning: 'low' }],
    run: async ({ model, reasoning }) => {
      tried.push([model, reasoning]);
      if (model === 'a/broke') throw new Error('no credit');
      if (model === 'b/chatty') return 'I cannot';
      return '{"headline":"H","body":"B","chips":[]}';
    },
  });
  assert.deepEqual(await explain({ thinking: 't', title: null, userText: null, model: 'm' }), { headline: 'H', body: 'B', chips: [], model: 'c/good' });
  assert.deepEqual(tried, [['a/broke', undefined], ['b/chatty', undefined], ['c/good', 'low']]);
});

test('by default the card walks the session-title ladder: the user setting, else the built-in one', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-stats-ladder-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
  const tried = [];
  const explain = createExplainer({ run: async ({ model }) => { tried.push(model); throw new Error('down'); } });
  await assert.rejects(explain({ thinking: 't', title: null, userText: null, model: 'm' }));
  assert.deepEqual(tried, TITLE_MODELS.map((rung) => `${rung.provider}/${rung.id}`));
  await mkdir(path.join(home, '.rubato'), { recursive: true });
  await writeFile(path.join(home, '.rubato', 'rubato.jsonc'), '{ "titles": { "models": ["xai/grok-4.7"] } }');
  tried.length = 0;
  await assert.rejects(explain({ thinking: 't', title: null, userText: null, model: 'm' }));
  assert.deepEqual(tried, ['xai/grok-4.7'], 'a ladder changed in Settings applies to the next card');
});

test('readThinking finds the block by entry id and the first typed message', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rb-stats-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  await writeFile(file, sampleSession().join('\n'));
  const found = await readThinking(file, 'think-1');
  assert.equal(found.userText, 'fix the settlement total');
  assert.equal(found.thinking.length, 908);
  assert.equal(await readThinking(file, 'missing'), null);
});

test('the service answers from the scan, writes each card once and serves it after', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-stats-svc-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  await writeFile(path.join(agentDir, 'sessions', 'a.jsonl'), sampleSession().join('\n'));
  const asked = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createStatsService({
    env: { HOME: '/Users/me' },
    agentDir,
    now: () => NOW,
    scan: async () => ({ sessions: { 'a.jsonl': summarizeSession(sampleSession()) }, speed: [] }),
    explain: async (input) => { asked.push(input); await gate; return { headline: 'Settlement puzzle', body: 'It worked it out.', chips: ['Hmm ×1'], model: 'x/y' }; },
  });
  const first = await service.handle('summary');
  assert.equal(first.status, 'ready');
  assert.equal(first.periods.week.think.cardState, 'writing');
  assert.equal(first.periods.week.think.card, null);
  assert.equal('key' in first.periods.week.think, false, 'file paths stay on the server');
  const second = await service.handle('summary');
  assert.equal(second.periods.week.think.cardState, 'writing');
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asked.length, 1, 'one card per record, even with three periods and two visits');
  assert.equal(asked[0].userText, 'fix the settlement total');
  const third = await service.handle('summary');
  assert.equal(third.periods.month.think.cardState, 'ready');
  assert.deepEqual(third.periods.month.think.card, { headline: 'Settlement puzzle', body: 'It worked it out.', chips: ['Hmm ×1'] });
  const saved = JSON.parse(await readFile(path.join(agentDir, 'cache', 'stats', 'explanations-v1.json'), 'utf8'));
  assert.equal(saved['a.jsonl#think-1'].headline, 'Settlement puzzle');
});

test('a failed card is not retried on every visit', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-stats-fail-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  await writeFile(path.join(agentDir, 'sessions', 'a.jsonl'), sampleSession().join('\n'));
  let calls = 0;
  const warn = t.mock.method(console, 'warn', () => {});
  const service = createStatsService({
    env: { HOME: '/Users/me' }, agentDir, now: () => NOW,
    scan: async () => ({ sessions: { 'a.jsonl': summarizeSession(sampleSession()) }, speed: [] }),
    explain: async () => { calls += 1; throw new Error('all models down'); },
  });
  await service.handle('summary');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await service.handle('summary');
  assert.equal(calls, 1);
  assert.equal(after.periods.week.think.cardState, 'unavailable');
  assert.equal(warn.mock.callCount(), 1);
});

test('the worker reads changed files only and keeps its cache across scans', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-stats-worker-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const sessions = path.join(agentDir, 'sessions', '--project--');
  await mkdir(sessions, { recursive: true });
  await mkdir(path.join(agentDir, 'speed-index', 'samples'), { recursive: true });
  const file = path.join(sessions, 'a.jsonl');
  await writeFile(file, sampleSession().join('\n'));
  await writeFile(path.join(agentDir, 'sessions', 'not-a-session.jsonl'), line({ objective: 'x' }));
  const service = createStatsService({ env: { HOME: '/Users/me' }, agentDir, now: () => NOW, explain: async () => ({ headline: 'H', body: 'B', chips: [], model: 'm' }) });
  const first = await service.handle('summary');
  assert.equal(first.status, 'ready');
  assert.equal(first.periods.all.turns, 2);
  const cacheFile = path.join(agentDir, 'cache', 'stats', 'scan-v1.json');
  const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.ok(cached.sessions['--project--/a.jsonl'].value);
  assert.equal(cached.sessions['not-a-session.jsonl'].value, null);
  // Same size and mtime: the cached summary is used even though the bytes differ.
  const info = await stat(file);
  await writeFile(file, sampleSession().join('\n').replace('and the September one', 'and the Septembre one'));
  await utimes(file, info.atime, info.mtime);
  assert.equal((await service.handle('summary')).periods.all.turns, 2);
  // A grown file is read again.
  await writeFile(file, [...sampleSession(), user(at(0, 3), 'one more')].join('\n'));
  assert.equal((await service.handle('summary')).periods.all.turns, 3);
});

test('the HTTP handler answers summary over GET and POST and refuses the rest', async () => {
  const service = { handle: async (action) => { if (action !== 'summary') { const { StatsRequestError } = await import('../src/stats/service.mjs'); throw new StatsRequestError(404, 'unknown-action', 'nope'); } return { status: 'ready' }; } };
  const ok = await handleStatsRequest(service, new Request('http://x/rubato/stats/summary'));
  assert.deepEqual(await ok.json(), { status: 'ready' });
  assert.equal((await handleStatsRequest(service, new Request('http://x/rubato/stats/other'))).status, 404);
  assert.equal((await handleStatsRequest(service, new Request('http://x/rubato/stats/summary', { method: 'POST', body: '{}' }))).status, 200);
  assert.equal((await handleStatsRequest(service, new Request('http://x/rubato/stats/summary', { method: 'PUT' }))).status, 405);
});
