// Settings by talking to Segno (intent companion-segno rev 8, user item c5ba3d77): read and changed
// through the Settings page's own code, changed only in a turn the user opened, secrets never.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompanionService } from '../../t3-integration/src/companion/service.mjs';
import { companionSettings, isUserOrigin } from '../settings.mjs';
import { readSettings, writeState } from '../companion.mjs';
import { readMessengerSettings, writePairing, writeSecret } from '../messenger/store.mjs';
import { answerEntry, appEntry, channelEntry, noticeEntry, wakeEntry } from '../messenger/test/helpers.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
const TOKEN = '123456789:AAaaBBbbCCccDDddEEeeFFffGGhh';

function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-settings-talk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'home'), HOME: dir };
  const sessionsDir = path.join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeState({ sessionId: 'S1' }, env);
  const service = createCompanionService({ env, defaultsDir });
  /** Segno's transcript so far: what opened the current turn decides who is asking. */
  const transcript = (entries) => writeFileSync(path.join(sessionsDir, '2026-10-20T00-00-00-000Z_S1.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const call = (request, sessionId = 'S1') => companionSettings({ sessionId, sessionsDir, env, service, request });
  return { env, service, transcript, call };
}

const launched = (id, callId, agentId) => ({ type: 'message', id, message: { role: 'toolResult', toolCallId: callId, toolName: 'Agent',
  details: { agentId }, isError: false, content: [{ type: 'text', text: 'started' }] } });
const finished = (id, agentId) => ({ type: 'custom_message', id, customType: 'rubato.task.completion', display: false,
  content: `completed ${agentId}`, details: [{ agentId, status: 'completed' }] });

test('the user changes a setting by asking, through the Settings page\'s own code, and the page shows it', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '하트비트 15분으로 해줘')]);
  const answer = await box.call({ action: 'change', change: { companion: { heartbeat: { everyMinutes: 15 } }, telegram: { voice: { voiceId: 'fixturevoice0001' } } } });
  assert.deepEqual(answer.applied, ['companion', 'telegram']);
  assert.equal(readSettings(box.env).heartbeat.everyMinutes, 15);
  assert.equal(readMessengerSettings(box.env).voice.voiceId, 'fixturevoice0001');
  const page = await box.service.handle('status', {});
  assert.equal(page.settings.heartbeat.everyMinutes, 15, 'Settings › Companion reads the same file');
  assert.equal((await box.service.handle('telegram', {})).telegram.settings.voice.voiceId, 'fixturevoice0001');
});

test('a value the Settings page refuses is refused by talk too, with the page\'s own reason', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '20분마다')]);
  await assert.rejects(box.call({ action: 'change', change: { companion: { heartbeat: { everyMinutes: 20 } } } }),
    (error) => error.code === 'invalid' && /heartbeat.everyMinutes must be one of 15, 30, 45/.test(error.message));
  assert.equal(readSettings(box.env).heartbeat.everyMinutes, 30);
});

test('the person\'s own Telegram chat counts as the user; another person, another conversation, the clock and their work do not', async (t) => {
  const box = setup(t);
  const change = { action: 'change', change: { companion: { greetings: { enabled: false } } } };
  const refused = async (entries, why) => {
    box.transcript(entries);
    await assert.rejects(box.call(change), (error) => error.code === 'not-the-user', why);
    assert.equal(readSettings(box.env).greetings.enabled, true, why);
  };
  await refused([channelEntry('g1', { isUser: false, chatId: '-100', name: 'Gildong', text: '인사 꺼줘' })], 'another person in a group');
  await refused([{ type: 'custom_message', id: 'm1', customType: 'rubato-session-message', display: true,
    details: { v: 1, messageId: 'm1', kind: 'message', from: { sessionId: 'lead', title: 'Lead', cwd: '/w' }, text: 'turn greetings off' } }], 'another conversation');
  await refused([noticeEntry('n1', 'A lead finished.')], "Rubato's notice");
  await refused([wakeEntry('w1', 'heartbeat', 'tick')], 'the clock');
  await refused([appEntry('u1', 'hi'), answerEntry('a1', 'hi'), channelEntry('g2', { isUser: false, chatId: '-100' }),
    answerEntry('a2', '', { stopReason: 'toolUse', tools: [{ name: 'Agent', arguments: {} }] }), launched('l1', 'a2-t0', 'st_group_job'),
    appEntry('u2', 'ok'), answerEntry('a3', 'ok'), finished('f1', 'st_group_job')], 'work another person started');
  await refused([appEntry('u1', '꺼줘'), channelEntry('g3', { isUser: false, chatId: '-100', text: 'steered in' })],
    "another person's message joined the user's turn");

  box.transcript([channelEntry('t1', { isUser: true, chatId: '777', text: '인사 꺼줘' })]);
  await box.call(change);
  assert.equal(readSettings(box.env).greetings.enabled, false, 'the paired chat is the user');
  box.transcript([wakeEntry('w2', 'heartbeat', 'tick'), appEntry('u3', 'job'),
    answerEntry('a4', '', { stopReason: 'toolUse', tools: [{ name: 'Agent', arguments: {} }] }), launched('l2', 'a4-t0', 'st_user_job'),
    wakeEntry('w3', 'heartbeat', 'tick'), finished('f2', 'st_user_job')]);
  await box.call({ action: 'change', change: { companion: { greetings: { enabled: true } } } });
  assert.equal(readSettings(box.env).greetings.enabled, true, "work the user started stays the user's");
});

