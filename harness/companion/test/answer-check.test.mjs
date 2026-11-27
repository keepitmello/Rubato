import assert from 'node:assert/strict';
import test from 'node:test';
import { ANSWER_CHECK_MODELS, GROUND_SYSTEM, OWN_WORD_TOOLS, PENDING_MAX_AGE_MS, RESTART_CONTINUE_TEXT, checkReply, combineVerdicts, conversation, evidenceOf,
  parseAnswer, parseGround, pendingAsk, pickEvidence, refusalText } from '../answer-check.mjs';
import { T3_RESTART_CONTINUE_TEXT } from '../../t3-integration/src/rpc-connection.mjs';
import { REPLY_TOOL } from '../home.mjs';

const T0 = Date.parse('2026-11-22T01:40:00Z');
let n = 0;
const user = (text, at = T0) => ({ type: 'message', timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'text', text }], timestamp: at } });
const wake = (kind = 'wake', at = T0) => ({ type: 'custom_message', customType: 'rubato-session-message', timestamp: new Date(at).toISOString(), details: { kind, text: kind } });
const channel = (text, at = T0) => ({ type: 'custom_message', customType: 'rubato-session-message', timestamp: new Date(at).toISOString(),
  details: { kind: 'channel', from: { isUser: true, channel: 'telegram' }, text } });
/** One reply that went through, with the answer check's details (cleared false = it only promised). */
const replied = (text, { at = T0, cleared, isError = false } = {}) => {
  const id = `r${++n}`;
  return [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: REPLY_TOOL, arguments: { text } }], timestamp: at } },
    { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: REPLY_TOOL, isError, timestamp: at,
      content: [{ type: 'text', text: 'Sent to the user.' }], ...(cleared === undefined ? {} : { details: { answerCheck: { cleared } } }) } },
  ];
};
const mapping = (asks, extra = {}) => JSON.stringify({ asks, first_says: '첫 줄', hint: '첫 줄에 답을 써', ...extra });

test('the user lines since the last reply that answered them wait; a wake in between does not answer them', () => {
  const entries = [user('어제 거 됐어?'), ...replied('응 됐어'), user('지금 업체가 계좌를 따로 물어봐야 해'), wake('notice'), user('나 자는동안 csr 응대 이상하게 한 거야?')];
  const pending = pendingAsk(entries, { now: T0 });
  assert.deepEqual(pending.lines.map((line) => line.text), ['지금 업체가 계좌를 따로 물어봐야 해', '나 자는동안 csr 응대 이상하게 한 거야?']);
  assert.deepEqual(pending.context.map((item) => [item.who, item.text]), [['user', '어제 거 됐어?'], ['me', '응 됐어']]);
  assert.deepEqual(pending.sent, []);
});

test('nothing waits after a reply that answered, for a proactive message, or for a line heard on a call', () => {
  assert.equal(pendingAsk([user('배포 됐어?'), ...replied('응, 10시에 됐어')], { now: T0 }), undefined);
  assert.equal(pendingAsk([wake('wake')], { now: T0 }), undefined);
  assert.equal(pendingAsk([user('[voice] 여보세요')], { now: T0 }), undefined);
  assert.equal(pendingAsk([user('배포 됐어?', T0)], { now: T0 + PENDING_MAX_AGE_MS + 1 }), undefined, 'a day-old line no longer holds replies back');
  assert.equal(RESTART_CONTINUE_TEXT, T3_RESTART_CONTINUE_TEXT);
  assert.deepEqual(pendingAsk([user('인피녹스 출금이 왜 안돼?'), user(T3_RESTART_CONTINUE_TEXT)], { now: T0 }).lines.map((line) => line.text),
    ['인피녹스 출금이 왜 안돼?'], 'the app\'s restart line is not the user talking');
});

test('the app\'s restart line is told by its mark, or for old entries by its opening; the same words typed stay the user\'s', () => {
  const said = (text, extra) => { const entry = user(text); Object.assign(entry.message, extra); return entry; };
  const lines = (entries) => pendingAsk(entries, { now: T0 })?.lines.map((line) => line.text) ?? [];
  const asked = user('배포 됐어?');
  assert.deepEqual(lines([asked, said(`${T3_RESTART_CONTINUE_TEXT} Your last turn was cut short.`, { rubatoAppText: null })]), ['배포 됐어?'],
    'the app sends a note after the words, which equality never matched');
  assert.deepEqual(lines([asked, said('[Sent by the Rubato app after it restarted] …', { rubatoOrigin: 'restart', rubatoAppText: null })]), ['배포 됐어?']);
  assert.deepEqual(lines([said(T3_RESTART_CONTINUE_TEXT, { rubatoAppText: true })]), [T3_RESTART_CONTINUE_TEXT], 'typed in the app: the user talking');
});

