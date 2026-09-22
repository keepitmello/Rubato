import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createVoiceHttpServer, handleVoiceRequest } from '../src/voice/http.mjs';
import { transcribeAudio } from '../src/voice/transcribe.mjs';
import { fixture } from './voice-fixture.mjs';

test('real HTTP: session → recording upload → edited submit → pinned conversation', async (t) => {
  let uploaded;
  const f = fixture({ transcriber: async (input) => { uploaded = input; return { text: '초안' }; } });
  const token = 'test-voice-token-'.repeat(3);
  const server = createVoiceHttpServer({ service: f.service, token });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await f.service.close(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/rubato/voice/session`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base, { method: 'POST' })).status, 401);
  f.view();
  const s = await (await fetch(base, { method: 'POST', headers, body: '{}' })).json();
  f.view('b'); // Target changes after session capture, never after recording.
  const form = new FormData(); form.append('file', new Blob(['audio'], { type: 'audio/mp4' }), 'recording.m4a');
  const transcript = await (await fetch(`${base}/${s.voiceSessionId}/transcribe`, {
    method: 'POST', headers: { authorization: headers.authorization }, body: form,
  })).json();
  assert.equal(transcript.text, '초안');
  assert.equal(uploaded.filename, 'recording.m4a');
  assert.equal(uploaded.audio.toString(), 'audio');
  const input = { method: 'POST', headers, body: JSON.stringify({ text: '교정된 문장' }) };
  const result = await (await fetch(`${base}/${s.voiceSessionId}/submit`, input)).json();
  await fetch(`${base}/${s.voiceSessionId}/submit`, input);
  assert.equal(result.deepLink, 't3code://threads/env/a');
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].message.text, '교정된 문장');
});

test('desktop authentication is limited to draft sessions, never mobile submission', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const options = { service: f.service, token: 'x'.repeat(32), desktopAuthenticated: true };
  const request = (data) => new Request('http://local/rubato/voice/session', {
    method: 'POST', body: JSON.stringify(data), headers: { 'content-type': 'application/json' },
  });
  assert.equal((await handleVoiceRequest(request({ mode: 'mobile' }), options)).status, 403);
  const draft = await (await handleVoiceRequest(request({ mode: 'draft' }), options)).json();
  assert.equal(draft.target, 'draft');
  const mobile = await f.service.startSession();
  assert.equal((await handleVoiceRequest(new Request(`http://local/rubato/voice/session/${mobile.voiceSessionId}`), options)).status, 403);
});

test('an older model gets the singular language, the glossary, the filename and the model', async () => {
  const result = await transcribeAudio({ apiKey: 'secret-key', model: 'whisper-1',
    audio: Buffer.from('audio'), filename: 'speech.m4a', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options.body.get('model'), 'whisper-1');
      assert.equal(options.body.get('language'), 'ko');
      assert.equal(options.body.get('languages'), null);
      assert.match(options.body.get('prompt'), /Rubato/);
      assert.equal(options.body.get('file').name, 'speech.m4a');
      return Response.json({ text: 'Rubato 확인해줘' });
    } });
  assert.equal(result.text, 'Rubato 확인해줘');
});

test('gpt-transcribe gets bracketed languages and keywords, and plain text is read as the transcript', async () => {
  const result = await transcribeAudio({ apiKey: 'secret-key', model: 'gpt-transcribe',
    audio: Buffer.from('audio'), fetchImpl: async (url, options) => {
      assert.equal(options.body.get('language'), null);
      assert.deepEqual(options.body.getAll('languages[]'), ['ko', 'en']);
      assert.ok(options.body.getAll('keywords[]').includes('Rubato'));
      // 힌트는 keywords 로 가므로 프롬프트에 같은 목록이 겹쳐 들어가지 않는다.
      assert.doesNotMatch(options.body.get('prompt'), /Spellings to prefer/);
      assert.equal(options.body.get('response_format'), null);
      return new Response('그냥 텍스트로 온 전사문');
    } });
  assert.equal(result.text, '그냥 텍스트로 온 전사문');
});

test('a hint that the provider would reject is dropped instead of failing the request', async () => {
  await transcribeAudio({ apiKey: 'secret-key', model: 'gpt-transcribe',
    audio: Buffer.from('audio'), hints: ['Rubato', 'bad\nline', '<tag>', ''],
    fetchImpl: async (url, options) => {
      assert.deepEqual(options.body.getAll('keywords[]'), ['Rubato']);
      return Response.json({ text: 'ok' });
    } });
});