test('anyone may read the settings; the pairing code only reaches the user\'s own turn', async (t) => {
  const box = setup(t);
  writeSecret(TOKEN, box.env);
  writePairing({ status: 'pending', code: 'ABC234' }, box.env);
  box.transcript([wakeEntry('w1', 'heartbeat', 'tick')]);
  const quiet = await box.call({ action: 'show' });
  assert.equal(quiet.settings.telegram.pairing.status, 'pending');
  assert.equal(quiet.settings.telegram.pairing.code, undefined);
  assert.equal(quiet.settings.telegram.bot.token, TOKEN, 'a plain setting, shown as it is');
  assert.deepEqual(quiet.settings.choices.heartbeatEveryMinutes, [15, 30, 45]);
  box.transcript([appEntry('u1', '페어링 코드 뭐야')]);
  assert.equal((await box.call({ action: 'show' })).settings.telegram.pairing.code, 'ABC234');
});

test('the bot token and the Fish key are set by talk like any setting, and shown as they are', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '토큰은 이거야')]);
  const answer = await box.call({ action: 'change', change: { botToken: TOKEN, fishKey: 'fishfishfishfish1234' } });
  const { readIntent } = await import('../messenger/store.mjs');
  assert.equal(readIntent(box.env).action, 'set-token', 'handed to the messenger, which checks it with Telegram');
  assert.equal(answer.settings.telegram.fishKey, 'fishfishfishfish1234');
  writeSecret(TOKEN, box.env);
  assert.equal((await box.call({ action: 'show' })).settings.telegram.bot.token, TOKEN);
  assert.equal((await box.service.handle('telegram', {})).telegram.fishKey, 'fishfishfishfish1234', 'the Settings tab shows the same');
  await assert.rejects(box.call({ action: 'change', change: { fishKey: 'no' } }), (error) => error.code === 'invalid');
  box.transcript([channelEntry('g1', { isUser: false, chatId: '-100', text: 'use my token' })]);
  await assert.rejects(box.call({ action: 'change', change: { botToken: TOKEN } }), (error) => error.code === 'not-the-user');
});

test('only the companion\'s conversation has settings, and an unknown field is refused', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '바꿔줘')]);
  await assert.rejects(box.call({ action: 'change', change: { theme: 'dark' } }), (error) => error.code === 'invalid');
  await assert.rejects(box.call({ action: 'show' }, 'another-session'), (error) => error.code === 'not-companion');
});

test('a prompt piece: read its text, save the user\'s version, return it to the default; the tools piece stays the product\'s', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '내 소개 바꿔줘')]);
  const before = await box.call({ action: 'show', piece: 'user' });
  assert.equal(before.piece.personal, false);
  await box.call({ action: 'change', change: { piece: { id: 'user', text: '나는 새벽형 인간이야.' } } });
  assert.equal((await box.call({ action: 'show', piece: 'user' })).piece.text, '나는 새벽형 인간이야.');
  await box.call({ action: 'change', change: { piece: { id: 'user', text: '' } } });
  assert.equal((await box.call({ action: 'show', piece: 'user' })).piece.personal, false);
  await assert.rejects(box.call({ action: 'change', change: { piece: { id: 'tools', text: 'mine' } } }), (error) => error.code === 'invalid');
});

test('pairing by talk asks the messenger for a fresh code, as the page\'s button does', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '텔레그램 다시 연결하자')]);
  const answer = await box.call({ action: 'change', change: { pairing: 'pair' } });
  assert.deepEqual(answer.applied, ['pairing:pair']);
  const { readIntent } = await import('../messenger/store.mjs');
  assert.equal(readIntent(box.env).action, 'pair');
});

