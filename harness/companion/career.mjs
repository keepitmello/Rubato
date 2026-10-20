// Deadline nudges from the user's schedule: Roo's career-schedule.py, ported.
//
// The schedule is the user's own file (Settings › Companion; for the person this was built for,
// ~/Github-repos/writing-workbench/career-tracker/일정표.md), read where it is on every tick and never
// copied. Its generator lists only what has not been handed in yet, so "still in the schedule"
// means "not done yet". On a heartbeat tick the keeper adds a line when there is a reason to nudge:
//
//   CAREER_DUE   a timed deadline (마감) entered its 3-hours or 1-hour window and is still listed,
//                once per window
//   CAREER_NIGHT between 22:00 and 23:59, once a day, when tomorrow has items: time to hand over
//                tomorrow's list
//   CAREER_WARN  the schedule cannot be read, once a day: the nudging has stopped
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

/** Narrowest first: a deadline 50 minutes away is in its 1-hour window. */
export const CAREER_WINDOWS = Object.freeze([Object.freeze({ name: '1h', ms: 60 * 60_000, label: '1시간 전' }),
  Object.freeze({ name: '3h', ms: 3 * 60 * 60_000, label: '3시간 전' })]);
export const CAREER_NIGHT_HOURS = Object.freeze([22, 23]);
/** A schedule generated longer ago than this may list something already handed in. */
const STALE_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const STAMP = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) 기준/;
const HEAD = /^## (?:오늘 |내일 )?(\d{1,2})\/(\d{1,2})\(/;
const ITEM = /^- (\d{2}:\d{2}|시각 없음)\s+(.*)$/;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The schedule path from Settings › Companion (settings.json `career.schedule`), with ~ expanded; '' when unset. */
export function careerSchedulePath(env = process.env) {
  let value;
  try { value = JSON.parse(readFileSync(path.join(segnoPaths(env).home, 'settings.json'), 'utf8'))?.career?.schedule; } catch {}
  if (typeof value !== 'string' || !value.trim()) return '';
  const raw = value.trim();
  return raw === '~' || raw.startsWith('~/') ? path.join(env.HOME || homedir(), raw.slice(1)) : path.resolve(raw);
}

/**
 * `{ stamp, days }`: when the schedule was generated (or undefined) and each dated section's
 * heading and item lines, keyed YYYY-MM-DD. Tables and undated sections are skipped. A month that
 * lies more than sixty days before the stamp belongs to next year (a December schedule's January).
 */
export function parseSchedule(text, now = Date.now()) {
  const found = STAMP.exec(text);
  const stamp = found ? new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]), Number(found[4]), Number(found[5])).getTime() : undefined;
  const base = new Date(stamp ?? now);
  base.setHours(0, 0, 0, 0);
  const days = new Map();
  let current;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const head = HEAD.exec(line);
      current = undefined;
      if (head) {
        let date = new Date(base.getFullYear(), Number(head[1]) - 1, Number(head[2]));
        if (date.getTime() < base.getTime() - 60 * DAY_MS) date = new Date(base.getFullYear() + 1, Number(head[1]) - 1, Number(head[2]));
        current = dayKey(date);
        days.set(current, { title: line.slice(3).trim(), lines: [], date });
      }
      continue;
    }
    if (line.startsWith('# ')) { current = undefined; continue; }
    if (current && line.startsWith('- ')) days.get(current).lines.push(line);
  }
  return { stamp, days };
}

function staleNote(stamp, now) {
  if (stamp === undefined) return '일정표 기준 시각을 못 찾음';
  return now - stamp > STALE_MS ? `일정표가 ${Math.floor((now - stamp) / 3_600_000)}시간 전에 뽑힌 거라 그새 냈을 수도 있음` : '';
}

function leftLabel(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}

