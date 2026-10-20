// Schedule nudges for the user's own time: Roo's career-schedule.py, ported and made general.
//
// Segno reads the schedule sources set in its settings (settings.json `schedule.sources`, set by
// talking to Segno) where they are, on every heartbeat tick, and never copies them:
//
//   { kind: 'ics', location: 'https://…' | 'webcal://…' | '/path/to/calendar.ics' }
//       a calendar's ICS address (Google, iCloud and most calendars give one) or an .ics file
//   { kind: 'markdown', location: '~/path/to/schedule.md' }
//       a schedule file in the format below
//
// The markdown format — one heading per day, one item per line, a time when the item has one:
//
//   ## 2026-10-21
//   - 14:00 Interview at the studio
//   - 23:59 Report due
//   - Pick up the parcel            (no time: all day)
//
// A day heading is `## YYYY-MM-DD` (anything after the date is ignored); an item is `- HH:MM text`
// or `- text`. Everything else in the file is ignored. Older generated files that head their days
// `## 10/21(수)` with a `YYYY-MM-DD HH:MM 기준` stamp, and mark untimed items `시각 없음`, are read
// too, as a compatibility reading.
//
// On a tick the keeper adds a line when there is a reason to nudge:
//
//   SCHEDULE_DUE   a timed item entered its 3-hours or 1-hour window, once per window
//   SCHEDULE_NIGHT between 22:00 and 23:59, once a day, when tomorrow has items: time to hand over
//                  tomorrow's list
//   SCHEDULE_WARN  a source cannot be read, once a day per source: the nudging has stopped for it
//
// What to say, and whether to, is Segno's. This module sends nothing.
//
// This file is staged beside home.mjs into the runtime build (pi-runtime/features/companion-home),
// so './home.mjs' is the only local import it may have.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { segnoPaths } from './home.mjs';

/** Narrowest first: an item 50 minutes away is in its 1-hour window. */
export const SCHEDULE_WINDOWS = Object.freeze([Object.freeze({ name: '1h', ms: 60 * 60_000, label: '1시간 전' }),
  Object.freeze({ name: '3h', ms: 3 * 60 * 60_000, label: '3시간 전' })]);
export const SCHEDULE_NIGHT_HOURS = Object.freeze([22, 23]);
export const SCHEDULE_SOURCE_LIMIT = 10;
const DAY_MS = 24 * 60 * 60_000;
/** How long a fetched calendar is reused before it is fetched again. */
const ICS_CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const expandHome = (raw, env) => (raw === '~' || raw.startsWith('~/') ? path.join(env.HOME || homedir(), raw.slice(1)) : raw);

/** One source as stored, or undefined when it cannot be one: `{ kind, location, name? }`. */
export function normalizeSource(value) {
  const input = typeof value === 'string' ? { location: value } : value;
  if (!input || typeof input !== 'object') return undefined;
  const location = typeof input.location === 'string' ? input.location.trim() : '';
  if (!location || location.length > 2048) return undefined;
  const inferred = /^(https?|webcal):\/\//i.test(location) || /\.ics$/i.test(location) ? 'ics' : 'markdown';
  const kind = input.kind === 'ics' || input.kind === 'markdown' ? input.kind : inferred;
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : undefined;
  return { kind, location, ...(name ? { name } : {}) };
}

/** The sources in settings.json, normalized; an older `career.schedule` path reads as one markdown source. */
export function scheduleSources(env = process.env) {
  let settings;
  try { settings = JSON.parse(readFileSync(path.join(segnoPaths(env).home, 'settings.json'), 'utf8')); } catch { return []; }
  const listed = Array.isArray(settings?.schedule?.sources) ? settings.schedule.sources
    : typeof settings?.career?.schedule === 'string' && settings.career.schedule.trim() ? [{ kind: 'markdown', location: settings.career.schedule }] : [];
  const seen = new Set();
  return listed.map(normalizeSource).filter((source) => source && !seen.has(source.location) && seen.add(source.location))
    .slice(0, SCHEDULE_SOURCE_LIMIT);
}

const sourceLabel = (source) => source.name ?? (source.kind === 'ics' && /^[a-z]+:\/\//i.test(source.location)
  ? new URL(source.location.replace(/^webcal:/i, 'https:')).hostname : path.basename(source.location));

