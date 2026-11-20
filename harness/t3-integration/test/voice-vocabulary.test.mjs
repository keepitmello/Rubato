// Dictation that works for whoever uses it: the language they speak, the names they say (the user
// dream's list), and the words dictation got wrong that they fixed before sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleVoiceRequest } from '../src/voice/http.mjs';
import { createVoiceRuntime } from '../src/voice/runtime.mjs';
import { normalizeLanguages, systemLanguages, updateVoiceConfig, voiceLanguages, voiceSettingsStatus } from '../src/voice/settings.mjs';
import { correctionPairs, correctionsPath, dictationTerms, dictationTermsPath, parseDictationTerms, recordCorrections } from '../src/voice/vocabulary.mjs';
import { fixture } from './voice-fixture.mjs';

const memoryHome = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-voice-vocab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { env: { RUBATO_MEMORY_HOME: dir, HOME: dir }, dir };
};

test("the user dream's list becomes hints, and nothing breaks without one", (t) => {
  const { env } = memoryHome(t);
  assert.deepEqual(dictationTerms(env), []);
  mkdirSync(path.dirname(dictationTermsPath(env)), { recursive: true });
  writeFileSync(dictationTermsPath(env), [
    '---', 'description: Names and terms the user says that dictation must spell right', '---', '',
    '## Conclusion', '- INFINOX', '- `VaultOne`', '- 출금', '- <bad>', '- INFINOX', '',
    '## Evidence', '- 2026-11-20 · `INFINOX` · project `hash-game` · "INFINOX 입금"', '',
  ].join('\n'));
  assert.deepEqual(dictationTerms(env), ['INFINOX', 'VaultOne', '출금']);
  assert.deepEqual(parseDictationTerms('- outside the list\n## Conclusion\n- in\n## Other\n- out'), ['in']);
});

test('only the words that were fixed are kept, not additions, deletions or a rewrite', () => {
  assert.deepEqual(correctionPairs('출근 한도는 천만 원으로 올려 줘', '출금 한도는 천만 원으로 올려 줘.'), [{ from: '출근', to: '출금' }]);
  assert.deepEqual(correctionPairs('로바토 컴패니언 입력창', '루바토 컴패니언 입력창도 같이'), [{ from: '로바토', to: '루바토' }]);
  assert.deepEqual(correctionPairs('같은 말', '같은 말'), []);
  assert.deepEqual(correctionPairs('완전히 다른 문장을 받아썼는데', '그냥 새로 쓴 메시지야 이건'), []);
  assert.deepEqual(correctionPairs('세뇨한테 보내', '앞에 붙인 말 Segno한테 보내'), [{ from: '세뇨한테', to: 'Segno한테' }]);
  assert.deepEqual(correctionPairs('테이프 스크립트 빌드가 깨져서', 'TypeScript 빌드가 깨져서'), [{ from: '테이프 스크립트', to: 'TypeScript' }]);
});

test('corrections land beside the user memory, one line per fix', (t) => {
  const { env } = memoryHome(t);
  const recorded = recordCorrections({ heard: ['출근 한도 올려 줘', '그대로인 문장'], sent: '출금 한도 올려 줘 그대로인 문장' },
    { env, now: () => Date.parse('2026-11-20T09:00:00Z') });
  assert.equal(recorded, 1);
  const lines = readFileSync(correctionsPath(env), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ at: '2026-11-20T09:00:00.000Z', from: '출근', to: '출금' }]);
  assert.match(correctionsPath(env), /agents\/user\.shared\/runtime\/dictation-corrections\.jsonl$/);
});

test('POST /rubato/voice/corrections takes what the composer saw, from the desktop or the phone', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const seen = [];
  const response = await handleVoiceRequest(new Request('http://local/rubato/voice/corrections', {
    method: 'POST', body: JSON.stringify({ heard: ['출근'], sent: '출금' }), headers: { 'content-type': 'application/json' },
  }), { service: f.service, token: 'x'.repeat(32), desktopAuthenticated: true, corrections: (input) => { seen.push(input); return { recorded: 1 }; } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { recorded: 1 });
  assert.deepEqual(seen, [{ heard: ['출근'], sent: '출금' }]);
});

test("dictation listens for the Mac's own languages unless Settings names others", (t) => {
  assert.deepEqual(normalizeLanguages(['ko-KR', 'en_US', 'ja', 'ko', 'nonsense-word', 'x']), ['ko', 'en', 'ja']);
  assert.deepEqual(normalizeLanguages('fr, de en'), ['fr', 'de', 'en']);
  const system = systemLanguages();
  assert.ok(system.includes('en'), 'English is always heard: technical words are spoken in it');
  assert.deepEqual(voiceLanguages({}), system);
  assert.deepEqual(voiceLanguages({ languages: ['ja'] }), ['ja']);
  const { dir } = memoryHome(t);
  const configPath = path.join(dir, 'voice.json');
  updateVoiceConfig(configPath, { openaiApiKey: 'sk-test-0123456789abcdefghij', languages: 'ja, en' });
  assert.deepEqual(voiceSettingsStatus(configPath, {}).languages, ['ja', 'en']);
  assert.equal(voiceSettingsStatus(configPath, {}).languagesSaved, true);
  updateVoiceConfig(configPath, { languages: null });
  assert.deepEqual(voiceSettingsStatus(configPath, {}).languages, system);
  assert.throws(() => updateVoiceConfig(configPath, { languages: '!!' }), /language codes/);
});

test("the live key carries the person's languages and terms", async (t) => {
  const { env, dir } = memoryHome(t);
  mkdirSync(path.dirname(dictationTermsPath(env)), { recursive: true });
  writeFileSync(dictationTermsPath(env), '## Conclusion\n- INFINOX\n');
  const configPath = path.join(dir, 'voice.json');
  updateVoiceConfig(configPath, { openaiApiKey: 'sk-test-0123456789abcdefghij', languages: ['ja', 'en'] });
  const runtime = createVoiceRuntime({ configPath, statePath: path.join(dir, 'voice-state.json'), env,
    environmentId: 'env', readThread: async () => null, readProject: async () => null, listThreads: async () => [],
    dispatch: async () => ({ runs: [] }), readRun: async () => null, appendNotice: async () => {} });
  t.after(() => runtime.close());
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ value: 'ek_1', expires_at: 1 }); };
  t.after(() => { globalThis.fetch = realFetch; });
  const response = await runtime.handle(new Request('http://local/rubato/voice/live', { method: 'POST' }), true);
  assert.equal(response.status, 200);
  const transcription = sent[0].session.audio.input.transcription;
  assert.deepEqual(transcription.languages, ['ja', 'en']);
  assert.match(transcription.prompt, /They speak Japanese and English\./);
  assert.ok(transcription.keywords.includes('INFINOX'));
  assert.ok(transcription.keywords.includes('Rubato'));
});
