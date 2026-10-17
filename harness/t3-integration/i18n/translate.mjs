#!/usr/bin/env node
// Fills the Korean dictionary (overlay/apps/web/src/rubatoI18n.ko.json) with
// the interface text it lacks. Keys come from extract.mjs; each batch goes to
// a model through `rubato -p` with prompt.md and glossary.md, and an answer
// that breaks a value, an element marker or the glossary goes back once more
// with the reason. Entries already in the dictionary are never re-translated.
//
//   node extract.mjs --t3 ~/.rubato/t3-source > /tmp/strings.json
//   node translate.mjs --strings /tmp/strings.json [--model provider/id] [--limit N] [--recheck]
//
// --recheck also sends back entries already in the dictionary that today's
// checks reject (after a glossary or tone change), with the reason.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DICTIONARY = path.join(here, '../overlay/apps/web/src/rubatoI18n.ko.json');
export const DEFAULT_MODEL = 'google-vertex/gemini-4-argon';

// Glossary terms the user keeps in English or names one way (glossary.md),
// as the Korean a translator tends to write instead.
const OFF_GLOSSARY = [
  ['브랜치', 'branch'], ['워크트리', 'worktree'], ['작업 트리', 'worktree'], ['병합', 'merge'], ['머지', 'merge'],
  ['푸시', 'push'], ['페치', 'fetch'], ['리베이스', 'rebase'], ['클론', 'clone'], ['체크아웃', 'checkout'],
  ['레포', 'repo'], ['저장소', 'repo'], ['리포지토리', 'repo'], ['스태시', 'stash'], ['포크', 'fork'],
  ['되감기', 'rewind'], ['풀 리퀘스트', 'PR'], ['끌어오기', 'PR'], ['디프', 'diff'],
  ['쓰레드', '스레드'], ['컴팩트', '압축'], ['제공자', '프로바이더'], ['공급자', '프로바이더'],
  ['사이드 채팅', '사이드챗'], ['측면 채팅', '사이드챗'], ['컨텍스트 창', '컨텍스트 윈도우'],
  ['컴포저', '입력창'], ['작성기', '입력창'], ['툴 호출', '도구 호출'], ['대기열', '큐'],
  ['차례', '턴'], ['드림', '꿈'], ['방향 전환', '스티어링'], ['소스 컨트롤', '버전 관리'],
  ['소스 제어', '버전 관리'], ['워크스페이스', '작업 공간'], ['디바이스', '기기'],
  ['작성창', '입력창'], ['보관', '아카이브'], ['미루기', '다시 알림'], ['스누즈', '다시 알림'], ['정착', '완료'], ['계획 모드', '플랜'],
];

// An English text that starts with one of these is an action: a button, a menu
// item or an icon button's name. The user wants those to end in 하기 (glossary.md).
const ACTION_VERBS = new Set(`accept add allow apply approve archive attach browse cancel change check choose clear
close collapse configure confirm connect continue copy create cut delete deny disable disconnect discard dismiss download
duplicate edit enable expand export filter finish fork forget hide import install jump keep launch leave link load lock
log manage mark merge move open paste pause pin play preview publish pull push quit reconnect refresh reload remove
rename reopen replace request reset resize restart restore resume retry reveal revert review revoke rewind rotate run
save scroll search select send set settle share show sign skip snooze sort start stash steer stop submit switch sync
take toggle try turn undo uninstall unlink unlock unpin update upgrade upload use view wake`.split(/\s+/));
const ACTION_REASON = 'this looks like an action (a button, menu item or icon button name)';
const ACTION_PLACES = new Set(['text', 'child', 'label', 'aria-label', 'ariaLabel', 'title', 'tooltip', 'helper', 'buttonLabel', 'actionLabel', 'submitLabel', 'triggerLabel', 'confirmLabel', 'cancelLabel']);

const LABEL_REASON = 'this names a page, section, field or status here, not an action';
// Code around the text that says it sits on something you press.
const PRESSED = /<(\w*Button|\w*MenuItem|\w*MenuRadioItem|\w*MenuCheckboxItem|\w*CommandItem|button)\b|onClick|onSelect|actionLabel|buttonLabel|submitLabel|confirmLabel|cancelLabel/;