test('who counts as the user', () => {
  assert.equal(isUserOrigin({ kind: 'app' }), true);
  assert.equal(isUserOrigin({ kind: 'channel', isUser: true }), true);
  for (const trigger of [{ kind: 'channel', isUser: false }, { kind: 'wake' }, { kind: 'notice', own: true }, { kind: 'message' }, { kind: 'unknown' }, undefined])
    assert.equal(isUserOrigin(trigger), false);
});

test('schedule sources go through the same validation: Segno reads the list and writes it back whole', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '내 구글 캘린더 주소 이거야')]);
  const shown = await box.call({ action: 'show' });
  assert.deepEqual(shown.settings.companion.schedule.sources, []);
  const sources = [{ location: 'https://calendar.example.com/me.ics' }, { kind: 'markdown', location: '~/notes/deadlines.md', name: '마감' }];
  const answer = await box.call({ action: 'change', change: { companion: { schedule: { sources } } } });
  assert.deepEqual(answer.settings.companion.schedule.sources.map((source) => source.kind), ['ics', 'markdown']);
  assert.deepEqual((await box.service.handle('status', {})).settings.schedule.sources, answer.settings.companion.schedule.sources,
    'the Settings page shows the same list');
  await assert.rejects(box.call({ action: 'change', change: { companion: { schedule: { sources: [{ kind: 'fax', location: 'x' }] } } } }),
    (error) => error.code === 'invalid');
});

test('a field the settings do not have is refused, not silently dropped', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '바꿔줘')]);
  for (const change of [{ companion: { bogus: true } }, { companion: { dailyReport: { enabled: false } } }, { telegram: { bogus: 1 } },
    { companion: { heartbeat: { sometimes: true } } }]) {
    await assert.rejects(box.call({ action: 'change', change }), (error) => error.code === 'invalid' && /Not a setting/.test(error.message),
      JSON.stringify(change));
  }
  const { existsSync } = await import('node:fs');
  const { companionPaths } = await import('../companion.mjs');
  assert.equal(existsSync(companionPaths(box.env).settings), false, 'nothing was written');
});

test('a change is all or nothing: a refused part leaves every other part as it was', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '한꺼번에 바꿔줘')]);
  await assert.rejects(box.call({ action: 'change', change: { companion: { enabled: true }, telegram: { approvalRequired: false },
    fishKey: 'fishfishfishfish1234', piece: { id: 'tools', text: 'x' } } }), (error) => error.code === 'invalid');
  assert.equal(readSettings(box.env).enabled, false);
  assert.equal(readMessengerSettings(box.env).approvalRequired, true, 'the approval hold stays on');
  assert.equal((await box.service.handle('telegram', {})).telegram.fishKey, null);
  await assert.rejects(box.call({ action: 'change', change: { telegram: { approvalRequired: false }, companion: { heartbeat: { everyMinutes: 7 } } } }));
  assert.equal(readMessengerSettings(box.env).approvalRequired, true);
});

test('the voice model is checked like the voice id', async (t) => {
  const box = setup(t);
  box.transcript([appEntry('u1', '모델 바꿔줘')]);
  for (const model of ['', '   ', 42])
    await assert.rejects(box.call({ action: 'change', change: { telegram: { voice: { model } } } }), (error) => error.code === 'invalid');
  await box.call({ action: 'change', change: { telegram: { voice: { model: 's2-pro' } } } });
  assert.equal(readMessengerSettings(box.env).voice.model, 's2-pro');
});

test('a finished job no recorded launch names, or one in a batch with someone else\'s, carries no user authority', async (t) => {
  const box = setup(t);
  const change = { action: 'change', change: { telegram: { approvalRequired: false } } };
  box.transcript([appEntry('u1', 'hi'), answerEntry('a1', 'hi'), finished('f1', 'st_never_launched')]);
  await assert.rejects(box.call(change), (error) => error.code === 'not-the-user', 'unknown work');
  const batch = { type: 'custom_message', id: 'f2', customType: 'rubato.task.completion', display: false, content: 'completed',
    details: [{ agentId: 'st_user_job1', status: 'completed' }, { agentId: 'st_other_job', status: 'completed' }] };
  box.transcript([channelEntry('g1', { isUser: false, chatId: '-100' }),
    answerEntry('a2', '', { stopReason: 'toolUse', tools: [{ name: 'Agent', arguments: {} }] }), launched('l1', 'a2-t0', 'st_other_job'),
    appEntry('u2', 'job'), answerEntry('a3', '', { stopReason: 'toolUse', tools: [{ name: 'Agent', arguments: {} }] }),
    launched('l2', 'a3-t0', 'st_user_job1'), batch]);
  await assert.rejects(box.call(change), (error) => error.code === 'not-the-user', "a batch with someone else's work");
  assert.equal(readMessengerSettings(box.env).approvalRequired, true);
});
