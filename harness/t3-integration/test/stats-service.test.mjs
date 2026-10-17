import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EPISODE_MINIMUMS, aggregateStats, isScratchFolder, writingLanguage } from '../src/stats/aggregate.mjs';
import { fallbackStory, readableError } from '../src/stats/episodes.mjs';
import { STORY_SYSTEM_PROMPT, buildStoryPrompt, createStoryWriter, parseStory, readThinking } from '../src/stats/stories.mjs';
import { dayKey, hesitationCounts, summarizeSession } from '../src/stats/scan.mjs';
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
const failed = (ms, error) => line({ type: 'message', id: `e${seq++}`, timestamp: iso(ms), message: { role: 'assistant', model: 'claude-opus-5-5', stopReason: 'error', errorMessage: error, usage: {}, content: [] } });
const HESITANT = 'Hmm. '.repeat(18) + 'wait, actually what if ' + 'b'.repeat(900);
const toolResult = (ms) => line({ type: 'message', id: `t${seq++}`, timestamp: iso(ms), message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(50) }] } });

function sampleSession() {
  return [
    header(at(1, 23, 0), '/Users/me/work/app'),
    line({ type: 'thinking_level_change', id: 'l1', timestamp: iso(at(1, 23, 0)), thinkingLevel: 'high' }),
    user(at(1, 23, 1), 'fix the settlement total'),
    assistant(at(1, 23, 2), { usage: { input: 10, cacheRead: 900, cacheWrite: 50, output: 40, cost: { total: 1.2 } }, content: [{ type: 'thinking', thinking: 'Hmm. ' + 'a'.repeat(200) }, { type: 'toolCall', name: 'Agent', arguments: { model: 'openai-codex/gpt-6-astra' } }] }),
    toolResult(at(1, 23, 3)),
    assistant(at(1, 23, 10), { usage: { input: 5, cacheRead: 1000, output: 20, cost: { total: 0.3 } }, content: [{ type: 'thinking', thinking: HESITANT }], id: 'think-1' }),
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
  assert.deepEqual(s.minds[dayKey(at(1, 0))], [21, HESITANT.length, 'claude-opus-5-5', at(1, 23, 10), 'think-1'], 'the most hesitant block of the day');
  assert.deepEqual(s.costs[dayKey(at(1, 0))], [1.5, at(1, 23, 1), 19 * 60, 'fix the settlement total'], 'a turn costs every call until the next typed message');
  assert.equal(s.firstText, 'fix the settlement total');
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
  assert.deepEqual(week.episodes.map((episode) => episode.kind), ['mind', 'cost'], 'the first message is 40 days back, outside the week');
  const mind = week.episodes.find((episode) => episode.kind === 'mind');
  assert.equal(mind.id, `mind|a.jsonl|think-1`);
  assert.equal(mind.title, 'Settlement fix');
  assert.deepEqual(mind._language, { sample: 'fix the settlement total' }, 'Latin script names no language: the session\'s own message is the sample');
  assert.deepEqual(all.episodes.at(-1).kind, 'first');
  assert.equal(all.episodes.at(-1).value, 41, 'day 41 of the history');
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

test('episodes pick the strongest moment of each kind and skip the everyday ones', () => {
  const night = (hour) => user(at(2, hour), 'still here');
  const summaries = {
    'busy.jsonl': summarizeSession([
      header(at(2, 0, 30), '/Users/me/work/app'),
      ...Array.from({ length: 12 }, (_, i) => night(1 + (i % 4))),
      ...Array.from({ length: 6 }, (_, i) => assistant(at(2, 5, i), { content: [{ type: 'toolCall', name: 'Agent', arguments: { model: 'x/y' } }] })),
      failed(at(2, 7, 0), 'terminated'),
      failed(at(2, 7, 10), 'Request timed out.'),
      failed(at(2, 7, 40), "Account 'sub' is unavailable"),
      assistant(at(2, 7, 41)),
    ]),
    'quiet.jsonl': summarizeSession([
      header(at(3, 10), '/Users/me/work/app'),
      user(at(3, 10, 1), 'hi'),
      assistant(at(3, 10, 2), { content: [{ type: 'toolCall', name: 'Agent', arguments: {} }] }),
      failed(at(3, 10, 3), 'x'),
      failed(at(3, 10, 4), 'y'),
    ]),
  };
  const { week } = aggregateStats(summaries, [], { now: NOW, home: '/Users/me' }).periods;
  const byKind = Object.fromEntries(week.episodes.map((episode) => [episode.kind, episode]));
  assert.equal(byKind.night.value, 12);
  assert.equal(byKind.swarm.value, 6);
  assert.deepEqual(byKind.outage.facts, { failures: 3, seconds: 40 * 60, error: "Account 'sub' is unavailable" });
  assert.equal(Object.values(byKind).some((episode) => episode._file === 'quiet.jsonl' && episode.kind !== 'first'), false, `below ${JSON.stringify(EPISODE_MINIMUMS)} is not an episode`);
  assert.deepEqual(week.episodes.map((episode) => episode.at), week.episodes.map((episode) => episode.at).toSorted().toReversed(), 'newest first');
});

test('every kind reads in plain English before a model writes its story', () => {
  const base = { title: 'Fix the ledger', project: 'app', value: 1 };
  const cases = [
    [{ kind: 'mind', facts: { hesitations: 376, chars: 16004, model: 'm' } }, /376 times/],
    [{ kind: 'cost', facts: { usd: 72.95, seconds: 17_160, message: '알아서 해줘' } }, /\$72\.95.*4h 46m|4h 46m.*\$72\.95/],
    [{ kind: 'swarm', facts: { agents: 51, teams: 1 } }, /51 times and formed 1 team/],
    [{ kind: 'night', facts: { messages: 95, night: '2026-10-02' } }, /95 messages/],
    [{ kind: 'outage', facts: { failures: 29, seconds: 9_900, error: "Account 'sub' is unavailable" } }, /2h 45m.*Account 'sub' is unavailable/],
    [{ kind: 'solo', facts: { calls: 586, seconds: 10_307 } }, /2h 52m/],
    [{ kind: 'first', value: 58, facts: { message: 'vercel 모델이 뜨는데' } }, /58 days ago/],
  ];
  assert.equal(readableError('{"error":{"message":"{\\"error\\":{\\"message\\":\\"Overloaded\\",\\"type\\":\\"overloaded_error\\"}}"}}'), 'Overloaded');
  assert.equal(readableError("Account 'sub' is unavailable"), "Account 'sub' is unavailable");
  for (const [episode, pattern] of cases) {
    const words = fallbackStory({ ...base, ...episode });
    assert.ok(words.headline.length > 0, episode.kind);
    assert.match(`${words.headline} ${words.story}`, pattern, episode.kind);
  }
});

test('a story prompt carries the kind, the facts, the language sample and, for thinking, the counts', () => {
  const episode = { kind: 'mind', title: 'Rebate', project: 'app', facts: { hesitations: 3 } };
  const prompt = buildStoryPrompt(episode, { thinking: 'Hmm. hmm wait, 음, x', language: { sample: '정산 고쳐줘' } });
  assert.match(prompt, /second-guessed itself/);
  assert.match(prompt, /"hesitations":3/);
  assert.match(prompt, /not part of the episode; do not answer or retell it\): 정산 고쳐줘/);
  const named = buildStoryPrompt(episode, { language: { name: 'Korean' } });
  assert.match(named, /Write in Korean\./);
  assert.doesNotMatch(named, /정산/, 'a named language sends no message along');
  const session = (text, start) => ['x', { firstText: text, start }];
  assert.equal(writingLanguage([session('fix the bug', 1), session('정산 고쳐줘 rubato-pi 에서', 2)]), 'Korean');
  assert.equal(writingLanguage([session('このバグを直して', 1)]), 'Japanese');
  assert.equal(writingLanguage([session('修复这个错误', 1)]), 'Chinese');
  assert.equal(writingLanguage([session('arregla el error', 1)]), null, 'Latin script leaves it to the sample');
  assert.equal(writingLanguage([]), null);
  assert.match(prompt, /Counted in the thinking: Hmm: 2, Wait: 1, 음: 1\./);
  assert.match(prompt, /<thinking>/);
  assert.doesNotMatch(buildStoryPrompt({ ...episode, kind: 'cost' }, { language: null }), /<thinking>/);
  assert.match(STORY_SYSTEM_PROMPT, /Never name people other than the person/);
  assert.match(STORY_SYSTEM_PROMPT, /Do not invent events/);
  const timed = buildStoryPrompt({ kind: 'outage', title: 'T', project: 'p', facts: { failures: 29, seconds: 3463, error: 'x' } }, { language: null });
  assert.match(timed, /"duration":"58m"/);
  assert.doesNotMatch(timed, /3463/, 'no raw seconds reach the model');
  assert.match(buildStoryPrompt({ kind: 'outage', title: 'T', project: 'p', facts: { error: '{"error":{"message":"Overloaded"}}' } }, { language: null }), /"error":"Overloaded"/);
  assert.deepEqual(hesitationCounts('Hold on. On second thought, scratch that'), { 'Hold on': 1, 'On second thought': 2 });
  assert.deepEqual(parseStory('```json\n{"headline":" H ","story":"S"}\n```'), { headline: 'H', story: 'S' });
  assert.equal(parseStory('{"headline":"H"}'), null);
  assert.equal(parseStory('no json'), null);
});

test('the story writer falls through the ladder until a model returns a story', async () => {
  const tried = [];
  const write = createStoryWriter({
    models: () => [{ provider: 'a', id: 'broke' }, { provider: 'b', id: 'chatty' }, { provider: 'c', id: 'good', reasoning: 'off' }],
    run: async ({ model, reasoning }) => {
      tried.push([model, reasoning]);
      if (model === 'a/broke') throw new Error('no credit');
      if (model === 'b/chatty') return 'I cannot';
      return '{"headline":"H","story":"S"}';
    },
  });
  assert.deepEqual(await write({ kind: 'night', facts: {}, project: 'p' }, { language: null }), { headline: 'H', story: 'S', model: 'c/good' });
  assert.deepEqual(tried, [['a/broke', undefined], ['b/chatty', undefined], ['c/good', 'off']]);
});

test('by default stories walk the session-title ladder: the user setting, else the built-in one', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-stats-ladder-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
  const tried = [];
  const write = createStoryWriter({ run: async ({ model }) => { tried.push(model); throw new Error('down'); } });
  await assert.rejects(write({ kind: 'night', facts: {}, project: 'p' }, {}));
  assert.deepEqual(tried, TITLE_MODELS.map((rung) => `${rung.provider}/${rung.id}`));
  await mkdir(path.join(home, '.rubato'), { recursive: true });
  await writeFile(path.join(home, '.rubato', 'rubato.jsonc'), '{ "titles": { "models": ["xai/grok-4.7"] } }');
  tried.length = 0;
  await assert.rejects(write({ kind: 'night', facts: {}, project: 'p' }, {}));
  assert.deepEqual(tried, ['xai/grok-4.7'], 'a ladder changed in Settings applies to the next story');
});

