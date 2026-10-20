import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NEXT_WAKE_MAX_MS, SEGNO_MEMORY_AGENT, clearNextWake, companionHomeFor, ensureSegnoHome, memoryAgentOf, nextWakeAt,
  readNextWake, readNote, readRecord, record, segnoPaths, setNextWake,
} from '../home.mjs';
import { companionHome } from '../companion.mjs';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}

const at = (hour, minute = 0) => new Date(2026, 9, 19, hour, minute).getTime();

test("Segno's home has its notes and its two records, and its folder points at its own memory store", (t) => {
  const env = sandbox(t);
  const home = ensureSegnoHome(env);
  const paths = segnoPaths(env);
  assert.equal(home.config, 'written');
  assert.ok(existsSync(paths.notes));
  assert.ok(existsSync(paths.diary));
  const config = JSON.parse(readFileSync(paths.projectConfig, 'utf8'));
  assert.deepEqual(config, { memory: { agent: SEGNO_MEMORY_AGENT } });
  assert.equal(memoryAgentOf(env), 'segno');

  // A config the person wrote is the answer, not ours to overwrite.
  writeFileSync(paths.projectConfig, '{ "memory": { "agent": "mine" } }\n');
  assert.equal(ensureSegnoHome(env).config, 'existing');
  assert.equal(memoryAgentOf(env), 'mine');
});

test('the home rule here and companion.mjs name the same folder', (t) => {
  const env = sandbox(t);
  assert.equal(companionHomeFor(env), companionHome(env));
  assert.equal(companionHomeFor({ HOME: '/tmp/x' }), companionHome({ HOME: '/tmp/x' }));
});

test('a daily entry is a time heading and the day as it happened', (t) => {
  const env = sandbox(t);
  const first = record('daily', '리드 하나 시작했어. 발주는 우용이 말 그대로 옮겼어.', { at: at(19, 30), env });
  record('daily', '텔레그램 버그 리포트 하나 닫았어.', { at: at(21, 5), env });
  const text = readRecord('daily', { date: '2026-10-19', env });
  assert.match(text, /## 19:30\n리드 하나 시작했어/);
  assert.match(text, /## 21:05\ntelegram|## 21:05\n텔레그램/);
  assert.ok(text.indexOf('19:30') < text.indexOf('21:05'), 'entries keep the order they were written in');
  assert.equal(first.date, '2026-10-19');
  assert.equal(readRecord('daily', { date: '2026-10-18', env }), '');
});

test('a diary entry is a named scene, and a second entry that day starts after a rule', (t) => {
  const env = sandbox(t);
  record('diary', '아침엔 조용했고, 오후에 버그 리포트가 들어오면서 판이 살아났어.', { heading: '버그 리포트가 들어온 오후', at: at(15), env });
  record('diary', '밤엔 좀 뿌듯했어. 내가 잡은 걸 내가 닫았으니까.', { heading: '밤', at: at(23), env });
  const text = readRecord('diary', { date: '2026-10-19', env });
  assert.match(text, /## 버그 리포트가 들어온 오후/);
  assert.match(text, /---/);
  assert.match(text, /## 밤\n밤엔 좀 뿌듯했어/);
});

test('a note is Segno\'s own land, named in lowercase', (t) => {
  const env = sandbox(t);
  record('note', '세뇨 봇은 @BotFather 에서 만들고 토큰은 0600 으로 둔다.', { name: 'telegram-bot', at: at(10), env });
  assert.match(readNote('telegram-bot', { env }), /## 10:00\n세뇨 봇은/);
  assert.throws(() => record('note', 'x', { name: 'Not A Name', env }), /lowercase/);
  assert.throws(() => record('note', 'x', { env }), /a note needs a name/);
});

test('a record refuses nothing to say and a kind that is not one of the three', (t) => {
  const env = sandbox(t);
  assert.throws(() => record('daily', '   ', { env }), /some text/);
  assert.throws(() => record('log', 'x', { env }), /kind must be one of/);
});


test('nextWakeAt: minutes from now, or the next HH:MM after now, within a minute to a day', () => {
  const now = new Date(2026, 9, 20, 22, 30).getTime();
  assert.equal(nextWakeAt({ minutes: 90 }, now), now + 90 * 60_000);
  assert.equal(nextWakeAt({ time: '23:00' }, now), new Date(2026, 9, 20, 23, 0).getTime());
  assert.equal(nextWakeAt({ time: '07:30' }, now), new Date(2026, 9, 21, 7, 30).getTime(), 'a time already past today is tomorrow');
  assert.equal(nextWakeAt({ time: '22:30' }, now), now + NEXT_WAKE_MAX_MS, 'the same clock time is a day ahead');
  assert.throws(() => nextWakeAt({ minutes: 0 }, now), /at least a minute/);
  assert.throws(() => nextWakeAt({ minutes: 24 * 60 + 1 }, now), /at most a day/);
  assert.throws(() => nextWakeAt({ minutes: 5, time: '23:00' }, now), /one of them/);
  assert.throws(() => nextWakeAt({ time: '25:00' }, now), /HH:MM/);
});

test('the next wake is kept in the home until it is cleared, and needs a reason', (t) => {
  const env = sandbox(t);
  assert.equal(readNextWake(env), undefined);
  assert.throws(() => setNextWake({ at: 1000 }, env), /why/);
  setNextWake({ at: 1000, reason: ' 저녁에 다시 ' }, env);
  assert.deepEqual(readNextWake(env), { at: 1000, reason: '저녁에 다시' });
  assert.equal(path.basename(segnoPaths(env).wake), 'wake.json');
  clearNextWake(env);
  assert.equal(readNextWake(env), undefined);
});
