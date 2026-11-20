import test from 'node:test';
import assert from 'node:assert/strict';
import { handleVoiceRequest } from '../src/voice/http.mjs';
import {
  LIVE_CALLS_URL, LIVE_SECRET_TTL_SECONDS, LIVE_TRANSCRIPTION_DELAY, LIVE_TRANSCRIPTION_MODEL, mintLiveTranscription,
} from '../src/voice/live.mjs';
import { TRANSCRIPTION_INSTRUCTIONS } from '../src/voice/transcribe.mjs';
import { fixture } from './voice-fixture.mjs';

const okSecret = (seen) => async (url, options) => {
  seen.push({ url, options, body: JSON.parse(options.body) });
  return Response.json({
    value: 'ek_test', expires_at: 1_795_000_000,
    session: { audio: { input: { transcription: { model: LIVE_TRANSCRIPTION_MODEL } } } },
  });
};

test('the Mac asks OpenAI for a short-lived transcription key and hands back only that key', async () => {
  const seen = [];
  const minted = await mintLiveTranscription({ apiKey: 'sk-real', fetchImpl: okSecret(seen) });
  assert.deepEqual(minted, {
    clientSecret: 'ek_test', expiresAt: 1_795_000_000_000, model: LIVE_TRANSCRIPTION_MODEL, callsUrl: LIVE_CALLS_URL,
  });
  const [{ url, options, body }] = seen;
  assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(options.headers.authorization, 'Bearer sk-real');
  assert.deepEqual(body.expires_after, { anchor: 'created_at', seconds: LIVE_SECRET_TTL_SECONDS });
  assert.equal(body.session.type, 'transcription');
  const transcription = body.session.audio.input.transcription;
  assert.equal(transcription.model, LIVE_TRANSCRIPTION_MODEL);
  assert.equal(transcription.prompt, TRANSCRIPTION_INSTRUCTIONS);
  assert.deepEqual(transcription.languages, ['ko', 'en']);
  // Words reach the screen about 0.4 s after they are said instead of about 1 s (live.mjs).
  assert.equal(transcription.delay, LIVE_TRANSCRIPTION_DELAY);
  assert.equal(LIVE_TRANSCRIPTION_DELAY, 'minimal');
  assert.ok(transcription.keywords.includes('Rubato') && transcription.keywords.includes('루바토'));
  // A live-only model takes no server turn detection; it streams words as they are heard.
  assert.equal(body.session.audio.input.turn_detection, undefined);
});

test('POST /rubato/voice/live answers the desktop and the phone, nothing else', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const live = () => mintLiveTranscription({ apiKey: 'sk-real', fetchImpl: okSecret([]) });
  const ask = (method, options) => handleVoiceRequest(new Request('http://local/rubato/voice/live', { method }),
    { service: f.service, token: 'x'.repeat(32), live, ...options });
  const desktop = await ask('POST', { desktopAuthenticated: true });
  assert.equal(desktop.status, 200);
  assert.equal((await desktop.json()).clientSecret, 'ek_test');
  assert.equal(desktop.headers.get('cache-control'), 'no-store');
  assert.equal((await ask('POST', {})).status, 401);
  assert.equal((await ask('GET', { desktopAuthenticated: true })).status, 404);
});

test('a missing or rejected key comes back as the code Settings can fix', async (t) => {
  const f = fixture(); t.after(() => f.service.close());
  const ask = async (live) => {
    const response = await handleVoiceRequest(new Request('http://local/rubato/voice/live', { method: 'POST' }),
      { service: f.service, token: 'x'.repeat(32), live, desktopAuthenticated: true });
    return [response.status, (await response.json()).error.code];
  };
  assert.deepEqual(await ask(() => mintLiveTranscription({ apiKey: null })), [503, 'missing-api-key']);
  const rejected = async () => new Response('{"error":{"message":"bad key sk-real"}}', { status: 401 });
  assert.deepEqual(await ask(() => mintLiveTranscription({ apiKey: 'sk-real', fetchImpl: rejected })), [502, 'api-key-rejected']);
});
