import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCompanionHomeFactories } from '../../pi-runtime/features/companion-home/index.mjs';
import { CLUE_HEADER, CLUE_TYPE, amountsOf, installSourceClues, needsSource, wordsOf } from '../../pi-runtime/features/companion-home/source-clues.mjs';

const NOW = Date.UTC(2026, 10, 26, 19, 0, 0);
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

/** A Telegram store with the two real lines that matter and enough everyday chatter to make a word rare. */
function store(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-source-clues-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tg.db');
  const db = new DatabaseSync(file);
  db.exec('create table messages (chat_id text, msg_id integer, date integer, out integer default 0, sender_name text, text text, deleted_at text, primary key (chat_id, msg_id))');
  const add = db.prepare('insert into messages (chat_id, msg_id, date, out, sender_name, text) values (?, ?, ?, ?, ?, ?)');
  add.run('-4984888159', 364997, sec('2026-11-21T14:04:12Z'), 1, 'me',
    '아니요 수수료 아닙니다\n\n- 김민규 장 링 걸리기 전에 장주가 카카오페이로 405만 빼둔 겁니다 (21일 오후 2시쯤)\n- 실장 말로는 돈 못 찾을까봐 미리 빼놓으라고 시켰다고 합니다\n- 88 돈인데 지금 장업체가 갖고 있는지 88한테 갔는지는 확인해봐야 합니다');
  add.run('-4984888159', 368763, sec('2026-11-26T14:43:14Z'), 0, 'Deran', '묶인 통장 실제 잔고\n\n김민규 카뱅 6,050,612 (장부 6,100,612, 5만 차이)\n김민규 카카오페이 4,051,000 (장부엔 동결 아님)\n조상범 기업 4,046,198 (장부와 같음)');
  for (let i = 0; i < 400; i++) add.run('-1', 1000 + i, sec('2026-11-25T00:00:00Z') + i, 0, 'x', `잡담 ${i} 번째 메시지 점검 일정 확인 부탁드립니다 ${'가나다라마바사아자차'.slice(i % 10)}${i % 10 === 0 ? ' 동결' : ''}`);
  db.close();
  return file;
}

function session(t, { env = {}, file = store(t) } = {}) {
  const handlers = {};
  installSourceClues({ on: (name, handler) => { handlers[name] = handler; } }, { env: { HOME: '/nonexistent', RUBATO_COMPANION_TG_DB: file, ...env }, now: () => NOW });
  const messages = [];
  let stamp = 0;
  return {
    messages,
    /** One incoming message and the context the model reads for it: the clue text, or undefined. */
    async send(message) {
      messages.push({ timestamp: ++stamp, ...message });
      const result = await handlers.context?.({ messages: [...messages] });
      const out = result?.messages ?? messages;
      const at = out.findLastIndex((m) => m === messages.at(-1));
      const next = out[at + 1];
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: ++stamp });
      return next?.customType === CLUE_TYPE ? next.content[0].text : undefined;
    },
    say(text) { return this.send({ role: 'user', content: [{ type: 'text', text }], rubatoAppText: text }); },
    result: async () => handlers.context?.({ messages: [...messages] }),
  };
}

const ORIGINAL = 'tg:-4984888159:364997';

test('the user\'s money and who-did-it questions get the original attached', async (t) => {
  const file = store(t);
  const asked = [
    ['카페 400만은 그럼 출금가능인거야?', '장주가 카카오페이로 405만 빼둔 겁니다'],
    ['카카오페이가 동결이라고?', '장주가 카카오페이로 405만 빼둔 겁니다'],
    ['아니 장 업체가 한 게 아니지 않냐고', '지금 장업체가 갖고 있는지'],
  ];
  for (const [words, line] of asked) {
    const clue = await session(t, { file }).say(words);
    assert.ok(clue?.startsWith(CLUE_HEADER), words);
    assert.match(clue, new RegExp(`${ORIGINAL} · 11-21 23:04 · 우용\\(내 계정\\) · .*${line}`, 'u'), words);
    assert.ok(clue.split('\n').length <= 6, 'a header and at most five lines');
  }
});

