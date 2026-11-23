// 받아쓰기가 사람마다 잘 받아쓰게 하는 두 가지. 둘 다 이 맥의 공용 사용자 기억 옆에 있다
// (packages/rubato-runtime src/user-memory; 기억 뿌리는 RUBATO_MEMORY_HOME, 없으면 ~/.rubato/memory).
//
// - 용어: 사용자 기억 정리 꿈이 관리하는 `agents/user.shared/repo/vocabulary/dictation-terms.md`
//   의 목록. 이 사람이 말하는 이름과 용어다. 1회용 열쇠를 만들 때마다 읽어 기본 힌트에 더한다.
//   파일이 없으면(기억이나 꿈을 안 쓰는 사람) 기본 힌트만 간다.
// - 고친 기록: 받아쓴 글과 그 사람이 보낸 글을 견줘 바뀐 낱말 쌍만 `agents/user.shared/runtime/
//   dictation-corrections.jsonl` 에 남긴다. 꿈이 그 중 이름과 용어를 위 목록에 올린다. 이 맥 밖으로
//   나가지 않는다.
// - 최근 용어: 꿈을 기다리지 않는 길. 고친 쌍을 남기는 그 자리에서 작은 모델이 이름·용어로 본 것을
//   `agents/user.shared/runtime/dictation-recent-terms.json` 에 두고 다음 받아쓰기부터 힌트 맨 앞에
//   싣는다(term-classifier.mjs). 꿈은 같은 고친 기록을 읽어 본 목록에 합치므로, 최근 용어는
//   RECENT_TERM_DAYS 가 지나면 빠진다.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 힌트로 보낼 용어의 상한. 너무 많으면 비슷한 소리를 그 낱말로 끌어당긴다. */
export const DICTATION_TERMS_MAX = 80;
/** 고친 기록 파일이 이 줄 수를 넘으면 오래된 쪽을 덜어 낸다. */
const CORRECTIONS_MAX_LINES = 2000;
/** 최근 용어가 힌트에 머무는 날수. 사용자 꿈이 하루 한 번 같은 고친 기록을 본 목록에 합친다. */
export const RECENT_TERM_DAYS = 3;
const RECENT_TERMS_MAX = 40;
/** 바뀐 토막이 이보다 길면 고친 낱말이 아니라 다시 쓴 문장이다. */
const CORRECTION_MAX_WORDS = 4;

export function memoryRoot(env = process.env) {
  const override = env.RUBATO_MEMORY_HOME;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  return path.join(env.HOME ?? homedir(), '.rubato', 'memory');
}

export function dictationTermsPath(env = process.env) {
  return path.join(memoryRoot(env), 'agents', 'user.shared', 'repo', 'vocabulary', 'dictation-terms.md');
}

export function recentTermsPath(env = process.env) {
  return path.join(memoryRoot(env), 'agents', 'user.shared', 'runtime', 'dictation-recent-terms.json');
}

function readRecent(env) {
  try {
    const terms = JSON.parse(readFileSync(recentTermsPath(env), 'utf8'))?.terms;
    return Array.isArray(terms) ? terms.filter((entry) => typeof entry?.term === 'string' && typeof entry?.at === 'string') : [];
  } catch { return []; }
}

/** 최근 용어 중 아직 머무는 것, 새것부터. */
export function recentTerms(env = process.env, now = Date.now) {
  const since = now() - RECENT_TERM_DAYS * 24 * 60 * 60_000;
  return readRecent(env).filter((entry) => Date.parse(entry.at) >= since)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((entry) => entry.term);
}

export function correctionsPath(env = process.env) {
  return path.join(memoryRoot(env), 'agents', 'user.shared', 'runtime', 'dictation-corrections.jsonl');
}

/** 목록 파일의 `## Conclusion` 아래 `- 용어` 줄들. 힌트로 실을 수 없는 줄은 뺀다. */
export function parseDictationTerms(markdown) {
  const terms = [];
  let inList = false;
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^##\s/.test(line)) { inList = /^##\s+Conclusion\s*$/i.test(line); continue; }
    if (!inList) continue;
    const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const term = match[1].replace(/^`(.*)`$/, '$1').trim();
    if (term === '' || term.length > 60 || /[<>\r\n]/.test(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= DICTATION_TERMS_MAX) break;
  }
  return terms;
}

/** 이 사람의 용어: 최근 용어를 앞에, 꿈이 관리하는 목록을 뒤에, 겹침 없이 DICTATION_TERMS_MAX 까지. */
export function dictationTerms(env = process.env, now = Date.now) {
  let kept = [];
  try { kept = parseDictationTerms(readFileSync(dictationTermsPath(env), 'utf8')); } catch { /* 목록 없음 */ }
  return [...new Set([...recentTerms(env, now), ...kept])].slice(0, DICTATION_TERMS_MAX);
}

/**
 * 고친 쌍마다 `classify` 에게 이름·용어인지 묻고, 용어면 최근 용어에 둔다. 이미 힌트에 있는 말은 묻지
 * 않는다. 실패는 힌트 하나를 잃을 뿐이다. 둔 용어를 낸다.
 */