const stateFile = (env) => path.join(segnoPaths(env).home, 'career-nudges.json');
function readNudgeState(env) {
  try { const value = JSON.parse(readFileSync(stateFile(env), 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function writeNudgeState(env, value) {
  const file = stateFile(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 1) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * The CAREER_ lines for a tick at `now`, each window or night recorded so it does not come again
 * (career-nudges.json in the home). No schedule set → nothing at all. Lines end with Roo's closing
 * line saying the nudge is Segno's to voice.
 */
export function careerNudges({ schedule = undefined, now = Date.now(), env = process.env, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const file = schedule ?? careerSchedulePath(env);
  if (!file) return [];
  const state = readNudgeState(env);
  const fired = state.fired && typeof state.fired === 'object' ? state.fired : {};
  const today = dayKey(new Date(now));
  const out = [];
  let parsed = { stamp: undefined, days: new Map() };
  try { parsed = parseSchedule(readFile(file), now); }
  catch (error) {
    if (state.warned !== today) {
      out.push(`CAREER_WARN 일정표를 못 읽어서 마감 찌르기를 못 하고 있어: ${file} (${error?.code ?? error?.message ?? error})`);
      state.warned = today;
    }
  }
  const note = parsed.days.size ? staleNote(parsed.stamp, now) : '';
  for (const [, { lines, date }] of [...parsed.days].sort(([a], [b]) => a.localeCompare(b))) {
    for (const line of lines) {
      const item = ITEM.exec(line);
      if (!item || item[1] === '시각 없음') continue;
      const what = item[2].split(' · ')[0].trim();
      if (!what.includes('마감')) continue;
      const [hour, minute] = item[1].split(':').map(Number);
      const due = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime();
      const left = due - now;
      if (left <= 0) continue;
      const window = CAREER_WINDOWS.find((candidate) => left <= candidate.ms);
      if (!window) continue;
      const key = `${dayKey(new Date(due))} ${item[1]} ${what}|${window.name}`;
      if (key in fired) continue;
      fired[key] = new Date(due).toISOString();
      out.push(`CAREER_DUE ${window.label}: ${date.getMonth() + 1}/${date.getDate()} ${item[1]} ${what} ` +
        `(${leftLabel(left)} 남음, 일정표에 아직 있음${note ? ` · ${note}` : ''})`);
    }
  }
  const hour = new Date(now).getHours();
  if (CAREER_NIGHT_HOURS.includes(hour) && state.night !== today) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const lines = parsed.days.get(dayKey(tomorrow))?.lines ?? [];
    if (lines.length) {
      state.night = today;
      const head = (line) => line.split(' · ')[0];
      const due = lines.filter((line) => head(line).includes('마감') && !line.includes('내기:') && !line.includes('쓰기:')).length;
      const submit = lines.filter((line) => line.includes('내기:')).length;
      const write = lines.filter((line) => line.includes('쓰기:')).length;
      out.push(`CAREER_NIGHT 내일 ${tomorrow.getMonth() + 1}/${tomorrow.getDate()} 목록 건넬 때야 (마감 ${due} · 낼 것 ${submit} · 쓸 것 ${write}): ` +
        'career_schedule 도구로 tomorrow');
    }
  }
  const cutoff = now - 2 * DAY_MS;
  state.fired = Object.fromEntries(Object.entries(fired).filter(([, value]) => Date.parse(value) > cutoff));
  writeNudgeState(env, state);
  if (out.length) out.push('CAREER 줄은 사용자 일정 찌름 신호야. 말할지·어떻게 말할지는 내가 정해 (하트비트 "사용자 챙기기").');
  return out;
}

/** Roo's `show`: today's and/or tomorrow's sections by the real date, with the source and its age. */
export function showSchedule(which = 'both', { schedule = undefined, now = Date.now(), env = process.env, readFile = (file) => readFileSync(file, 'utf8') } = {}) {
  const file = schedule ?? careerSchedulePath(env);
  if (!file) return '일정표가 설정돼 있지 않아 (설정 › 컴패니언 › 일정표).';
  let parsed;
  try { parsed = parseSchedule(readFile(file), now); }
  catch (error) { return `일정표를 못 읽음: ${file} (${error?.code ?? error?.message ?? error})`; }
  const out = [`원본: ${file}`];
  const stamp = parsed.stamp === undefined ? undefined : new Date(parsed.stamp);
  out.push(stamp ? `${dayKey(stamp)} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())} 기준` : '기준 시각 없음');
  const note = staleNote(parsed.stamp, now);
  if (note) out.push(`주의: ${note}`);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const picks = { today: [['오늘', today]], tomorrow: [['내일', tomorrow]] };
  picks.both = [...picks.today, ...picks.tomorrow];
  for (const [label, date] of picks[which] ?? picks.both) {
    out.push('');
    const day = parsed.days.get(dayKey(date));
    if (day) {
      out.push(`## ${label} ${day.title.replace(/^(오늘|내일) /, '')}`);
      out.push(day.lines.length ? day.lines.join('\n') : '(항목 없음)');
    } else {
      out.push(`## ${label} ${date.getMonth() + 1}/${date.getDate()}`, '(잡힌 것 없음)');
    }
  }
  return out.join('\n');
}
