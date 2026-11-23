// The Add flow's model choice (intent companion-agy-parity rev 2): kept in the registry entry the app
// writes, there before the control tower first runs, and absent everywhere it was not chosen.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeSettings } from '../companion.mjs';
import { startControlTower } from '../control-tower.mjs';
import { ManageError, UNNAMED_TITLE, changeOnboarding, createCompanion } from '../manage.mjs';
import { companionEnv, companionModelSelection, listCompanions, registerCompanion, retitleCompanion, validModelSelection } from '../registry.mjs';

const defaultsDir = path.resolve(import.meta.dirname, '../../prompts/companion');
const HYDROGEN = { instanceId: 'antigravity', model: 'gemini-4-hydrogen' };

function machine(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-model-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, PATH: process.env.PATH, RUBATO_COMPANIONS_FILE: path.join(root, '.rubato', 'companions.json') };
  const roo = { id: 'roo', title: 'Roo', home: path.join(root, 'roo-home'), memoryAgent: 'roo' };
  mkdirSync(roo.home, { recursive: true });
  mkdirSync(path.dirname(env.RUBATO_COMPANIONS_FILE), { recursive: true });
  writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify({ companions: [roo] }, null, 2));
  return { root, env };
}

test('a selection is the two routing fields, trimmed; anything else is refused, not dropped', () => {
  assert.deepEqual(validModelSelection({ instanceId: ' antigravity ', model: ' gemini-4-hydrogen ' }), HYDROGEN);
  assert.deepEqual(validModelSelection({ instanceId: 'rubato-pi', model: 'anthropic/claude-opus-5-5' }),
    { instanceId: 'rubato-pi', model: 'anthropic/claude-opus-5-5' });
  for (const [value, message] of [
    [null, /instanceId, model/], [[], /instanceId, model/], ['antigravity', /instanceId, model/],
    [{ ...HYDROGEN, options: [{ id: 'effort', value: 'high' }] }, /not options/],
    [{ provider: 'antigravity', model: 'gemini-4-hydrogen' }, /not provider/],
    [{ model: 'gemini-4-hydrogen' }, /instanceId/], [{ instanceId: '1agy', model: 'x' }, /instanceId/],
    [{ instanceId: 'agy/../x', model: 'x' }, /instanceId/], [{ instanceId: 'a'.repeat(65), model: 'x' }, /instanceId/],
    [{ instanceId: 'antigravity' }, /model/], [{ instanceId: 'antigravity', model: '   ' }, /model/],
    [{ instanceId: 'antigravity', model: 'x'.repeat(201) }, /model/], [{ instanceId: 'antigravity', model: 'a\nb' }, /model/],
  ]) assert.throws(() => validModelSelection(value), message);
});