export async function learnTerms(pairs, { classify, env = process.env, now = Date.now } = {}) {
  const learned = [];
  for (const pair of pairs) {
    const known = new Set(dictationTerms(env, now));
    if (known.has(pair.to)) continue;
    const term = await classify(pair).catch(() => null);
    if (!term || known.has(term)) continue;
    const since = now() - RECENT_TERM_DAYS * 24 * 60 * 60_000;
    const entries = [{ term, heard: pair.from, at: new Date(now()).toISOString() },
      ...readRecent(env).filter((entry) => entry.term !== term && Date.parse(entry.at) >= since)].slice(0, RECENT_TERMS_MAX);
    const file = recentTermsPath(env);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ terms: entries }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    learned.push(term);
  }
  return learned;
}

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);
const bare = (word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** 두 토막이 글자를 얼마나 나눠 갖는지(0…1). 바뀐 토막에서 짝을 고를 때 쓴다. */
function likeness(x, y) {
  const left = [...x];
  const right = [...y];
  let shared = 0;
  const pool = [...right];
  for (const char of left) {
    const at = pool.indexOf(char);
    if (at >= 0) { shared += 1; pool.splice(at, 1); }
  }
  return (2 * shared) / Math.max(1, left.length + right.length);
}

/** 바뀐 토막 하나에서 고친 짝: 짧은 쪽 길이만큼, 긴 쪽에서 가장 닮은 낱말들을 고른다. */
function fixedPair(from, to) {
  const fit = (short, long) => {
    let best = null;
    for (let start = 0; start + short.length <= long.length; start += 1) {
      const window = long.slice(start, start + short.length);
      const score = likeness(short.join(' '), window.join(' '));
      if (!best || score > best.score) best = { window, score };
    }
    return best;
  };
  if (from.length === to.length) return { from, to };
  // A term heard in another script ("테이프 스크립트" → "TypeScript") shares no letters with its fix:
  // a short stretch replaced by a short stretch is taken whole.
  const whole = from.length <= 2 && to.length <= 2 ? { from, to } : null;
  if (from.length < to.length) {
    const best = fit(from, to);
    return best && best.score > 0 ? { from, to: best.window } : whole;
  }
  const best = fit(to, from);
  return best && best.score > 0 ? { from: best.window, to } : whole;
}

/**
 * 받아쓴 글 `heard` 와 보낸 글 `sent` 를 낱말 단위로 맞춰, 고친 낱말의 쌍을 낸다. 지운 것, 더 쓴 것,
 * 조사만 붙인 것, 긴 고쳐 쓰기는 고친 낱말이 아니라서 뺀다. 두 글이 3분의 1도 안 겹치면 받아쓴 글을
 * 버리고 새로 쓴 것이라 아무것도 내지 않는다.
 */
export function correctionPairs(heard, sent) {
  const a = words(heard);
  const b = words(sent);
  if (a.length === 0 || b.length === 0) return [];
  const same = (x, y) => bare(x) === bare(y);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  if (table[0][0] === 0 || table[0][0] * 3 < a.length) return [];
  const pairs = [];
  let i = 0;
  let j = 0;
  let from = [];
  let to = [];
  const flush = () => {
    const pair = from.length && to.length ? fixedPair(from, to) : null;
    from = [];
    to = [];
    if (!pair || pair.from.length > CORRECTION_MAX_WORDS) return;
    const fixed = { from: pair.from.map(bare).join(' ').trim(), to: pair.to.map(bare).join(' ').trim() };
    if (!fixed.from || !fixed.to || fixed.from === fixed.to) return;
    // A particle added or dropped ("입력창" → "입력창도") is not a fix.
    if (fixed.to.startsWith(fixed.from) || fixed.from.startsWith(fixed.to)) return;
    pairs.push(fixed);
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i], b[j])) { flush(); i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) { to.push(b[j]); j += 1; }
    else { from.push(a[i]); i += 1; }
  }
  flush();
  return pairs;
}

/**
 * 클라이언트가 보낸 한 번의 보내기: 그 초안에 받아쓴 글들과 실제로 보낸 글. 고친 쌍만 남기고,
 * 몇 개 남겼는지 답한다.
 */
export function recordCorrections({ heard, sent }, { env = process.env, now = Date.now, onRecorded } = {}) {
  const list = (Array.isArray(heard) ? heard : [heard]).filter((text) => typeof text === 'string').slice(0, 20);
  if (typeof sent !== 'string' || sent.length > 100_000) return 0;
  const at = new Date(now()).toISOString();
  const pairs = [];
  for (const text of list) {
    if (text.length > 20_000) continue;
    pairs.push(...correctionPairs(text, sent));
  }
  if (pairs.length === 0) return 0;
  const lines = pairs.map((pair) => JSON.stringify({ at, ...pair }));
  const file = correctionsPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  try {
    if (statSync(file).size > 400_000) {
      const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-CORRECTIONS_MAX_LINES);
      writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
    }
  } catch { /* 덜어 내기는 다음 번에 */ }
  onRecorded?.(pairs);
  return lines.length;
}