test('a reply that only promised to look leaves the question waiting, and the next reply sees what was already sent', () => {
  const entries = [user('P000191 처리됐어?'), ...replied('확인해볼게', { cleared: false }), wake('notice')];
  const pending = pendingAsk(entries, { now: T0 });
  assert.deepEqual(pending.lines.map((line) => line.text), ['P000191 처리됐어?']);
  assert.deepEqual(pending.sent.map((item) => item.text), ['확인해볼게']);
});

test('a refused reply answers nothing; the user\'s Telegram lines count as the user', () => {
  const entries = [channel('은행명 숫자면 문구가 뜨던가, 아니면 신청건이 만들어져야 합니다'), ...replied('네 19일부터 바뀌었습니다', { isError: true })];
  assert.deepEqual(pendingAsk(entries, { now: T0 }).lines.map((line) => line.text), ['은행명 숫자면 문구가 뜨던가, 아니면 신청건이 만들어져야 합니다']);
  assert.deepEqual(conversation(entries).map((item) => item.who), ['user']);
});

const grounded = JSON.stringify({ claims: [], challenge: { c: 0, changed: false } });
const claims = (list, challenge = { c: 0, changed: false }) => JSON.stringify({ claims: list, challenge });
/** A tool call and its result, as the companion saw it. */
const tool = (name, args, text, at = T0) => {
  const id = `t${++n}`;
  return [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], timestamp: at } },
    { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], timestamp: at } },
  ];
};
const notice = (text, at = T0) => ({ type: 'custom_message', customType: 'rubato-session-message', timestamp: new Date(at).toISOString(),
  details: { kind: 'notice', from: { title: '88 오진창 입금 신청 금액 표시 차이' }, text } });

test('code decides from the answer mapping: every point needs a line, and the first line must answer one', () => {
  const lines = ['네 19일부터 바뀌었습니다', '거절되면 개발실에 바로 뜨게 바꾸는 중'];
  assert.equal(parseAnswer(mapping([]), { lines }).answered, true, 'nothing asked: chat passes');
  const options = parseAnswer(mapping([{ q: '문구를 띄우나, 신청건을 만드나', options: ['문구', '신청건'], line: 0, how: 'none' }]), { lines });
  assert.equal(options.answered, false);
  assert.match(refusalText(combineVerdicts(options, parseGround(grounded))), /문구 \/ 신청건/);
  const buried = parseAnswer(mapping([{ q: '그 칸이 왜 떴냐', line: 2, how: 'answer' }]), { lines });
  assert.equal(buried.answered, false, 'the answer on line 2 behind something else is refused');
  assert.match(refusalText(combineVerdicts(buried, parseGround(grounded))), /first line says instead/);
  assert.equal(parseAnswer(mapping([{ q: '왜 떴냐', line: 9, how: 'answer' }]), { lines }).answered, false, 'a line the draft does not have is no answer');
  const promise = parseAnswer(mapping([{ q: '처리됐어?', line: 1, how: 'promise' }]), { lines });
  assert.deepEqual([promise.answered, promise.cleared], [true, false]);
  const answered = parseAnswer(mapping([{ q: '처리됐어?', line: 1, how: 'answer' }, { q: '왜?', line: 2, how: 'answer' }]), { lines });
  assert.deepEqual([answered.answered, answered.cleared], [true, true]);
  assert.throws(() => parseAnswer('잘 모르겠어', { lines }), /JSON/);
  assert.throws(() => parseAnswer(mapping([{ q: '', line: 0, how: 'none' }]), { lines }), /malformed/, 'a blank ask is not "nothing asked"');
  assert.throws(() => parseAnswer(mapping([{ q: '왜 떴냐', line: 1, how: 'none' }]), { lines }), /malformed/, 'a line with how none contradicts itself');
  assert.throws(() => parseAnswer(mapping([{ q: '왜 떴냐', line: 0, how: 'answer' }]), { lines }), /malformed/);
});