// ── markdown ──────────────────────────────────────────────────────────────────────────────────
const ISO_HEAD = /^## (\d{4})-(\d{2})-(\d{2})\b/;
const COMPAT_HEAD = /^## (?:오늘 |내일 )?(\d{1,2})\/(\d{1,2})\(/;
const COMPAT_STAMP = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) 기준/;
const ITEM = /^- (?:(\d{1,2}):(\d{2})\s+|시각 없음\s+)?(.*\S)\s*$/;

/**
 * Items of a markdown schedule, `{ date: YYYY-MM-DD, time?: 'HH:MM', at?: epoch ms, text }`. Day
 * headings are ISO dates; the compatibility reading takes `## M/D(…)` headings against the file's
 * `기준` stamp (a month more than sixty days before it is next year's). Tables and other lines are
 * ignored, and so is a `# ` section heading's content until the next day heading.
 */
export function parseMarkdownSchedule(text, now = Date.now()) {
  const stamp = COMPAT_STAMP.exec(text);
  const base = stamp ? new Date(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3])) : new Date(now);
  base.setHours(0, 0, 0, 0);
  const items = [];
  let day;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('## ')) {
      const iso = ISO_HEAD.exec(line);
      const compat = iso ? undefined : COMPAT_HEAD.exec(line);
      day = undefined;
      if (iso) day = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      else if (compat) {
        day = new Date(base.getFullYear(), Number(compat[1]) - 1, Number(compat[2]));
        if (day.getTime() < base.getTime() - 60 * DAY_MS) day = new Date(base.getFullYear() + 1, Number(compat[1]) - 1, Number(compat[2]));
      }
      continue;
    }
    if (line.startsWith('# ')) { day = undefined; continue; }
    if (!day || !line.startsWith('- ')) continue;
    const item = ITEM.exec(line);
    if (!item) continue;
    const timed = item[1] !== undefined && Number(item[1]) < 24 && Number(item[2]) < 60;
    const at = timed ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(item[1]), Number(item[2])).getTime() : undefined;
    items.push({ date: dayKey(day), ...(timed ? { time: `${pad(Number(item[1]))}:${item[2]}`, at } : {}), text: item[3].replace(/\s+·\s+.*$/, '').trim() || item[3] });
  }
  return items;
}

// ── ICS ───────────────────────────────────────────────────────────────────────────────────────
// A time in a calendar is wall-clock fields in one frame: UTC (…Z), a named zone (TZID), or
// floating (this machine's clock; all-day dates too). Repetitions step those fields in the event's
// own frame — a weekly 09:00 in New York stays 09:00 there across daylight saving, wherever this
// machine is — and become an instant only at the end.

/** The instant a wall-clock time in `timeZone` names (two passes over the zone's offset). */
function zonedTime(year, month, day, hour, minute, second, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - instant;
  };
  let instant = guess - offsetAt(guess);
  instant = guess - offsetAt(instant);
  return instant;
}

/** An ICS date or date-time value as `{ fields: [y, mo, d, h, mi, s], frame, allDay }`; frame is 'utc', a zone name or 'local'. */
function icsValue(value, params = {}) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, sec, z] = match;
  const allDay = h === undefined || params.VALUE === 'DATE';
  const fields = [Number(y), Number(mo), Number(d), allDay ? 0 : Number(h), allDay ? 0 : Number(mi), allDay ? 0 : Number(sec)];
  let frame = 'local';
  if (!allDay && z) frame = 'utc';
  else if (!allDay && params.TZID) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: params.TZID }); frame = params.TZID; } catch { frame = 'local'; }
  }
  return { fields, frame, allDay };
}

/** The instant of wall-clock `fields` in `frame`. */
function instantOf(fields, frame) {
  const [y, mo, d, h, mi, s] = fields;
  if (frame === 'utc') return Date.UTC(y, mo - 1, d, h, mi, s);
  if (frame === 'local') return new Date(y, mo - 1, d, h, mi, s).getTime();
  return zonedTime(y, mo, d, h, mi, s, frame);
}

