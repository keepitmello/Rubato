// The Add flow's model choice through the route both apps call (intent companion-agy-parity rev 2):
// `create` takes an optional { instanceId, model }, keeps it in the registry entry, and the list shows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanionService, handleCompanionRequest } from '../src/companion/service.mjs';
import { companionModelSelection } from '../../companion/registry.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');
const HYDROGEN = { instanceId: 'antigravity', model: 'gemini-4-hydrogen' };

function setup(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-companion-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, RUBATO_COMPANIONS_FILE: path.join(root, '.rubato', 'companions.json') };
  const service = createCompanionService({ env, defaultsDir, telegram: false, listSessions: async () => [] });
  const post = async (action, body = {}) => {
    const response = await handleCompanionRequest(service, new Request(`http://local/rubato/companion/${action}`,
      { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { env, post };
}

test('create with a model choice keeps it; create without one is the same as before', async (t) => {
  const { env, post } = setup(t);
  const plain = await post('create');
  const chosen = await post('create', { modelSelection: HYDROGEN });
  assert.equal(plain.status, 200);
  assert.equal(chosen.status, 200);
  assert.deepEqual(Object.keys(chosen.body.companion).sort(), ['id', 'sessionId'], 'the answer keeps its shape');
  assert.deepEqual(companionModelSelection(chosen.body.companion.id, env), HYDROGEN);
  assert.equal(companionModelSelection(plain.body.companion.id, env), null);
  const entries = JSON.parse(readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8')).companions;
  assert.equal('modelSelection' in entries.find((entry) => entry.id === plain.body.companion.id), false);
  const rows = (await post('companions')).body.companions;
  assert.deepEqual(rows.map((row) => [row.id, row.modelSelection]),
    [['segno', null], [plain.body.companion.id, null], [chosen.body.companion.id, HYDROGEN]]);
  assert.equal((await post('create', { modelSelection: null })).status, 200, 'null is no choice');
});

test('a malformed choice answers 400 and makes nothing', async (t) => {
  const { env, post } = setup(t);
  for (const modelSelection of [{ instanceId: 'antigravity' }, { ...HYDROGEN, options: [{ id: 'effort', value: 'high' }] },
    { provider: 'antigravity', model: 'gemini-4-hydrogen' }, 'gemini-4-hydrogen']) {
    const refused = await post('create', { modelSelection });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'invalid');
  }
  assert.equal(existsSync(env.RUBATO_COMPANIONS_FILE), false, 'no registry was written');
  const homes = path.join(env.HOME, '.rubato', 'companions');
  assert.ok(!existsSync(homes) || readdirSync(homes).length === 0, 'no home was left');
  assert.deepEqual((await post('companions')).body.companions.map((row) => row.id), ['segno']);
});