test('a short lead-in the model reads as empty lets line 2 answer; a short line with its own claim does not', () => {
  const ask = [{ q: '7번 8번이 뭔 상황이야', kind: 'question', line: 2, how: 'answer' }];
  assert.equal(parseAnswer(mapping(ask, { lead_in: true }), { lines: ['쉽게 말하면 이거야.', '7번: 출금을 접어야 할 때야'] }).answered, true);
  assert.equal(parseAnswer(mapping(ask, { lead_in: false }), { lines: ['네 19일부터 바뀌었습니다', '거절되면 개발실에 뜨게 바꾸는 중'] }).answered, false);
  assert.equal(parseAnswer(mapping(ask, { lead_in: true }), { lines: ['응, 이상하게 한 거 맞아. 오빠가 자는 동안 내가 이렇게 했어:', '- CSR 칸'] }).answered, false,
    'a long first line is never a lead-in, whatever the model says');
});

test('a work order next to an answered question does not hold the reply back; alone, or with options, it does', () => {
  const lines = ['인피녹스가 묶인 건 아니야, 출금 통장이 비어서 그래', '윤종호 통장을 겸용으로 바꾸면 돼'];
  const why = { q: '인피녹스 출금이 왜 안 되냐', kind: 'question', line: 1, how: 'answer' };
  const order = { q: '업체 방 확인하고 마저 하자', kind: 'request', line: 0, how: 'none' };
  assert.equal(parseAnswer(mapping([why, order]), { lines }).answered, true);
  assert.equal(parseAnswer(mapping([order]), { lines }).answered, false);
  assert.equal(parseAnswer(mapping([why, { ...order, options: ['문구', '신청건'] }]), { lines }).answered, false);
});

test('the evidence is what was seen in this window: tool results with their call, leads, the user; not the companion\'s own words', () => {
  const before = [...tool('bash', { command: 'tg history' }, '옛 창에서 본 것: 신유미 통장')];
  const kept = user('창 경계 직전 사용자 말');
  const entries = [...before, { ...kept, id: 'k1' }, { type: 'compaction', id: 'c1', firstKeptEntryId: 'k1', summary: '요약: 오늘 원화 정산 작업 중' },
    ...tool('session_read', { sessionId: 'lead' }, '주문 3625892088은 업체 지정 250,000원, 회원 확정 금액 비어 있음'),
    ...tool('companion_record', { kind: 'daily', text: '88 시스템이 API로 만들었음' }, 'Wrote to memory/2026-11-22.md'),
    ...replied('88 시스템이 API로 만든 거야'), notice('이 주문은 업체가 250,000원으로 신청한 게 맞아'), user('그니까 유저가 신청을한게 아니라고? 확실해?')];
  const seen = evidenceOf(entries);
  assert.deepEqual(seen.map((item) => item.kind), ['user', 'summary', 'tool', 'message', 'user']);
  assert.match(seen[2].label, /^session_read \{"sessionId":"lead"\}/);
  assert.ok(!seen.some((item) => /API로/.test(item.text)), 'its own record and its own reply are not evidence');
  assert.ok(OWN_WORD_TOOLS.has('companion_record') && OWN_WORD_TOOLS.has('reply'));
});

test('the evidence picked for a draft: the newest pieces, then the ones sharing its rarer words, numbered in time order', () => {
  const filler = Array.from({ length: 40 }, (_, i) => ({ index: i, kind: 'tool', label: 'bash', text: `로그 ${i} 정상 처리 완료 `.repeat(20) }));
  const key = { index: 3, kind: 'message', label: 'notice', text: '주문 3625892088 업체 지정 250,000원, 회원 확정 금액 비어 있음' };
  const items = [...filler.slice(0, 3), key, ...filler.slice(3)].map((item, i) => ({ ...item, index: i }));
  const picked = pickEvidence(items, '업체가 25만원 아니 250,000원으로 지정한 주문 3625892088이야', { budget: 8000 });
  assert.ok(picked.some((item) => item.text.includes('3625892088')), 'the piece sharing the rare words is in');
  assert.ok(picked.some((item) => item.index === items.length - 1), 'the newest piece is in');
  assert.deepEqual(picked.map((item) => item.id), picked.map((_, i) => `E${i + 1}`));
  assert.deepEqual(picked.map((item) => item.index), [...picked.map((item) => item.index)].sort((a, b) => a - b));
  assert.ok(picked.length < items.length, 'the budget leaves most of the window out');
  assert.ok(picked.reduce((sum, item) => sum + item.text.length, 0) <= 8000 + 3000);
});

