import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PIECES, composeCompanionPrompt, readState, stageArtFile, writeSettings } from '../companion.mjs';
import { commitOwned, ensureSegnoHome, record, segnoSearchEnv } from '../home.mjs';
import { companionEnv, listCompanions } from '../registry.mjs';
import { workerEnv } from '../../pi-server/src/hosted-runtime.mjs';
import { residentServices } from '../../pi-server/src/resident-services.mjs';
import { replaceSystemPrompt } from '../../rubato-pi/src/system-prompt.mjs';

const defaultsDir = path.resolve(import.meta.dirname, '../../prompts/companion');
function box(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-companions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, PATH: process.env.PATH, RUBATO_COMPANIONS_FILE: path.join(root, 'companions.json') };
  const profile = { id: 'other', title: 'Other', home: path.join(root, 'existing-repo'), memoryAgent: 'other',
    layout: { resident: 'MEMORY.md', held: 'notes/held-original.md', status: 'memory/current.md' },
    historyPaths: ['MEMORY.md', 'docs/'], telegram: true, promptFiles: {},
    env: { ROO_MC_BRIDGE_ENABLED: '0' } };
  mkdirSync(profile.home);
  for (const { id } of PIECES) {
    const file = path.join(profile.home, id === 'memory' ? 'MEMORY.md' : `${id}.md`);
    profile.promptFiles[id] = file;
    writeFileSync(file, `private-${id}`);
  }
  const save = () => writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify({ companions: [profile] }));
  save();
  return { root, env, profile, save };
}

test('a local registration leaves legacy Segno home/settings/session exactly where they were', t => {
  const { env, profile } = box(t);
  const original = { ...env, RUBATO_COMPANION_HOME: path.join(env.HOME, '.rubato/companion') };
  writeSettings({ enabled: true, heartbeat: { everyMinutes: 15 } }, original);
  const settings = path.join(original.RUBATO_COMPANION_HOME, 'settings.json');
  const before = readFileSync(settings);
  assert.deepEqual(listCompanions(env).map(p => p.id), ['segno', profile.id]);
  assert.equal(companionEnv('segno', env).RUBATO_COMPANION_HOME, original.RUBATO_COMPANION_HOME);
  assert.deepEqual(readFileSync(settings), before);
  assert.equal(readState(companionEnv(profile.id, env)).sessionId, undefined);
});

test('workers resolve persisted identity, not the caller persona; leads inherit neither companion', t => {
  const { env, profile } = box(t);
  const own = companionEnv(profile.id, env);
  assert.equal(workerEnv({ companion: true, companionId: profile.id }, { env: own }).RUBATO_COMPANION_HOME, profile.home);
  const sibling = workerEnv({ companion: true }, { env: own });
  assert.equal(sibling.RUBATO_COMPANION_ID, 'segno');
  assert.notEqual(sibling.RUBATO_COMPANION_HOME, profile.home);
  assert.equal(sibling.ROO_MC_BRIDGE_ENABLED, undefined);
  const lead = workerEnv({}, { env: { ...own, RUBATO_PI_ROLE: 'companion' } });
  assert.equal(lead.RUBATO_COMPANION_HOME, undefined);
  assert.equal(lead.ROO_MC_BRIDGE_ENABLED, undefined);
  assert.equal(lead.RUBATO_PI_ROLE, undefined);
  assert.equal(own.RUBATO_COMPANION_AUTO_RECALL, '0');
});

test('optional capabilities require explicit opt-in and arbitrary private tokens cannot cross workers', t => {
  const { env, profile, save } = box(t);
  profile.env.OTHER_PRIVATE_TOKEN = 'only-own-worker';
  profile.call = { enabled: true, port: 18766 };
  save();
  const own = companionEnv(profile.id, env);
  assert.equal(own.OTHER_PRIVATE_TOKEN, 'only-own-worker');
  assert.equal(workerEnv({}, { env: own }).OTHER_PRIVATE_TOKEN, undefined);
  assert.equal(companionEnv('segno', own).OTHER_PRIVATE_TOKEN, undefined);
  assert.equal(JSON.parse(companionEnv('segno', env).RUBATO_COMPANION_CALL).enabled, false);
  writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify({
    default: { call: { enabled: true, port: 18765 }, telegram: true }, companions: [profile],
  }));
  assert.equal(listCompanions(env)[0].telegram, true);
  assert.equal(JSON.parse(companionEnv('segno', env).RUBATO_COMPANION_CALL).port, 18765);
  profile.call.port = 18765;
  writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify({
    default: { call: { enabled: true, port: 18765 } }, companions: [profile],
  }));
  assert.throws(() => listCompanions(env), /distinct port/);
});