/** Whether a short English text names an action: verb first, on something pressed. */
export function isAction(english, where, context = '') {
  if (!ACTION_PLACES.has(where)) return false;
  if (context && !PRESSED.test(context)) return false;
  const words = english.replace(/[.…]+$/, '').split(/\s+/);
  if (words.length > 7 || /[.!?:]\s|[.!?]$/.test(english.replace(/(\.\.\.|…)$/, ''))) return false;
  if (/^(pull request|cut off|run (log|context|on|details|history|summary)|turn \d|plan$|review$|steer$|stash$)/i.test(english)) return false;
  return ACTION_VERBS.has(words[0].toLowerCase()) && /^[A-Z]/.test(english);
}

/** Why a Korean entry cannot ship, or null when it can. */
export function rejectReason(english, korean, where, context = '') {
  if (typeof korean !== 'string' || korean.trim().length === 0) return 'empty answer';
  const values = (text) => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]);
  const englishValues = values(english);
  const koreanValues = values(korean);
  for (const value of koreanValues) {
    if (!englishValues.includes(value)) return `{${value}} is not in the English`;
    if (koreanValues.filter((other) => other === value).length > 1) return `{${value}} appears twice`;
  }
  for (const value of englishValues) {
    const plural = new RegExp(`[A-Za-z]\\{${value}\\}`).test(english);
    if (!koreanValues.includes(value) && !plural) return `{${value}} was dropped; keep every value`;
  }
  const markers = (text) => [...text.matchAll(/<(\d+)\/>/g)].map((match) => match[1]).join(',');
  if (markers(korean) !== markers(english)) {
    return `element markers must be ${markers(english) || 'none'} in that order, got ${markers(korean) || 'none'}`;
  }
  const prose = korean.replace(/`[^`]*`/g, '');
  for (const [wrong, right] of OFF_GLOSSARY) {
    if (prose.includes(wrong)) return `glossary: write ${right}, not ${wrong}`;
  }
  // "git commit" is a command and stays.
  if (/(?<!git )\bcommits?\b/i.test(prose)) return 'glossary: commit is 커밋';
  if (where && isAction(english, where, context) && !/기\s*(\{\d+\})?\s*(\.\.\.|…)?$/.test(korean.trim())) {
    return `${ACTION_REASON}: end it in 하기, as in 취소하기, 경로 복사하기, 다시 시도하기, or a 기 form like 닫기, 열기. If it is really a noun or a status here, keep your answer`;
  }
  if (where && context && ACTION_PLACES.has(where) && !PRESSED.test(context) && english.split(/\s+/).length <= 3 &&
    /하기\s*(\.\.\.|…)?$/.test(korean.trim())) {
    return `${LABEL_REASON}: use the noun form without 하기 (검색, 아카이브, 설정). If it is really something to press, keep your answer`;
  }
  if (/십시오|시겠습니까/.test(prose)) return 'tone: never 하십시오체 (no ~십시오, ~하시겠습니까); requests are ~하세요, questions ~할까요?';
  if (/수 없었습니다|지 못했습니다/.test(prose)) return 'tone: errors are in the present tense (~할 수 없습니다)';
  return null;
}

export async function readDictionary(file = DICTIONARY) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return { exact: { ...parsed.exact }, templates: new Map(parsed.templates) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exact: {}, templates: new Map() };
    throw error;
  }
}

export async function writeDictionary(dictionary, file = DICTIONARY) {
  const sorted = Object.fromEntries(Object.entries(dictionary.exact).sort(([a], [b]) => a.localeCompare(b)));
  const templates = [...dictionary.templates].sort(([a], [b]) => a.localeCompare(b));
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ exact: sorted, templates }, null, 1) + '\n');
  await rename(temporary, file);
}

export function hasEntry(dictionary, key) {
  return key in dictionary.exact || dictionary.templates.has(key);
}

export function addEntry(dictionary, key, korean) {
  if (/\{\d+\}/.test(key)) dictionary.templates.set(key, korean);
  else dictionary.exact[key] = korean;
}

/** The JSON array in a model's reply, fenced or not. */
export function parseReply(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('reply is not an array');
  return parsed;
}

function runModel({ model, system, batchFile }) {
  return new Promise((resolve, reject) => {
    const child = spawn('rubato', ['-p', '--no-tools', '--no-session', '--model', model, '--system-prompt', system,
      `@${batchFile}`, 'Translate every item in the attached file. You have no tools: answer directly with the JSON array.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`rubato exited ${code}: ${err.slice(-400)}`));
    });
  });
}

function itemFor(entry, id, fix) {
  const place = entry.places[0];
  return {
    id,
    text: entry.key,
    where: place.where,
    file: place.file,
    context: place.context.split('\n').map((line) => line.slice(0, 180)).join('\n'),
    ...(fix ? { fix } : {}),
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    strings: { type: 'string' }, model: { type: 'string' }, limit: { type: 'string' },
    batch: { type: 'string' }, jobs: { type: 'string' }, work: { type: 'string' }, recheck: { type: 'boolean' },
  } });
  if (!values.strings) throw new Error('Usage: node translate.mjs --strings strings.json [--model id] [--limit N]');
  const model = values.model ?? DEFAULT_MODEL;
  const batchSize = Number(values.batch ?? 100);
  const jobs = Number(values.jobs ?? 6);
  const work = values.work ?? path.join(here, '.work');
  await mkdir(work, { recursive: true });

  const glossary = await readFile(path.join(here, 'glossary.md'), 'utf8');
  const system = (await readFile(path.join(here, 'prompt.md'), 'utf8')).replace('{{GLOSSARY}}', glossary);
  const strings = JSON.parse(await readFile(values.strings, 'utf8'));
  const dictionary = await readDictionary();
  const fixes = new Map();
  if (values.recheck) {
    for (const entry of strings) {
      const korean = dictionary.exact[entry.key] ?? dictionary.templates.get(entry.key);
      if (korean === undefined) continue;
      const reason = rejectReason(entry.key, korean, entry.places[0].where, entry.places[0].context);
      if (!reason) continue;
      delete dictionary.exact[entry.key];
      dictionary.templates.delete(entry.key);
      fixes.set(entry.key, `${reason}. Previous answer: ${korean}`);
    }
    console.error(`${fixes.size} entries fail today's checks`);
  }
  let pending = strings.filter((entry) => !hasEntry(dictionary, entry.key));
  if (values.limit) pending = pending.slice(0, Number(values.limit));
  console.error(`${pending.length} keys to translate with ${model}`);

  const notes = [];
  const rejected = [];
  const failed = [];
  let saving = Promise.resolve();
  const save = () => { saving = saving.then(() => writeDictionary(dictionary)); return saving; };

  // Round one translates; round two retries rejected answers with the reason.
  let queue = pending.map((entry) => ({ entry, fix: fixes.get(entry.key) ?? null }));
  for (let round = 1; round <= 2 && queue.length > 0; round++) {
    const batches = [];
    for (let start = 0; start < queue.length; start += batchSize) batches.push(queue.slice(start, start + batchSize));
    const retry = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < batches.length) {
        const index = next++;
        const batch = batches[index];
        const items = batch.map(({ entry, fix }, at) => itemFor(entry, `k${at}`, fix));
        const batchFile = path.join(work, `round${round}-batch${index}.json`);
        await writeFile(batchFile, JSON.stringify(items, null, 1));
        // A failed call (the provider's own hiccups) is tried again as is.
        let reply = null;
        for (let attempt = 1; attempt <= 3 && reply === null; attempt++) {
          try {
            reply = parseReply(await runModel({ model, system, batchFile }));
          } catch (error) {
            console.error(`batch ${index} attempt ${attempt}: ${error.message.split('\n').pop()}`);
          }
        }
        if (reply === null) {
          failed.push(...batch.map(({ entry }) => entry.key));
          continue;
        }
        const answers = new Map(reply.map((answer) => [answer.id, answer]));
        batch.forEach(({ entry }, at) => {
          const answer = answers.get(`k${at}`);
          const reason = rejectReason(entry.key, answer?.ko, entry.places[0].where, entry.places[0].context);
          // The action rule guesses from the first English word ("Pull request
          // title" starts with a verb too): a second answer that still keeps a
          // noun is taken as the translator's reading.
          const soft = (reason?.startsWith(ACTION_REASON) || reason?.startsWith(LABEL_REASON)) && round === 2;
          if (reason && !soft) {
            if (round === 1) retry.push({ entry, fix: `${reason}. Previous answer: ${answer?.ko ?? '(none)'}` });
            else rejected.push({ key: entry.key, ko: answer?.ko ?? null, reason });
            return;
          }
          addEntry(dictionary, entry.key, answer.ko.trim());
          if (answer.note) notes.push({ key: entry.key, ko: answer.ko, note: answer.note });
        });
        await save();
        done++;
        console.error(`round ${round}: ${done}/${batches.length} batches`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, batches.length) }, worker));
    queue = retry;
  }
  await saving;
  await writeFile(path.join(work, 'notes.json'), JSON.stringify(notes, null, 1));
  await writeFile(path.join(work, 'rejected.json'), JSON.stringify(rejected, null, 1));
  console.error(`done: ${pending.length - rejected.length - failed.length} added, ${rejected.length} rejected, ${failed.length} not answered, ${notes.length} notes (${work})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
