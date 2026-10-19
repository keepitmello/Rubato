import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionService, handleCompanionRequest } from '../src/companion/service.mjs';
import { writeState } from '../../companion/companion.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rubato-companion-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
  const service = createCompanionService({ env, defaultsDir });
  const post = async (action, body = {}) => {
    const response = await handleCompanionRequest(service, new Request(`http://local/rubato/companion/${action}`,
      { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { env, post };
}

test('status starts off with no conversation, and turning it on is a saved setting', async (t) => {
  const { env, post } = await setup(t);
  const first = await post('status');
  assert.equal(first.status, 200);
  assert.equal(first.body.settings.enabled, false);
  assert.equal(first.body.sessionId, null);
  assert.equal(first.body.home, env.RUBATO_COMPANION_HOME);
  const saved = await post('save-settings', { patch: { enabled: true, heartbeat: { everyMinutes: 30 } } });
  assert.deepEqual(saved.body.settings.heartbeat, { enabled: true, everyMinutes: 30 });
  assert.equal(saved.body.settings.enabled, true);
  writeState({ sessionId: 'segno' }, env);
  assert.equal((await post('status')).body.sessionId, 'segno', 'the conversation the keeper recorded');
  const refused = await post('save-settings', { patch: { heartbeat: { everyMinutes: 3 } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'invalid');
});

test('pieces list every piece with its default, and a saved piece is the person\'s until cleared', async (t) => {
  const { post } = await setup(t);
  const { body } = await post('pieces');
  assert.deepEqual(body.pieces.map((piece) => piece.id), ['preamble', 'soul', 'identity', 'user', 'companion', 'tools']);
  assert.ok(body.pieces.every((piece) => piece.defaultText.length > 0));
  const saved = await post('save-piece', { id: 'user', text: 'I sell shoes.' });
  assert.equal(saved.body.pieces.find((piece) => piece.id === 'user').personalText, 'I sell shoes.');
  const cleared = await post('save-piece', { id: 'user', text: '' });
  assert.equal(cleared.body.pieces.find((piece) => piece.id === 'user').personalText, undefined);
  const tools = await post('save-piece', { id: 'tools', text: 'mine' });
  assert.equal(tools.status, 400);
  assert.equal((await post('nope')).status, 404);
});