test('messages without money, people or who-did-it get nothing', async (t) => {
  const s = session(t);
  for (const words of ['ㅇㅇ', '자', '스티어링 지양하라고', '원문을 자동으로 붙혀주는 게 가능해?']) assert.equal(await s.say(words), undefined, words);
});

test('an original already shown is not shown again while the topic goes on', async (t) => {
  const s = session(t);
  assert.ok((await s.say('카페 400만은 그럼 출금가능인거야?'))?.includes(ORIGINAL));
  const second = await s.say('아니 장 업체가 한 게 아니지 않냐고');
  assert.ok(!second?.includes(ORIGINAL));
});

test('with nothing found it attaches nothing, not even a note about it', async (t) => {
  const s = session(t);
  assert.equal(await s.say('쿠팡 오만 구천 팔백원 결제'), undefined);
  assert.equal((await s.result())?.messages?.some((m) => m.customType === CLUE_TYPE), undefined);
});

test('an inbox wake carries its 원문 lines through the same search; other wakes and notices get nothing', async (t) => {
  const s = session(t);
  const wake = (what, text) => ({ role: 'custom', customType: 'rubato-session-message', details: { kind: 'wake', what }, content: [{ type: 'text', text }] });
  const clue = await s.send(wake('inbox', 'INBOX marker=b-1\n\nS-1 🔔 방 · 돈 질문\n원문: 김민규 카카오페이 405만 출금 가능한가요?\n원문 위치: tg:-1:1'));
  assert.ok(clue?.includes(ORIGINAL));
  assert.equal(await session(t).send(wake('heartbeat', 'HEARTBEAT tick=0 카카오페이 405만')), undefined);
  assert.equal(await session(t).send({ role: 'custom', customType: 'rubato-session-message', details: { kind: 'notice' }, content: [{ type: 'text', text: '원문: 카카오페이 405만 출금' }] }), undefined);
});

test('the clue stays after its message on later model calls in the same turn', async (t) => {
  const s = session(t);
  assert.ok(await s.say('카카오페이 405만 출금되나?'));
  s.messages.push({ role: 'user', content: [{ type: 'text', text: '카카오페이가 동결이라고?' }], rubatoAppText: '카카오페이가 동결이라고?', timestamp: 100 });
  const first = (await s.result()).messages;
  s.messages.push({ role: 'assistant', content: [{ type: 'toolCall', name: 'x' }], timestamp: 101 }, { role: 'toolResult', content: [], timestamp: 102 });
  const again = (await s.result())?.messages ?? s.messages;
  assert.equal(first.filter((m) => m.customType === CLUE_TYPE).length, again.filter((m) => m.customType === CLUE_TYPE).length);
});

test('only Segno\'s session installs it, and a missing store stays silent', async (t) => {
  const other = session(t, { env: { RUBATO_COMPANION_ID: 'ru' } });
  assert.equal(await other.say('카카오페이 405만 출금되나?'), undefined);
  const gone = session(t, { file: '/nonexistent/tg.db' });
  assert.equal(await gone.say('카카오페이 405만 출금되나?'), undefined);
});

test('it is a part of the companion-home extension', () => {
  assert.ok(createCompanionHomeFactories({ env: {} }).length);
});

test('amounts, words and the gate', () => {
  assert.deepEqual(amountsOf('400만, 4,051,000원 그리고 03:50 11/26 #364997 3건'), [4_000_000, 4_051_000]);
  assert.deepEqual(wordsOf('장 업체가 한 게').pairs, ['장업체']);
  assert.ok(wordsOf('카카오페이가').words.includes('카카오페이'));
  assert.equal(needsSource('ㅇㅇ'), false);
  assert.equal(needsSource('누가 했어'), true);
  assert.equal(needsSource('조상범 어디 갔어', new Set(['조상범'])), true);
});