test('grounding: a fact needs evidence it was given; a hedge needs none; a changed claim after a doubt needs a new tool result', () => {
  const ids = new Set(['E1', 'E2']);
  const v = parseGround(claims([{ s: '업체가 250,000원으로 지정했어', t: 'fact', ev: ['E1'] }, { s: '유저가 신청하면 올라오는 게 맞고', t: 'fact', ev: [] },
    { s: '88 사이트에서 뭘 했는지는 아직 모르겠어', t: 'hedge', ev: [] }, { s: '통장은 조상범이야', t: 'fact', ev: ['E9'] },
    { s: '리드한테 맡겼어', t: 'fact', cls: 'mine', ev: [] }, { s: '그게 흔한 순서야', t: 'fact', cls: 'other', ev: [] },
    { s: '잔액은 136만이야', t: 'fact', cls: 'number', ev: [] }]), { evidenceIds: ids });
  assert.deepEqual(v.unsupported, ['유저가 신청하면 올라오는 게 맞고', '통장은 조상범이야', '잔액은 136만이야'],
    'numbers, done, behavior and causes need evidence (an unnamed kind counts as behavior); its own acts and the rest do not');
  const recent = [{ who: 'me', text: '업체가 신청한 거야', index: 10 }, { who: 'user', text: '그니까 유저가 신청을한게 아니라고? 확실해?', index: 12 }];
  assert.equal(parseGround(claims([], { c: 2, changed: true }), { recent, toolResultsSince: () => 0 }).flip, '그니까 유저가 신청을한게 아니라고? 확실해?');
  assert.equal(parseGround(claims([], { c: 2, changed: true }), { recent, toolResultsSince: (index) => (index === 12 ? 1 : 0) }).flip, undefined, 'checked again: may change');
  assert.equal(parseGround(claims([], { c: 1, changed: true }), { recent }).flip, undefined, 'only a doubt the user voiced counts');
  assert.equal(parseGround(claims([], { c: 2, changed: false }), { recent }).flip, undefined);
  assert.throws(() => parseGround(JSON.stringify({ challenge: {} })), /no claims/, 'a mapping without claims checked nothing');
  assert.throws(() => parseGround(claims([{ s: '', ev: [] }])), /malformed/);
  const text = refusalText(combineVerdicts(undefined, { ...v, flip: '확실해?' }));
  assert.match(text, /supports:\n  "유저가 신청하면 올라오는 게 맞고"/);
  assert.match(text, /doubted your claim/);
});

/**
 * A model registry: the answer check gets `answer(model)`, the grounding check `ground(model)` (a
 * string, or an Error to throw). Calls are recorded with which check made them.
 */
function registryOf(answer, { ground = () => grounded, signedOut = [] } = {}) {
  const calls = [];
  return { calls,
    find: (provider, id) => ({ provider, id }),
    hasConfiguredAuth: (model) => !signedOut.includes(model.id),
    async complete(model, context, options) {
      const check = context.systemPrompt === GROUND_SYSTEM ? 'ground' : 'answer';
      calls.push({ id: model.id, check, reasoning: options.reasoning, user: context.messages[0].content[0].text });
      const out = (check === 'ground' ? ground : answer)(model);
      if (out instanceof Error) throw out;
      return { content: [{ type: 'text', text: out }] };
    } };
}
const waiting = [user('화면에 그런 칸이 왜 떴냐')];
const [first, last] = ANSWER_CHECK_MODELS;

test('a reply with nothing waiting gets only the grounding check; with lines waiting both run, the answer check thinking', async () => {
  const quiet = registryOf(() => { throw new Error('the answer check must not run'); });
  const proactive = await checkReply({ entries: [wake()], draft: '좋은 아침!', registry: quiet, now: T0 });
  assert.equal(proactive.ok, true);
  assert.deepEqual(quiet.calls.map((call) => [call.check, call.reasoning]), [['ground', 'low']]);
  const registry = registryOf(() => mapping([{ q: '칸이 왜 떴냐', line: 0, how: 'none' }]));
  const result = await checkReply({ entries: [user('CSR이 짝 없는 탭이 생겼대'), ...waiting], draft: '새로고침하면 없어져', registry, now: T0 });
  assert.equal(result.ok, false);
  const answerCall = registry.calls.find((call) => call.check === 'answer');
  assert.equal(answerCall.reasoning, 'high');
  assert.match(answerCall.user, /1\. CSR이 짝 없는 탭이 생겼대\n2\. 화면에 그런 칸이 왜 떴냐/);
  assert.match(answerCall.user, /1: 새로고침하면 없어져/);
  assert.ok(first.map((model) => model.id).includes(answerCall.id), 'the first tier answers first');
});