test('readThinking finds the block by entry id', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rb-stats-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  await writeFile(file, sampleSession().join('\n'));
  assert.equal(await readThinking(file, 'think-1'), HESITANT);
  assert.equal(await readThinking(file, 'missing'), null);
});

test('episodes show plain English at once, and stories are written in the background one at a time', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-stats-svc-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  await writeFile(path.join(agentDir, 'sessions', 'a.jsonl'), sampleSession().join('\n'));
  const asked = [];
  let inFlight = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createStatsService({
    env: { HOME: '/Users/me' },
    agentDir,
    now: () => NOW,
    scan: async () => ({ sessions: { 'a.jsonl': summarizeSession(sampleSession()) }, speed: [] }),
    write: async (episode, material) => {
      inFlight += 1;
      assert.equal(inFlight, 1, 'one model call at a time');
      asked.push([episode.kind, material]);
      await gate;
      inFlight -= 1;
      return { headline: `${episode.kind} story`, story: 'Told well.', model: 'x/y' };
    },
  });
  const first = await service.handle('summary');
  assert.equal(first.status, 'ready');
  const mind = first.periods.week.episodes.find((episode) => episode.kind === 'mind');
  assert.equal(mind.storyState, 'writing');
  assert.match(mind.headline, /Second-guessed itself 21 times/, 'plain English while the story is written');
  assert.equal(Object.keys(mind).some((key) => key.startsWith('_')), false, 'files and entries stay on the server');
  release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const kinds = asked.map(([kind]) => kind);
  assert.deepEqual(new Set(kinds).size, kinds.length, 'one story per moment, even when several periods show it');
  const thinking = asked.find(([kind]) => kind === 'mind')[1];
  assert.equal(thinking.thinking, HESITANT);
  assert.deepEqual(thinking.language, { sample: 'fix the settlement total' });
  const later = await service.handle('summary');
  const written = later.periods.all.episodes.find((episode) => episode.kind === 'mind');
  assert.equal(written.storyState, 'written');
  assert.equal(written.headline, 'mind story');
  const saved = JSON.parse(await readFile(path.join(agentDir, 'cache', 'stats', 'stories-v1.json'), 'utf8'));
  assert.equal(saved['mind|a.jsonl|think-1'].story, 'Told well.');
});