test('nested homes cannot register another identity over a sibling record subtree', t => {
  const { env, profile, save } = box(t);
  profile.home = path.join(listCompanions(env)[0].home, 'notes'); save();
  assert.throws(() => listCompanions(env), /distinct absolute home/);
});

test('records use the registered existing layout and preserve unrelated history and untracked material', t => {
  const { env, profile } = box(t);
  const own = companionEnv(profile.id, env);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', ...args],
    { cwd: profile.home, encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('add', '.'); git('commit', '-qm', 'original');
  const original = git('rev-parse', 'HEAD');
  writeFileSync(path.join(profile.home, 'untracked.bin'), 'keep');
  ensureSegnoHome(own);
  const written = record('daily', 'new fact', { env: own, date: '2026-01-01' });
  assert.equal(written.file, path.join(profile.home, 'memory/2026-01-01.md'));
  writeFileSync(path.join(profile.home, 'MEMORY.md'), 'resident');
  const result = commitOwned(['MEMORY.md', 'memory/2026-01-01.md'], 'records', { env: own });
  assert.equal(result.committed, true);
  assert.equal(git('rev-parse', 'HEAD^'), original);
  assert.match(git('status', '--porcelain'), /untracked.bin/);
  assert.equal(readFileSync(path.join(profile.home, '.rubato/rubato.jsonc'), 'utf8').includes('"other"'), true);
});

test('private prompt mappings replace every piece without seeding or falling back to Segno', t => {
  const { env, profile, save } = box(t);
  const prompt = composeCompanionPrompt({ defaultsDir, env: companionEnv(profile.id, env) });
  for (const { id } of PIECES) assert.ok(prompt.includes(`private-${id}`));
  assert.doesNotMatch(prompt, /Chief of Staff|세뇨/);
  assert.throws(() => stageArtFile(companionEnv(profile.id, env)), /No personal companion art/);
  rmSync(profile.promptFiles.soul);
  assert.throws(() => composeCompanionPrompt({ defaultsDir, env: companionEnv(profile.id, env) }), /no private soul piece/);
  profile.layout.resident = '../outside'; save();
  assert.throws(() => companionEnv(profile.id, env), /stay in the home/);
});

test('services and search indices are distinct while Segno Telegram remains off', t => {
  const { env, profile } = box(t);
  const services = residentServices(env);
  assert.deepEqual(services.map(s => s.name), ['companion', 'companion-dream', 'companion:other', 'companion-dream:other', 'messenger:other', 'scheduler', 'hub']);
  const a = segnoSearchEnv(companionEnv('segno', env));
  const b = segnoSearchEnv(companionEnv(profile.id, env));
  assert.notEqual(a.MSEARCH_INDEX, b.MSEARCH_INDEX);
  assert.equal(b.MSEARCH_ROOT, path.join(profile.home, 'memory'));
  assert.equal(services.find(s => s.name === 'messenger:other').options.env.RUBATO_COMPANION_TELEGRAM, '1');
});

test('duplicate homes, memory agents and IDs cannot register aliases to another companion', t => {
  const { env, profile, save } = box(t);
  profile.home = listCompanions(env)[0].home; save();
  assert.throws(() => listCompanions(env), /distinct absolute home/);
  profile.home = path.join(env.HOME, 'private'); profile.memoryAgent = 'segno'; save();
  assert.throws(() => listCompanions(env), /distinct memory agent/);
  profile.memoryAgent = 'other'; profile.id = 'segno'; save();
  assert.throws(() => listCompanions(env), /unique id/);
});

test('a home alias cannot evade isolation and private skills only enter their companion prompt', t => {
  const { env, profile, save } = box(t);
  const skillDir = path.join(profile.home, 'private-skills');
  mkdirSync(path.join(skillDir, 'private-only'), { recursive: true });
  writeFileSync(path.join(skillDir, 'private-only/SKILL.md'), '---\nname: private-only\ndescription: PRIVATE_SKILL_SENTINEL\n---\nOwn instructions.');
  profile.skillDirs = [skillDir]; save();
  const own = companionEnv(profile.id, env);
  const prompt = replaceSystemPrompt('', 'companion', { env: own, loadRolePrompt: () => 'own identity', skillDirs: [] });
  assert.match(prompt, /PRIVATE_SKILL_SENTINEL/);
  assert.doesNotMatch(replaceSystemPrompt('', 'lead', { env: own, loadRolePrompt: () => 'ordinary lead', skillDirs: [] }),
    /PRIVATE_SKILL_SENTINEL/);
  const segno = listCompanions(env)[0].home;
  mkdirSync(segno, { recursive: true });
  const alias = path.join(env.HOME, 'alias');
  symlinkSync(segno, alias, 'dir');
  profile.home = alias; save();
  assert.throws(() => listCompanions(env), /distinct absolute home/);
});
