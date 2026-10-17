// File summaries (scan.mjs) → what the Stats page draws, for each period at once.
// Pure: the clock, the home folder and the summaries come in as arguments.
import path from 'node:path';
import { dayKey } from './scan.mjs';
import { scoreFromRatios } from '../../../rubato-pi/src/speed-index.mjs';

export const PERIODS = Object.freeze({ week: 7, month: 30, all: null });
// Benchmarks and evaluations run in throwaway folders; they are not the person's work.
const SCRATCH_ROOTS = ['/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/'];
const MIN_SPEED_SAMPLES = 15;
const TOP_MODELS = 8;
const TOP_PROJECTS = 8;
// An episode below these is not a story: a handful of subagents or two failed calls happen every day.
export const EPISODE_MINIMUMS = Object.freeze({ mind: 20, cost: 1, swarm: 5, night: 10, outage: 3, solo: 50 });

export function isScratchFolder(cwd) {
  return typeof cwd === 'string' && SCRATCH_ROOTS.some((root) => cwd === root.slice(0, -1) || cwd.startsWith(root));
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms, days) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Calendar days from `from` through `to`, both YYYY-MM-DD. */
export function daysBetween(from, to) {
  const out = [];
  for (let ms = Date.parse(`${from}T12:00:00`); dayKey(ms) <= to; ms = addDays(ms, 1)) out.push(dayKey(ms));
  return out;
}

function longestRun(days) {
  let best = 0;
  let current = 0;
  let previous = null;
  for (const day of days) {
    current = previous && daysBetween(previous, day).length === 2 ? current + 1 : 1;
    if (current > best) best = current;
    previous = day;
  }
  return best;
}

/** Seconds per local day of [start, end) intervals, split at midnight. */
function secondsByDay(intervals, into) {
  for (const [start, end] of intervals) {
    let cursor = start;
    while (cursor < end) {
      const midnight = addDays(startOfDay(cursor), 1);
      const stop = Math.min(end, midnight);
      const day = dayKey(cursor);
      into.set(day, (into.get(day) ?? 0) + (stop - cursor) / 1000);
      cursor = stop;
    }
  }
  return into;
}