/** Calendar arithmetic on wall-clock fields, free of any zone: Date.UTC only normalizes. */
const fieldsOf = (ms, time) => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), time[3], time[4], time[5]]; };
const addDays = (fields, k) => fieldsOf(Date.UTC(fields[0], fields[1] - 1, fields[2] + k), fields);
const weekdayOf = (fields) => new Date(Date.UTC(fields[0], fields[1] - 1, fields[2])).getUTCDay();
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function property(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return undefined;
  const [name, ...rest] = line.slice(0, colon).split(';');
  const params = Object.fromEntries(rest.map((part) => { const eq = part.indexOf('='); return [part.slice(0, eq).toUpperCase(), part.slice(eq + 1).replace(/^"|"$/g, '')]; }));
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const icsText = (value) => String(value).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * The start instants of one event's occurrences up to `to`: its start, and for RRULE FREQ=DAILY,
 * WEEKLY (BYDAY), MONTHLY or YEARLY with INTERVAL, COUNT and UNTIL, each repetition stepped in the
 * event's own frame. A monthly or yearly date the month does not have (the 31st, Feb 29) is
 * skipped, as RFC 5545 says, and does not count. EXDATE instants are left out but still count.
 */
function occurrences(event, to) {
  const { fields: first, frame } = event.start;
  const startAt = instantOf(first, frame);
  if (!event.rrule) return [startAt];
  const rule = Object.fromEntries(event.rrule.split(';').map((part) => part.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = Number(rule.COUNT) || Infinity;
  const untilValue = rule.UNTIL ? icsValue(rule.UNTIL) : undefined;
  const until = untilValue ? instantOf(untilValue.fields, untilValue.frame === 'local' ? frame : untilValue.frame) : Infinity;
  const days = rule.FREQ === 'WEEKLY' && rule.BYDAY ? rule.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0).sort() : undefined;
  const out = [];
  let n = 0;
  for (let period = 0; period < 10000; period += 1) {
    let candidates;
    const k = period * interval;
    if (rule.FREQ === 'DAILY') candidates = [addDays(first, k)];
    else if (rule.FREQ === 'WEEKLY') {
      const week = addDays(first, 7 * k);
      candidates = days ? days.map((weekday) => addDays(week, weekday - weekdayOf(week))) : [week];
    } else if (rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY') {
      const monthIndex = (first[1] - 1) + (rule.FREQ === 'MONTHLY' ? k : 12 * k);
      const year = first[0] + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      candidates = first[2] <= daysIn(year, month) ? [[year, month, first[2], first[3], first[4], first[5]]] : [];
    } else return [startAt];
    for (const fields of candidates) {
      const at = instantOf(fields, frame);
      if (at < startAt) continue;
      if (at > until || n >= count || at > to) return out;
      n += 1;
      if (!event.exdates.has(at)) out.push(at);
    }
  }
  return out;
}

/**
 * Items of an ICS calendar between `from` and `to`, as parseMarkdownSchedule gives them. An event
 * that repeats is expanded; an occurrence moved or cancelled by an override (same UID with a
 * RECURRENCE-ID) is replaced by that override, which stands as its own event, or dropped.
 */
export function parseIcs(text, { from, to }) {
  const events = [];
  let current;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { current = { exdates: new Set() }; continue; }
    if (line === 'END:VEVENT') { if (current?.start) events.push(current); current = undefined; continue; }
    if (!current) continue;
    const prop = property(line);
    if (!prop) continue;
    if (prop.name === 'DTSTART') current.start = icsValue(prop.value, prop.params);
    else if (prop.name === 'SUMMARY') current.summary = icsText(prop.value);
    else if (prop.name === 'UID') current.uid = prop.value.trim();
    else if (prop.name === 'RRULE') current.rrule = prop.value;
    else if (prop.name === 'STATUS') current.status = prop.value.trim().toUpperCase();
    else if (prop.name === 'RECURRENCE-ID') current.recurrenceId = icsValue(prop.value, prop.params);
    else if (prop.name === 'EXDATE') {
      for (const value of prop.value.split(',')) { const v = icsValue(value, prop.params); if (v) current.exdates.add(v); }
    }
  }
  // EXDATE values are fields in their own frame; compare them as instants.
  for (const event of events) {
    event.exdates = new Set([...event.exdates].map((v) => instantOf(v.fields, v.frame === 'local' && event.start ? event.start.frame : v.frame)));
  }
  const overridden = new Map();
  for (const event of events) {
    if (!event.recurrenceId || !event.uid) continue;
    const master = events.find((other) => other.uid === event.uid && !other.recurrenceId);
    const frame = event.recurrenceId.frame === 'local' && master ? master.start.frame : event.recurrenceId.frame;
    if (!overridden.has(event.uid)) overridden.set(event.uid, new Set());
    overridden.get(event.uid).add(instantOf(event.recurrenceId.fields, frame));
  }
  const items = [];
  for (const event of events) {
    if (event.status === 'CANCELLED') continue;
    const replaced = !event.recurrenceId && event.uid ? overridden.get(event.uid) : undefined;
    for (const at of occurrences(event, to)) {
      if (at < from - DAY_MS || replaced?.has(at)) continue;
      const date = new Date(at);
      if (event.start.allDay) {
        // An all-day date is a day, not an instant: keep its own calendar date.
        const day = event.rrule ? fieldsOf(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()), [0, 0, 0, 0, 0, 0]) : event.start.fields;
        items.push({ date: `${day[0]}-${pad(day[1])}-${pad(day[2])}`, text: event.summary || '(제목 없음)' });
      } else {
        items.push({ date: dayKey(date), time: `${pad(date.getHours())}:${pad(date.getMinutes())}`, at, text: event.summary || '(제목 없음)' });
      }
    }
  }
  return items;
}

