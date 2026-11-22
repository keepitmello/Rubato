import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ANSWER_CHECK_MODELS, PENDING_MAX_AGE_MS, RESTART_CONTINUE_TEXT, checkReply, conversation, parseVerdict, pendingAsk, refusalText } from '../answer-check.mjs';
import { T3_RESTART_CONTINUE_TEXT } from '../../t3-integration/src/rpc-connection.mjs';
import { OWN_CHAT_EDIT_REFUSAL, createCompanionHomeFactories } from '../../pi-runtime/features/companion-home/index.mjs';
import { REPLY_TOOL, sentMessages } from '../home.mjs';

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

test('code decides from the mapping: every point needs a line, and the first line must answer one', () => {
  const lines = ['네 19일부터 바뀌었습니다', '거절되면 개발실에 바로 뜨게 바꾸는 중'];
  assert.equal(parseVerdict(mapping([]), { lines }).ok, true, 'nothing asked: chat passes');
  const options = parseVerdict(mapping([{ q: '문구를 띄우나, 신청건을 만드나', options: ['문구', '신청건'], line: 0, how: 'none' }]), { lines });
  assert.equal(options.ok, false);
  assert.match(refusalText(options), /문구 \/ 신청건/);
  const buried = parseVerdict(mapping([{ q: '그 칸이 왜 떴냐', line: 2, how: 'answer' }]), { lines });
  assert.equal(buried.ok, false, 'the answer on line 2 behind something else is refused');
  assert.match(refusalText(buried), /first line says instead/);
  assert.equal(parseVerdict(mapping([{ q: '왜 떴냐', line: 9, how: 'answer' }]), { lines }).ok, false, 'a line the draft does not have is no answer');
  const promise = parseVerdict(mapping([{ q: '처리됐어?', line: 1, how: 'promise' }]), { lines });
  assert.deepEqual([promise.ok, promise.cleared], [true, false]);
  const answered = parseVerdict(mapping([{ q: '처리됐어?', line: 1, how: 'answer' }, { q: '왜?', line: 2, how: 'answer' }]), { lines });
  assert.deepEqual([answered.ok, answered.cleared], [true, true]);
  assert.throws(() => parseVerdict('잘 모르겠어', { lines }), /JSON/);
  assert.throws(() => parseVerdict(mapping([{ q: '', line: 0, how: 'none' }]), { lines }), /malformed/, 'a blank ask is not "nothing asked"');
  assert.throws(() => parseVerdict(mapping([{ q: '왜 떴냐', line: 1, how: 'none' }]), { lines }), /malformed/, 'a line with how none contradicts itself');
  assert.throws(() => parseVerdict(mapping([{ q: '왜 떴냐', line: 0, how: 'answer' }]), { lines }), /malformed/);
});

test('a short lead-in the model reads as empty lets line 2 answer; a short line with its own claim does not', () => {
  const ask = [{ q: '7번 8번이 뭔 상황이야', kind: 'question', line: 2, how: 'answer' }];
  assert.equal(parseVerdict(mapping(ask, { lead_in: true }), { lines: ['쉽게 말하면 이거야.', '7번: 출금을 접어야 할 때야'] }).ok, true);
  assert.equal(parseVerdict(mapping(ask, { lead_in: false }), { lines: ['네 19일부터 바뀌었습니다', '거절되면 개발실에 뜨게 바꾸는 중'] }).ok, false);
  assert.equal(parseVerdict(mapping(ask, { lead_in: true }), { lines: ['응, 이상하게 한 거 맞아. 오빠가 자는 동안 내가 이렇게 했어:', '- CSR 칸'] }).ok, false,
    'a long first line is never a lead-in, whatever the model says');
});

test('a work order next to an answered question does not hold the reply back; alone, or with options, it does', () => {
  const lines = ['인피녹스가 묶인 건 아니야, 출금 통장이 비어서 그래', '윤종호 통장을 겸용으로 바꾸면 돼'];
  const why = { q: '인피녹스 출금이 왜 안 되냐', kind: 'question', line: 1, how: 'answer' };
  const order = { q: '업체 방 확인하고 마저 하자', kind: 'request', line: 0, how: 'none' };
  assert.equal(parseVerdict(mapping([why, order]), { lines }).ok, true);
  assert.equal(parseVerdict(mapping([order]), { lines }).ok, false);
  assert.equal(parseVerdict(mapping([why, { ...order, options: ['문구', '신청건'] }]), { lines }).ok, false);
});

/** A model registry that answers from `answer(model)`: a string, or an Error to throw. */
function registryOf(answer, { signedOut = [] } = {}) {
  const calls = [];
  return { calls,
    find: (provider, id) => ({ provider, id }),
    hasConfiguredAuth: (model) => !signedOut.includes(model.id),
    async complete(model, context) {
      calls.push({ id: model.id, user: context.messages[0].content[0].text, system: context.systemPrompt });
      const out = answer(model);
      if (out instanceof Error) throw out;
      return { content: [{ type: 'text', text: out }] };
    } };
}
const waiting = [user('화면에 그런 칸이 왜 떴냐')];
const [first, last] = ANSWER_CHECK_MODELS;