test('a proactive or follow-up reply with a made-up fact is refused; restating what a lead reported passes', async () => {
  const entries = [notice('이 주문은 업체가 250,000원으로 신청한 게 맞아. 회원이 입금 폼에서 확인을 안 눌렀어.')];
  const made = await checkReply({ entries, draft: '아니요 유저가 신청하면 저희 쪽에 올라오는 게 맞고', now: T0,
    registry: registryOf(() => mapping([]), { ground: () => claims([{ s: '아니요 유저가 신청하면 저희 쪽에 올라오는 게 맞고', t: 'fact', ev: [] }]) }) });
  assert.equal(made.ok, false);
  assert.match(refusalText(made.verdict), /유저가 신청하면/);
  const ground = registryOf(() => mapping([]), { ground: () => claims([{ s: '업체가 25만 원으로 신청했고', t: 'fact', ev: ['E1'] }]) });
  const restated = await checkReply({ entries, draft: '업체가 25만 원으로 신청했고, 회원이 확인을 아직 안 눌렀어.', registry: ground, now: T0 });
  assert.equal(restated.ok, true);
  assert.match(ground.calls[0].user, /E1 \[notice · 88 오진창 입금 신청 금액 표시 차이/);
});

test('a claim changed after "확실해?" is refused until a tool ran since the question', async () => {
  const flipped = () => claims([], { c: 2, changed: true });
  const asked = [...replied('업체가 신청한 거야'), user('그니까 유저가 신청을한게 아니라고? 확실해?')];
  const blind = await checkReply({ entries: asked, draft: '아니, 회원이 신청한 거야', registry: registryOf(() => mapping([{ q: '확실해?', line: 1, how: 'answer' }]), { ground: flipped }), now: T0 });
  assert.deepEqual([blind.ok, blind.verdict.flip], [false, '그니까 유저가 신청을한게 아니라고? 확실해?']);
  const looked = await checkReply({ entries: [...asked, ...tool('session_send', { text: '회원이 신청했는지 DB로 봐줘' }, 'Sent')],
    draft: '아니, 회원이 신청한 거야', registry: registryOf(() => mapping([{ q: '확실해?', line: 1, how: 'answer' }]), { ground: flipped }), now: T0 });
  assert.equal(looked.ok, true);
});

test('a failing account hands over to the other, then to the next tier; when none answers the reply is refused, not passed', async () => {
  const firstIds = first.map((model) => model.id);
  const flaky = (model) => firstIds.includes(model.id) ? new Error('429 out of quota') : mapping([]);
  const handed = registryOf(flaky, { ground: (model) => firstIds.includes(model.id) ? new Error('429') : grounded });
  const passed = await checkReply({ entries: waiting, draft: '출금 문자가 신청이랑 안 이어지면 그 칸에 모여', registry: handed, now: T0 });
  assert.deepEqual([passed.ok, handed.calls.filter((call) => call.check === 'answer').length], [true, 3]);
  assert.ok(last.map((model) => model.id).some((id) => passed.model.includes(id)));
  const down = registryOf(() => new Error('overloaded'), { ground: () => new Error('overloaded'), signedOut: [last[1].id] });
  const refused = await checkReply({ entries: waiting, draft: '출금 문자가 신청이랑 안 이어지면 그 칸에 모여', registry: down, now: T0 });
  assert.deepEqual([refused.ok, refused.unavailable], [false, true]);
  assert.match(refused.errors.join(' '), /answer check: .*not signed in/);
  const groundDown = registryOf(() => mapping([]), { ground: () => '음 글쎄' });
  assert.equal((await checkReply({ entries: [wake()], draft: '좋은 아침', registry: groundDown, now: T0 })).unavailable, true,
    'a grounding answer that is not the mapping is no pass, also for a proactive reply');
});

test('a second promise for a question already promised once is refused; the end of a long pasted line reaches the model', async () => {
  const entries = [user('P000191 처리됐어?'), ...replied('확인해볼게', { cleared: false })];
  const again = await checkReply({ entries, draft: '아직 보는 중이야', registry: registryOf(() => mapping([{ q: '처리됐어?', line: 1, how: 'promise' }])), now: T0 });
  assert.deepEqual([again.ok, again.verdict.repeatPromise], [false, true]);
  assert.match(refusalText(again.verdict), /already told the user/);
  const answered = await checkReply({ entries, draft: '응 처리됐어', registry: registryOf(() => mapping([{ q: '처리됐어?', line: 1, how: 'answer' }])), now: T0 });
  assert.equal(answered.ok, true);
  const registry = registryOf(() => mapping([]));
  await checkReply({ entries: [user(`${'운영팀이 옮긴 긴 대화. '.repeat(400)}\n\n이거도 동문서답 아니야?`)], draft: '응', registry, now: T0 });
  assert.match(registry.calls.find((call) => call.check === 'answer').user, /이거도 동문서답 아니야\?/);
});