test('create keeps the choice in the registry entry; without one the entry and the scoped environment are as before', (t) => {
  const { env } = machine(t);
  const plain = createCompanion({ env, defaultsDir, id: 'companion-00000001', now: () => 0 });
  const chosen = createCompanion({ env, defaultsDir, id: 'companion-00000002', now: () => 0,
    modelSelection: { instanceId: 'antigravity ', model: ' gemini-4-hydrogen' } });
  const file = JSON.parse(readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8')).companions;
  assert.deepEqual(Object.keys(file[1]).sort(), ['createdAt', 'home', 'id', 'madeInApp', 'memoryAgent', 'title'],
    'no choice writes no field');
  assert.deepEqual(file[2].modelSelection, HYDROGEN, 'stored trimmed, as validated');
  assert.equal(file[2].title, UNNAMED_TITLE);

  assert.equal(companionModelSelection('segno', env), null, 'Segno opens on the engine default');
  assert.equal(companionModelSelection('roo', env), null, 'a hand-registered companion too');
  assert.equal(companionModelSelection(plain.id, env), null);
  assert.deepEqual(companionModelSelection(chosen.id, env), HYDROGEN);
  assert.deepEqual(companionModelSelection(undefined, chosen.env), HYDROGEN, "inside its scoped environment it is its own");
  assert.equal(companionModelSelection(undefined, plain.env), null);
  assert.equal(companionModelSelection(undefined, env), null, 'outside any companion the default is Segno');

  const keys = (scoped) => Object.keys(scoped).filter((key) => key.startsWith('RUBATO_COMPANION_')).sort();
  assert.deepEqual(keys(chosen.env), keys(plain.env), 'the choice adds nothing to the environment: the registry is its one source');
  assert.deepEqual(listCompanions(env).find((item) => item.id === 'roo'), { id: 'roo', title: 'Roo', home: path.join(env.HOME, 'roo-home'), memoryAgent: 'roo', telegram: false });
});

test('the choice survives the name the first meeting settles and other registrations', (t) => {
  const { env } = machine(t);
  const chosen = createCompanion({ env, defaultsDir, id: 'companion-00000003', modelSelection: HYDROGEN });
  changeOnboarding({ set: { name: '미루' } }, { env: chosen.env, defaultsDir });
  retitleCompanion(chosen.id, '미루', env);
  createCompanion({ env, defaultsDir, id: 'companion-00000004' });
  assert.equal(listCompanions(env).find((item) => item.id === chosen.id).title, '미루');
  assert.deepEqual(companionModelSelection(chosen.id, env), HYDROGEN);
});

test('an invalid choice refuses the create and leaves no home and no entry', (t) => {
  const { env } = machine(t);
  const before = readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8');
  for (const modelSelection of [{ instanceId: 'antigravity' }, { ...HYDROGEN, options: [] }, 'gemini-4-hydrogen']) {
    assert.throws(() => createCompanion({ env, defaultsDir, id: 'companion-0000000a', modelSelection }),
      (error) => error instanceof ManageError && error.code === 'invalid' && error.status === 400);
  }
  assert.equal(readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8'), before);
  const homes = path.join(path.dirname(env.RUBATO_COMPANIONS_FILE), 'companions');
  assert.ok(!existsSync(homes) || readdirSync(homes).length === 0);
  // null is "no choice", the same as leaving it out.
  const made = createCompanion({ env, defaultsDir, id: 'companion-0000000b', modelSelection: null });
  assert.equal(companionModelSelection(made.id, env), null);
});

test('the registry refuses a hand-edited or written selection the engine could not read', (t) => {
  const { env } = machine(t);
  const home = path.join(env.HOME, 'other-home');
  assert.throws(() => registerCompanion({ id: 'other', title: 'Other', home, memoryAgent: 'other',
    modelSelection: { instanceId: 'antigravity', model: '' } }, env), /modelSelection\.model/);
  assert.deepEqual(listCompanions(env).map((item) => item.id), ['segno', 'roo'], 'nothing landed');
  const data = JSON.parse(readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8'));
  data.companions[0].modelSelection = { instanceId: 'antigravity', model: 'gemini-4-hydrogen', options: [] };
  writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify(data));
  assert.throws(() => listCompanions(env), /not options/);
});

test('the control tower finds the choice before it opens the first conversation, and opens it as before', async (t) => {
  const { env } = machine(t);
  const chosen = createCompanion({ env, defaultsDir, id: 'companion-00000005', modelSelection: HYDROGEN });
  const created = [];
  const seen = [];
  const connect = async () => {
    let attached;
    const sessions = [];
    return {
      async list() { return sessions.map((row) => ({ ...row })); },
      async create(options) {
        seen.push(companionModelSelection(undefined, chosen.env));
        created.push(options);
        sessions.push({ sessionId: 's1', status: 'stored', runtimeId: null, companion: true, companionId: options.companionId });
        return { sessionId: 's1' };
      },
      async attach(id) { Object.assign(sessions.find((row) => row.sessionId === id), { status: 'idle', runtimeId: 'r1' }); attached = id; },
      async command() { if (!attached) throw new Error('No session is attached'); return {}; },
      async close() { attached = undefined; },
    };
  };
  writeSettings({ enabled: true }, chosen.env);
  const tower = startControlTower({ connect, env: chosen.env, defaultsDir, pollMs: 60_000 });
  t.after(() => tower.close());
  await tower.ready;
  assert.deepEqual(seen, [HYDROGEN], 'readable from its own environment when the conversation is made');
  // The engine's create takes no model yet: the tower opens the conversation exactly as for any companion.
  assert.deepEqual(created, [{ cwd: chosen.home, title: UNNAMED_TITLE, titleLocked: true, companion: true, companionId: chosen.id }]);
});