// ── reading the sources ───────────────────────────────────────────────────────────────────────
const icsCache = new Map();

async function readSource(source, { now, env, fetchImpl, readFile }) {
  const from = now - DAY_MS;
  const to = now + 2 * DAY_MS;
  if (source.kind === 'markdown') {
    return parseMarkdownSchedule(readFile(path.resolve(expandHome(source.location, env))), now)
      .filter((item) => { const day = new Date(`${item.date}T00:00:00`).getTime(); return day >= from - DAY_MS && day <= to; });
  }
  let text;
  if (/^(https?|webcal):\/\//i.test(source.location)) {
    const url = source.location.replace(/^webcal:/i, 'https:');
    const cached = icsCache.get(url);
    if (cached && now - cached.at < ICS_CACHE_MS && cached.at <= now) text = cached.text;
    else {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: `HTTP ${response.status}` });
      text = await response.text();
      if (!/BEGIN:VCALENDAR/.test(text)) throw Object.assign(new Error('not a calendar'), { code: 'not a calendar' });
      icsCache.set(url, { at: now, text });
    }
  } else {
    text = readFile(path.resolve(expandHome(source.location, env)));
    if (!/BEGIN:VCALENDAR/.test(text)) throw Object.assign(new Error('not a calendar'), { code: 'not a calendar' });
  }
  return parseIcs(text, { from, to });
}

/**
 * Every item of every source near `now`, and the sources that could not be read:
 * `{ items: [{ date, time?, at?, text, source }], failed: [{ source, error }] }`.
 */
