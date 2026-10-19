import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceRuntime } from '../src/voice/runtime.mjs';
import {
  DEFAULT_VOICE_MODEL, handleVoiceSettingsRequest, updateVoiceConfig, voiceSettingsStatus,
} from '../src/voice/settings.mjs';
import { handleVoiceRequest } from '../src/voice/http.mjs';
import { fixture } from './voice-fixture.mjs';

const tempConfig = () => path.join(mkdtempSync(path.join(tmpdir(), 'voice-settings-')), 'voice.json');
const KEY = 'sk-test-0123456789abcdefghij';
const settingsRequest = (action, body = {}) => new Request(`http://local/rubato/voice/settings/${action}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
});

test('saving a key writes a private file with a token and the default model, and no machine path', () => {
  const configPath = tempConfig();
  const written = updateVoiceConfig(configPath, { openaiApiKey: KEY });
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved, written);
  assert.equal(saved.model, DEFAULT_VOICE_MODEL);
  assert.equal(saved.openaiApiKey, KEY);
  assert.ok(saved.token.length >= 32);
  assert.equal('module' in saved, false);
  // The token stays across saves until it is rotated.
  assert.equal(updateVoiceConfig(configPath, { model: 'whisper-1' }).token, saved.token);
  assert.notEqual(updateVoiceConfig(configPath, { rotateToken: true }).token, saved.token);
});

test('status never carries the key, and says where the key comes from', () => {
  const configPath = tempConfig();
  assert.deepEqual(voiceSettingsStatus(configPath, {}).apiKey, { source: null, preview: null });
  assert.equal(voiceSettingsStatus(configPath, {}).ready, false);
  updateVoiceConfig(configPath, { model: DEFAULT_VOICE_MODEL });
  const fromEnvironment = voiceSettingsStatus(configPath, { OPENAI_API_KEY: KEY });
  assert.equal(fromEnvironment.apiKey.source, 'environment');
  assert.equal(fromEnvironment.ready, true);
  updateVoiceConfig(configPath, { openaiApiKey: KEY });
  const saved = voiceSettingsStatus(configPath, {});
  assert.equal(saved.apiKey.source, 'settings');
  assert.equal(saved.apiKey.preview, 'sk-…ghij');
  assert.equal(JSON.stringify(saved).includes(KEY), false);
  updateVoiceConfig(configPath, { openaiApiKey: null });
  assert.equal(voiceSettingsStatus(configPath, {}).apiKey.source, null);
});

test('the settings route rejects a partial key by field and leaves the file as it was', async () => {
  const configPath = tempConfig();
  const response = await handleVoiceSettingsRequest(settingsRequest('save', { openaiApiKey: 'sk-short' }), { configPath, env: {} });
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error.field, 'openaiApiKey');
  assert.equal(voiceSettingsStatus(configPath, {}).model, null);
  const saved = await (await handleVoiceSettingsRequest(settingsRequest('save', { openaiApiKey: KEY }), { configPath, env: {} })).json();
  assert.equal(saved.ready, true);
});

test('a broken voice.json is reported, not overwritten', async () => {
  const configPath = tempConfig();
  writeFileSync(configPath, '{ not json');
  assert.equal(voiceSettingsStatus(configPath, {}).configError, 'invalid');
  const response = await handleVoiceSettingsRequest(settingsRequest('save', { openaiApiKey: KEY }), { configPath, env: {} });
  assert.equal(response.status, 409);
  assert.equal(readFileSync(configPath, 'utf8'), '{ not json');
});

test('the runtime picks up a saved key without restarting', async (t) => {
  const configPath = tempConfig();
  const runtime = createVoiceRuntime({
    configPath, statePath: path.join(path.dirname(configPath), 'voice-state.json'), env: {},
    environmentId: 'env', readThread: async () => null, readProject: async () => null, listThreads: async () => [],
    dispatch: async () => ({ runs: [] }), readRun: async () => null, appendNotice: async () => {},
  });
  t.after(() => runtime.close());
  const open = () => runtime.handle(new Request('http://local/rubato/voice/session', {
    method: 'POST', body: JSON.stringify({ mode: 'draft' }), headers: { 'content-type': 'application/json' },
  }), true);

  assert.equal((await open()).status, 503);
  await runtime.handleSettings(settingsRequest('save', { openaiApiKey: KEY }));
  const session = await open();
  assert.equal(session.status, 200);
  const { token } = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(runtime.acceptsToken(`Bearer ${token}`), true);
  await runtime.handleSettings(settingsRequest('rotate-token'));
  assert.equal(runtime.acceptsToken(`Bearer ${token}`), false);
});

test('a browser upload without a filename header is named after its content type, and POST cancel closes it', async (t) => {
  let uploaded;
  const f = fixture({ transcriber: async (input) => { uploaded = input; return { text: '초안' }; } });
  t.after(() => f.service.close());
  const options = { service: f.service, token: 'x'.repeat(32), desktopAuthenticated: true };
  const start = await handleVoiceRequest(new Request('http://local/rubato/voice/session', {
    method: 'POST', body: JSON.stringify({ mode: 'draft' }), headers: { 'content-type': 'application/json' },
  }), options);
  const { voiceSessionId } = await start.json();
  const transcribed = await handleVoiceRequest(new Request(`http://local/rubato/voice/session/${voiceSessionId}/transcribe`, {
    method: 'POST', body: 'audio', headers: { 'content-type': 'audio/webm;codecs=opus' },
  }), options);
  assert.equal((await transcribed.json()).text, '초안');
  assert.equal(uploaded.filename, 'voice.webm');
  const cancelled = await handleVoiceRequest(new Request(`http://local/rubato/voice/session/${voiceSessionId}/cancel`, {
    method: 'POST',
  }), options);
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
});