test('a failed story keeps the plain English and is not retried on every visit', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-stats-fail-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  await writeFile(path.join(agentDir, 'sessions', 'a.jsonl'), sampleSession().join('\n'));
  let calls = 0;
  const warn = t.mock.method(console, 'warn', () => {});
  const service = createStatsService({
    env: { HOME: '/Users/me' }, agentDir, now: () => NOW,
    scan: async () => ({ sessions: { 'a.jsonl': summarizeSession(sampleSession()) }, speed: [] }),
    write: async () => { calls += 1; throw new Error('all models down'); },
  });
  const first = await service.handle('summary');
  const count = first.periods.all.episodes.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = await service.handle('summary');
  assert.equal(calls, count);
  assert.equal(after.periods.all.episodes.every((episode) => episode.storyState === 'plain'), true);
  assert.equal(warn.mock.callCount(), count);
});

test('warm reads the logs ahead without writing stories, and an empty machine still answers', async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'rb-stats-empty-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  let writes = 0;
  const service = createStatsService({ env: { HOME: '/Users/new' }, agentDir, now: () => NOW, write: async () => { writes += 1; return {}; } });
  assert.deepEqual(await service.handle('warm'), { status: 'scanning' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await service.handle('warm'), { status: 'ready' });
  const answer = await service.handle('summary');
  assert.equal(answer.status, 'ready');
  assert.equal(answer.firstDay, null);
  assert.equal(answer.periods.all.turns, 0);
  assert.deepEqual(answer.periods.all.episodes, []);
  assert.equal(answer.periods.week.daily.length, 7);
  assert.equal(writes, 0);
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
  const service = createStatsService({ env: { HOME: '/Users/me' }, agentDir, now: () => NOW, write: async () => ({ headline: 'H', story: 'S', model: 'm' }) });
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