test('no model call when nothing waits; one call when something does, with every waiting line and the draft', async () => {
  const quiet = registryOf(() => mapping([]));
  assert.deepEqual(await checkReply({ entries: [wake()], draft: '좋은 아침!', registry: quiet, now: T0 }), { checked: false });
  assert.equal(quiet.calls.length, 0);
  const registry = registryOf(() => mapping([{ q: '칸이 왜 떴냐', line: 0, how: 'none' }]));
  const result = await checkReply({ entries: [user('CSR이 짝 없는 탭이 생겼대'), ...waiting], draft: '새로고침하면 없어져', registry, now: T0 });
  assert.deepEqual([result.checked, result.ok], [true, false]);
  assert.equal(registry.calls.length, 1);
  assert.match(registry.calls[0].user, /1\. CSR이 짝 없는 탭이 생겼대\n2\. 화면에 그런 칸이 왜 떴냐/);
  assert.match(registry.calls[0].user, /1: 새로고침하면 없어져/);
  assert.ok(first.map((model) => model.id).includes(registry.calls[0].id), 'the first tier answers first');
});

test('a failing account hands over to the other, then to the next tier; when none answers the reply is refused, not passed', async () => {
  const firstIds = first.map((model) => model.id);
  const handed = registryOf((model) => firstIds.includes(model.id) ? new Error('429 out of quota') : mapping([]));
  const passed = await checkReply({ entries: waiting, draft: '출금 문자가 신청이랑 안 이어지면 그 칸에 모여', registry: handed, now: T0 });
  assert.deepEqual([passed.ok, handed.calls.length], [true, 3]);
  assert.ok(last.map((model) => model.id).includes(passed.model.split('/')[1]));
  const down = registryOf(() => new Error('overloaded'), { signedOut: [last[1].id] });
  const refused = await checkReply({ entries: waiting, draft: '출금 문자가 신청이랑 안 이어지면 그 칸에 모여', registry: down, now: T0 });
  assert.deepEqual([refused.ok, refused.unavailable], [false, true]);
  assert.equal(refused.errors.length, 4);
  assert.match(refused.errors.join(' '), /not signed in/);
  const garbled = registryOf(() => '음 글쎄');
  assert.equal((await checkReply({ entries: waiting, draft: 'x', registry: garbled, now: T0 })).unavailable, true, 'an answer that is not the mapping is no pass');
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
  assert.match(registry.calls[0].user, /이거도 동문서답 아니야\?/);
});

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-answer-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { HOME: dir, RUBATO_COMPANION_HOME: path.join(dir, 'companion') };
}
function homeTools(options) {
  const tools = new Map();
  const handlers = new Map();
  createCompanionHomeFactories(options)[0].factory({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler), sendMessage() {} });
  tools.handlers = handlers;
  return tools;
}

test('a held reply reaches nobody: no messenger send, no sent record, an error result naming what was missed', async (t) => {
  const env = { ...sandbox(t), RUBATO_COMPANION_TELEGRAM: '1' };
  const sends = [];
  const reply = homeTools({ env, sessionLink: { telegramSend: async (request) => { sends.push(request); return { state: 'sent', messageIds: [1] }; } } }).get(REPLY_TOOL);
  const ctxWith = (registry, entries = waiting) => ({ sessionManager: { getBranch: () => entries, getSessionId: () => 's' }, modelRegistry: registry });
  const refuse = registryOf(() => mapping([{ q: '칸이 왜 떴냐', line: 0, how: 'none' }], { hint: '칸이 뭔지 첫 줄에' }));
  await assert.rejects(reply.execute('a', { text: '새로고침하면 없어져', voice: true }, undefined, undefined, ctxWith(refuse)), /Not delivered[\s\S]*칸이 왜 떴냐[\s\S]*칸이 뭔지 첫 줄에/);
  await assert.rejects(reply.execute('b', { text: '새로고침하면 없어져' }, undefined, undefined, ctxWith(registryOf(() => new Error('down')))), /could not run/);
  await assert.rejects(reply.execute('c', { text: '새로고침하면 없어져' }, undefined, undefined, { sessionManager: {} }), /no conversation to read/);
  assert.deepEqual([sends.length, sentMessages({ env }).length], [0, 0]);
  const promise = await reply.execute('d', { text: '확인해볼게' }, undefined, undefined, ctxWith(registryOf(() => mapping([{ q: '왜 떴냐', line: 1, how: 'promise' }]))));
  assert.deepEqual(promise.details.answerCheck.cleared, false, 'the next reply is checked against the same question');
  const proactive = await reply.execute('e', { text: '좋은 아침!' }, undefined, undefined, ctxWith(registryOf(() => { throw new Error('must not be called'); }), [wake()]));
  assert.equal(proactive.details.answerCheck, undefined);
  assert.equal(sentMessages({ env }).length, 2);
  const heard = registryOf(() => mapping([{ q: '칸이 왜 떴냐', line: 0, how: 'none' }]));
  await assert.rejects(reply.execute('f', { text: '출금 문자가 짝을 못 찾으면 생기는 칸이야', voice: 'only', voice_text: '새로고침하면 없어져' },
    undefined, undefined, ctxWith(heard)), /Not delivered/);
  assert.match(heard.calls[0].user, /1: 새로고침하면 없어져/, 'a voice-only reply is checked as it is heard');
});

test('editing a message in the user\'s own Telegram chat is refused; another chat\'s edit is not this gate\'s', () => {
  const tools = homeTools({ env: { HOME: '/tmp/x', RUBATO_COMPANION_HOME: '/tmp/x/companion' } });
  const onCall = tools.handlers.get('tool_call');
  assert.deepEqual(onCall({ toolName: 'telegram_edit', input: { message_id: 3, text: '딴소리' } }, {}), { block: true, reason: OWN_CHAT_EDIT_REFUSAL });
  assert.deepEqual(onCall({ toolName: 'telegram_edit', input: { message_id: 3, text: '딴소리', to: 'user' } }, {}), { block: true, reason: OWN_CHAT_EDIT_REFUSAL });
  assert.equal(onCall({ toolName: 'telegram_edit', input: { message_id: 3, text: '정정', to: 'CSR' } }, {}), undefined);
});