export async function readSchedule({ sources, now = Date.now(), env = process.env, fetchImpl = globalThis.fetch,
  readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const list = sources ? sources.map(normalizeSource).filter(Boolean) : scheduleSources(env);
  const items = [];
  const failed = [];
  for (const source of list) {
    try { for (const item of await readSource(source, { now, env, fetchImpl, readFile })) items.push({ ...item, source: sourceLabel(source) }); }
    catch (error) { failed.push({ source, error: error?.code ?? error?.message ?? String(error) }); }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.text.localeCompare(b.text));
  return { items, failed };
}

function leftLabel(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}

const stateFile = (env) => path.join(segnoPaths(env).home, 'schedule-nudges.json');
function readNudgeState(env) {
  for (const file of [stateFile(env), path.join(segnoPaths(env).home, 'career-nudges.json')]) {
    try { const value = JSON.parse(readFileSync(file, 'utf8')); if (value && typeof value === 'object') return value; } catch {}
  }
  return {};
}
function writeNudgeState(env, value) {
  const file = stateFile(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 1) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * The SCHEDULE_ lines for a tick at `now`, each window, night and warning recorded so it does not
 * come again (schedule-nudges.json in the home). No source set → nothing at all. The lines end with
 * Roo's closing line saying the nudge is Segno's to voice.
 */
export async function scheduleNudges({ sources, now = Date.now(), env = process.env, fetchImpl = globalThis.fetch,
  readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const list = sources ? sources.map(normalizeSource).filter(Boolean) : scheduleSources(env);
  if (!list.length) return [];
  const state = readNudgeState(env);
  const fired = state.fired && typeof state.fired === 'object' ? state.fired : {};
  const warned = state.warned && typeof state.warned === 'object' ? state.warned : {};
  const today = dayKey(new Date(now));
  const out = [];
  const { items, failed } = await readSchedule({ sources: list, now, env, fetchImpl, readFile });
  for (const { source, error } of failed) {
    if (warned[source.location] === today) continue;
    warned[source.location] = today;
    out.push(`SCHEDULE_WARN 일정 출처를 못 읽어서 그 일정은 챙기지 못하고 있어: ${sourceLabel(source)} (${error})`);
  }
  for (const item of items) {
    if (item.at === undefined) continue;
    const left = item.at - now;
    if (left <= 0) continue;
    const window = SCHEDULE_WINDOWS.find((candidate) => left <= candidate.ms);
    if (!window) continue;
    const key = `${item.date} ${item.time} ${item.text}|${window.name}`;
    if (key in fired) continue;
    fired[key] = new Date(item.at).toISOString();
    const date = new Date(item.at);
    out.push(`SCHEDULE_DUE ${window.label}: ${date.getMonth() + 1}/${date.getDate()} ${item.time} ${item.text} (${leftLabel(left)} 남음, ${item.source})`);
  }
  const hour = new Date(now).getHours();
  if (SCHEDULE_NIGHT_HOURS.includes(hour) && state.night !== today) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const ahead = items.filter((item) => item.date === dayKey(tomorrow));
    if (ahead.length) {
      state.night = today;
      const timed = ahead.filter((item) => item.time).length;
      out.push(`SCHEDULE_NIGHT 내일 ${tomorrow.getMonth() + 1}/${tomorrow.getDate()} 목록 건넬 때야 (시각 있는 것 ${timed} · 종일 ${ahead.length - timed}): ` +
        'schedule 도구로 tomorrow');
    }
  }
  const cutoff = now - 2 * DAY_MS;
  writeNudgeState(env, { ...state, warned, fired: Object.fromEntries(Object.entries(fired).filter(([, value]) => Date.parse(value) > cutoff)) });
  if (out.length) out.push('SCHEDULE 줄은 사용자 일정 찌름 신호야. 말할지·어떻게 말할지는 내가 정해 (하트비트 "사용자 챙기기").');
  return out;
}

/** Roo's `show`: today's and/or tomorrow's items by the real date, across every source. */
export async function showSchedule(which = 'both', options = {}) {
  const list = options.sources ? options.sources.map(normalizeSource).filter(Boolean) : scheduleSources(options.env ?? process.env);
  if (!list.length) return '일정 출처가 아직 없어. 사용자가 달력 ICS 주소나 일정 파일을 알려 주면 설정에 걸어.';
  const now = options.now ?? Date.now();
  const { items, failed } = await readSchedule({ ...options, sources: list, now });
  const out = [`출처: ${list.map(sourceLabel).join(', ')}`];
  for (const { source, error } of failed) out.push(`못 읽음: ${sourceLabel(source)} (${error})`);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekday = (date) => new Intl.DateTimeFormat('ko-KR', { weekday: 'short' }).format(date);
  const picks = { today: [['오늘', today]], tomorrow: [['내일', tomorrow]] };
  picks.both = [...picks.today, ...picks.tomorrow];
  for (const [label, date] of picks[which] ?? picks.both) {
    const day = items.filter((item) => item.date === dayKey(date));
    out.push('', `## ${label} ${date.getMonth() + 1}/${date.getDate()}(${weekday(date)})`);
    out.push(...(day.length ? day.map((item) => `- ${item.time ?? '종일'} ${item.text}${list.length > 1 ? ` · ${item.source}` : ''}`) : ['(잡힌 것 없음)']));
  }
  return out.join('\n');
}