/** Overlapping intervals merged, so time two sessions shared counts once. */
export function unionIntervals(intervals) {
  const sorted = intervals.toSorted((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Time the agents worked in the period, per day. `seconds` counts wall-clock time with at
 * least one session working; `agentSeconds` adds every session's time, so two sessions
 * working side by side for an hour count one hour and two.
 */
function workTime(sessions, fromMs, now, days) {
  const clipped = [];
  for (const [, s] of sessions) for (const [start, end] of s.work ?? []) {
    const a = Math.max(start, fromMs);
    const b = Math.min(end, now);
    if (b > a) clipped.push([a, b]);
  }
  const wall = secondsByDay(unionIntervals(clipped), new Map());
  const agent = secondsByDay(clipped, new Map());
  const daily = days.map((day) => [day, Math.round(wall.get(day) ?? 0), Math.round(agent.get(day) ?? 0)]);
  const seconds = daily.reduce((sum, row) => sum + row[1], 0);
  const agentSeconds = daily.reduce((sum, row) => sum + row[2], 0);
  const worked = daily.filter((row) => row[1] > 0);
  const longest = worked.reduce((best, row) => (!best || row[1] > best[1] ? row : best), null);
  return {
    seconds,
    agentSeconds,
    activeDays: worked.length,
    averageSeconds: worked.length ? Math.round(seconds / worked.length) : 0,
    longestDay: longest ? { day: longest[0], seconds: longest[1] } : null,
    daily,
  };
}

/** The first message typed into the first session: where the history starts. */
function firstTurn(sessions) {
  let first = null;
  for (const [name, s] of sessions) {
    const at = s.turns[0];
    if (at !== undefined && (!first || at < first.at)) first = { at, session: s, name };
  }
  return first;
}

/**
 * Episodes, newest first. `id` names the moment for the story cache; fields that start with
 * an underscore stay on the server (the file, the entry, the language sample).
 */
function episodes(best, home, language) {
  return Object.values(best)
    .map(({ kind, value, at, session, name, facts, entryId }) => ({
      id: `${kind}|${name}|${entryId ?? at}`,
      kind,
      at: new Date(at).toISOString(),
      value,
      title: session.title,
      project: projectOf(session.cwd, home).name,
      facts,
      _file: name,
      _entryId: entryId,
      _language: language ? { name: language } : { sample: session.firstText },
    }))
    .toSorted((a, b) => (a.at < b.at ? 1 : -1));
}

function projectOf(cwd, home) {
  if (!cwd) return { path: null, name: 'Unknown' };
  const clean = cwd.replace(/\/+$/, '');
  if (clean === home.replace(/\/+$/, '')) return { path: clean, name: '~' };
  return { path: clean, name: path.basename(clean) || clean };
}

function topBy(map, size, score) {
  return [...map.entries()].toSorted((a, b) => score(b[1]) - score(a[1])).slice(0, size);
}

// Scripts that name a language on their own. Latin script does not (English, Spanish and
// German share it), so those fall back to a sample from the episode's own session.
const SCRIPTS = [
  ['Korean', /[\uac00-\ud7af]/g],
  ['Japanese', /[\u3040-\u30ff]/g],
  ['Chinese', /[\u4e00-\u9fff]/g],
  ['Russian', /[\u0400-\u04ff]/g],
  ['Latin', /[A-Za-z]/g],
];

/**
 * The language the person writes in, from the first messages of their latest sessions:
 * a name when the script gives it away, else null. Only the name reaches a story prompt,
 * never the messages, so nothing from another session leaks into a story.
 */
export function writingLanguage(sessions) {
  const text = sessions
    .filter(([, s]) => s.firstText)
    .toSorted(([, a], [, b]) => b.start - a.start)
    .slice(0, 5)
    .map(([, s]) => s.firstText)
    .join(' ');
  const counts = SCRIPTS.map(([name, pattern]) => [name, text.match(pattern)?.length ?? 0]);
  const letters = counts.reduce((sum, [, count]) => sum + count, 0);
  if (!letters) return null;
  // Japanese writes kanji too; kana decides it before Chinese does.
  const share = (name) => counts.find(([script]) => script === name)[1] / letters;
  if (share('Korean') > 0.15) return 'Korean';
  if (share('Japanese') > 0.1) return 'Japanese';
  if (share('Chinese') > 0.2) return 'Chinese';
  if (share('Russian') > 0.3) return 'Russian';
  return null;
}

function aggregatePeriod(sessions, speed, { days, now, home, language }) {
  const today = dayKey(now);
  const fromMs = days ? startOfDay(addDays(now, -(days - 1))) : -Infinity;
  const from = days ? dayKey(fromMs) : null;
  const inDay = (day) => from === null || day >= from;
  const out = {
    days,
    sessions: 0,
    turns: 0,
    calls: 0,
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    heat: Array.from({ length: 7 }, () => Array(24).fill(0)),
    levels: {},
  };
  const daily = new Map();
  const models = new Map();
  const projects = new Map();
  const agentModels = new Map();
  let agents = 0;
  let teams = 0;
  let run = null;
  let longest = null;
  // The strongest moment of each episode kind in the period; see episodes() for the shape.
  const best = {};
  const offer = (kind, value, at, s, name, facts, entryId = null) => {
    if (value < EPISODE_MINIMUMS[kind] || (best[kind] && best[kind].value >= value)) return;
    best[kind] = { kind, value, at, session: s, name, facts, entryId };
  };
  let firstDay = null;
  for (const [name, s] of sessions) {
    const project = projectOf(s.cwd, home);
    const meta = { title: s.title, project: project.name };
    const projectRow = projects.get(project.path) ?? { name: project.name, sessions: 0, turns: 0, tokens: 0, models: new Map() };
    let touched = false;
    if (s.start >= fromMs) {
      out.sessions += 1;
      projectRow.sessions += 1;
      touched = true;
      if (s.turns.length > 0 && (!longest || s.turns.length > longest.turns)) {
        longest = { turns: s.turns.length, seconds: Math.round((s.end - s.start) / 1000), at: new Date(s.start).toISOString(), ...meta };
      }
      teams += s.teams.length;
    }
    s.turns.forEach((at, index) => {
      if (at < fromMs) return;
      const day = dayKey(at);
      firstDay = firstDay === null || day < firstDay ? day : firstDay;
      out.turns += 1;
      projectRow.turns += 1;
      touched = true;
      daily.set(day, (daily.get(day) ?? 0) + 1);
      const d = new Date(at);
      out.heat[(d.getDay() + 6) % 7][d.getHours()] += 1;
      const level = s.levels[index];
      if (level) out.levels[level] = (out.levels[level] ?? 0) + 1;
    });
    for (const [key, [calls, input, cacheRead, cacheWrite, output]] of Object.entries(s.usage)) {
      const [day, model] = [key.slice(0, 10), key.slice(11)];
      if (!inDay(day)) continue;
      out.calls += calls;
      out.tokens.input += input;
      out.tokens.cacheRead += cacheRead;
      out.tokens.cacheWrite += cacheWrite;
      out.tokens.output += output;
      const row = models.get(model) ?? { model, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      row.calls += calls;
      row.input += input;
      row.cacheRead += cacheRead;
      row.cacheWrite += cacheWrite;
      row.output += output;
      models.set(model, row);
      const total = input + cacheRead + cacheWrite + output;
      projectRow.tokens += total;
      projectRow.models.set(model, (projectRow.models.get(model) ?? 0) + total);
      touched = true;
    }
    for (const [at, model] of s.agents) {
      if (at < fromMs) continue;
      agents += 1;
      agentModels.set(model, (agentModels.get(model) ?? 0) + 1);
    }
    for (const [day, [calls, seconds, at]] of Object.entries(s.runs)) {
      if (!inDay(day)) continue;
      if (!run || calls > run.calls) run = { calls, seconds, at: new Date(at).toISOString(), ...meta };
      offer('solo', calls, at, s, name, { calls, seconds });
    }
    for (const [day, [hesitations, chars, model, at, entryId]] of Object.entries(s.minds ?? {})) {
      if (inDay(day)) offer('mind', hesitations, at, s, name, { hesitations, chars, model }, entryId);
    }
    for (const [day, [usd, at, seconds, message]] of Object.entries(s.costs ?? {})) {
      if (inDay(day)) offer('cost', usd, at, s, name, { usd, seconds, message });
    }
    for (const [day, [failures, start, end, error]] of Object.entries(s.outages ?? {})) {
      if (inDay(day)) offer('outage', failures, start, s, name, { failures, seconds: Math.round((end - start) / 1000), error });
    }
    const delegated = s.agents.filter(([at]) => at >= fromMs);
    if (delegated.length) offer('swarm', delegated.length, delegated[0][0], s, name, { agents: delegated.length, teams: s.teams.filter((at) => at >= fromMs).length });
    const nights = new Map();
    for (const at of s.turns) {
      if (at < fromMs || new Date(at).getHours() >= 6) continue;
      const night = dayKey(at);
      const held = nights.get(night) ?? { messages: 0, at };
      held.messages += 1;
      nights.set(night, held);
    }
    for (const [night, { messages, at }] of nights) offer('night', messages, at, s, name, { messages, night });
    if (touched) projects.set(project.path, projectRow);
  }

  const firstWork = sessions.reduce((first, [, s]) => {
    const at = s.work?.[0]?.[0];
    return at !== undefined && at >= fromMs && (first === null || at < first) ? at : first;
  }, null);
  const start = from ?? [firstDay, firstWork === null ? null : dayKey(firstWork)].filter(Boolean).toSorted()[0] ?? today;
  const periodDays = daysBetween(start, today);
  out.daily = periodDays.map((day) => [day, daily.get(day) ?? 0]);
  out.work = workTime(sessions, fromMs, now, periodDays);
  out.hourly = out.heat[0].map((_, hour) => out.heat.reduce((sum, row) => sum + row[hour], 0));
  out.nightShare = out.turns ? out.hourly.slice(0, 6).reduce((a, b) => a + b, 0) / out.turns : 0;
  const busiest = [...daily.entries()].reduce((best, entry) => (!best || entry[1] > best[1] ? entry : best), null);
  out.busiest = busiest ? { day: busiest[0], turns: busiest[1] } : null;
  out.bestStreak = longestRun([...daily.keys()].toSorted());
  const tokensOf = (row) => row.input + row.cacheRead + row.cacheWrite + row.output;
  out.models = topBy(models, TOP_MODELS, tokensOf).map(([, row]) => row);
  out.projects = topBy(projects, TOP_PROJECTS, (row) => row.turns)
    .filter(([, row]) => row.turns > 0)
    .map(([key, row]) => ({
      path: key,
      name: row.name,
      sessions: row.sessions,
      turns: row.turns,
      tokens: row.tokens,
      topModel: topBy(row.models, 1, (value) => value)[0]?.[0] ?? null,
    }));
  out.delegation = {
    agents,
    teams,
    models: topBy(agentModels, 5, (count) => count).map(([model, count]) => ({ model, count })),
  };
  const ratios = new Map();
  for (const [day, model, ratio] of speed) {
    if (!inDay(day)) continue;
    const list = ratios.get(model) ?? [];
    list.push(ratio);
    ratios.set(model, list);
  }
  out.speed = [...ratios.entries()]
    .filter(([, list]) => list.length >= MIN_SPEED_SAMPLES)
    .map(([model, list]) => ({ model, score: scoreFromRatios(list), samples: list.length }))
    .toSorted((a, b) => b.samples - a.samples)
    .slice(0, TOP_MODELS);
  const first = firstTurn(sessions);
  if (first && first.at >= fromMs) {
    best.first = { kind: 'first', value: daysBetween(dayKey(first.at), today).length, at: first.at, session: first.session, name: first.name, facts: { message: first.session.firstText } };
  }
  out.run = run;
  out.longestSession = longest;
  out.episodes = episodes(best, home, language);
  return out;
}

/**
 * @param {Record<string, object>} summaries  file name → summarizeSession() result
 * @param {Array<[string, string, number]>} speed  summarizeSpeedSamples() rows
 * @param {{ now: number, home: string }} context
 */
export function aggregateStats(summaries, speed, { now, home }) {
  const sessions = Object.entries(summaries).filter(([, s]) => s && !isScratchFolder(s.cwd));
  const attendance = {};
  for (const [, s] of sessions) for (const at of s.turns) {
    const day = dayKey(at);
    attendance[day] = (attendance[day] ?? 0) + 1;
  }
  const activeDays = Object.keys(attendance).toSorted();
  const today = dayKey(now);
  let currentStreak = 0;
  let cursor = attendance[today] ? now : addDays(now, -1);
  while (attendance[dayKey(cursor)]) { currentStreak += 1; cursor = addDays(cursor, -1); }
  const periods = {};
  const language = writingLanguage(sessions);
  for (const [name, days] of Object.entries(PERIODS)) periods[name] = aggregatePeriod(sessions, speed, { days, now, home, language });
  return {
    generatedAt: new Date(now).toISOString(),
    today,
    firstDay: activeDays[0] ?? null,
    activeDays: activeDays.length,
    currentStreak,
    bestStreak: longestRun(activeDays),
    attendance,
    periods,
  };
}
