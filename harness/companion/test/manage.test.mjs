// Adding, shaping and picturing a companion from the app (intent companion-manage rev 1).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { avatarFile, composeCompanionPrompt, companionPaths, personalPiecePath, PIECES, readProfile, readSettings, writeState } from '../companion.mjs';
import { applyProposal, changeOnboarding, createCompanion, declineProposal, listProposals, onboardingView, propose, setPicture, writeCards, cardsView, UNNAMED_TITLE } from '../manage.mjs';
import { companionEnv, listCompanions } from '../registry.mjs';
import { companionSettings } from '../settings.mjs';
import { wakeSeedText } from '../control-tower.mjs';
import { composeDreamPrompt } from '../dream/dream.mjs';
import { newCompanionServices } from '../../pi-server/src/resident-services.mjs';
import { createCompanionService } from '../../t3-integration/src/companion/service.mjs';
import { appEntry, wakeEntry } from '../messenger/test/helpers.mjs';

const defaultsDir = path.resolve(import.meta.dirname, '../../prompts/companion');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

/** An isolated machine: Segno's home, one hand-registered companion (like Roo), and an empty app area. */
function machine(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rb-manage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, PATH: process.env.PATH, RUBATO_COMPANIONS_FILE: path.join(root, '.rubato', 'companions.json') };
  const roo = { id: 'roo', title: 'Roo', home: path.join(root, 'roo-home'), memoryAgent: 'roo', telegram: true, promptFiles: {} };
  mkdirSync(roo.home, { recursive: true });
  for (const { id } of PIECES) { roo.promptFiles[id] = path.join(roo.home, `${id}.md`); writeFileSync(roo.promptFiles[id], `roo-${id}`); }
  mkdirSync(path.dirname(env.RUBATO_COMPANIONS_FILE), { recursive: true });
  writeFileSync(env.RUBATO_COMPANIONS_FILE, JSON.stringify({ companions: [roo] }, null, 2));
  const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true }).sort()
    .filter((name) => statSync(path.join(dir, name)).isFile()).map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]));
  return { root, env, roo, snapshot };
}

test('create: the app makes and registers a nameless baby-wolf home; Segno and Roo stay exactly as they were', (t) => {
  const { env, roo, snapshot } = machine(t);
  const rooBefore = snapshot(roo.home);
  const entryBefore = listCompanions(env).find((item) => item.id === 'roo');
  const created = createCompanion({ env, defaultsDir, id: 'companion-abc12345' });
  const profiles = listCompanions(env);
  assert.deepEqual(profiles.map((item) => item.id), ['segno', 'roo', 'companion-abc12345']);
  const made = profiles.at(-1);
  assert.equal(made.madeInApp, true);
  assert.equal(made.title, UNNAMED_TITLE);
  assert.equal(made.home, path.join(path.dirname(env.RUBATO_COMPANIONS_FILE), 'companions', 'companion-abc12345'));
  assert.equal(made.memoryAgent, 'companion-abc12345');
  assert.deepEqual(profiles.find((item) => item.id === 'roo'), entryBefore);
  assert.deepEqual(snapshot(roo.home), rooBefore, "Roo's home is untouched");
  assert.equal(existsSync(path.join(env.HOME, '.rubato', 'companion')), false, "Segno's home is not created or touched");
  const own = created.env;
  assert.equal(own.RUBATO_COMPANION_MADE_IN_APP, '1');
  assert.equal(readSettings(own).enabled, true, 'it starts on, so the engine opens its conversation');
  assert.deepEqual(onboardingView(readProfile(own)).items.map((item) => item.state), Array(7).fill('open'));
  const prompt = composeCompanionPrompt({ defaultsDir, env: own });
  assert.doesNotMatch(prompt, /Segno|세뇨|segno sign/, "never Segno's name");
  assert.match(prompt, /wolf/, "Segno's temperament: a wolf outside, a puppy with the user");
  assert.match(prompt, /# 첫 만남/, 'the first meeting rides in its prompt');
  assert.match(prompt, /Name: \(not chosen yet\)/);
  assert.equal(avatarFile(own), null, "no art borrowed from Segno");
  assert.match(composeDreamPrompt({ env: own, defaultsDir }), /wolf/, 'the dream reads its own pieces with the product dream text');
  assert.match(wakeSeedText({ mode: 'fresh', now: Date.now(), model: 'm', defaultsDir, env: own }), /첫 만남/);
});

test('create: a registry that would not load is never written, and its half-made home is gone', (t) => {
  const { env } = machine(t);
  const before = readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8');
  assert.throws(() => createCompanion({ env, defaultsDir, id: 'roo' }), /unique id/);
  assert.equal(readFileSync(env.RUBATO_COMPANIONS_FILE, 'utf8'), before);
  assert.equal(existsSync(path.join(path.dirname(env.RUBATO_COMPANIONS_FILE), 'companions', 'roo')), false);
});

test('onboarding: one item at a time; finishing needs the four core items, names it everywhere and leaves what waits in memory', (t) => {
  const { env } = machine(t);
  const { id } = createCompanion({ env, defaultsDir, id: 'companion-0000aaaa' });
  const own = companionEnv(id, env);
  changeOnboarding({ set: { name: '미루' } }, { env: own, defaultsDir });
  assert.deepEqual(onboardingView(readProfile(own)).items[0], { key: 'name', state: 'set', value: '미루' });
  assert.throws(() => changeOnboarding({ finish: true }, { env: own, defaultsDir }), /callsUser, work, relationship/);
  assert.throws(() => changeOnboarding({ defer: ['work'] }, { env: own, defaultsDir }), /cannot wait/);
  changeOnboarding({ set: { callsUser: '형', work: '게임 서버 개발', relationship: '곁에 붙어 있는 동반자' }, defer: ['look'] }, { env: own, defaultsDir });
  assert.equal(onboardingView(readProfile(own)).items.find((item) => item.key === 'look').state, 'deferred');
  const titles = [];
  const done = changeOnboarding({ finish: true }, { env: own, defaultsDir });
  titles.push(done.title);
  assert.equal(done.finished, true);
  assert.equal(done.onboarding, null, 'chips go away once settled');
  assert.equal(listCompanions(env).find((item) => item.id === id).title, '미루');
  const prompt = composeCompanionPrompt({ defaultsDir, env: companionEnv(id, env) });
  assert.match(prompt, /You may be called 미루 here/);
  assert.match(prompt, /I call the user 형/);
  assert.doesNotMatch(prompt, /# 첫 만남/, 'the first-meeting text leaves the prompt');
  const memory = readFileSync(path.join(companionPaths(own).home, 'memory', 'MEMORY.md'), 'utf8');
  assert.match(memory, /나중에 같이 정하기로 한 것/);
  assert.match(memory, /내 모습: 첫 만남에서 미뤘어/);
  assert.match(memory, /내 말투/, 'items never brought up wait in memory too');
  assert.match(memory, /## 우리의 시작/, 'the resident memory keeps its frame');
  // The persona files hold no filled-in name: the profile is the one place for it.
  assert.doesNotMatch(readFileSync(personalPiecePath(own, 'identity'), 'utf8'), /미루/);
});

test('proposals: nothing is written until apply; decline leaves the piece byte-identical; a moved excerpt goes stale', (t) => {
  const { env } = machine(t);
  const { id } = createCompanion({ env, defaultsDir, id: 'companion-0000bbbb' });
  const own = companionEnv(id, env);
  const file = personalPiecePath(own, 'soul');
  const before = readFileSync(file);
  const excerpt = 'When I work I am short and exact;';
  assert.throws(() => propose({ piece: 'soul', label: '말투', before: 'not in there', after: 'x' }, { env: own, defaultsDir }), /not in the piece/);
  assert.throws(() => propose({ piece: 'soul', label: '말투', before: 'I', after: 'x' }, { env: own, defaultsDir }), /more than once/);
  assert.throws(() => propose({ piece: 'tools', label: '도구', before: 'a', after: 'b' }, { env: own, defaultsDir }), /follows Rubato/);
  const first = propose({ piece: 'soul', label: '말투', before: excerpt, after: 'When I work I say one line;' }, { env: own, defaultsDir });
  assert.deepEqual(readFileSync(file), before, 'a proposal writes nothing to the piece');
  declineProposal(first.id, { env: own });
  assert.deepEqual(readFileSync(file), before, 'declining leaves it byte-identical');
  assert.throws(() => applyProposal(first.id, { env: own, defaultsDir }), (error) => error.code === 'closed' && error.status === 409);
  const second = propose({ piece: 'soul', label: '말투', before: excerpt, after: 'When I work I say one line;' }, { env: own, defaultsDir });
  const third = propose({ piece: 'soul', label: '말투', before: excerpt, after: 'When I work I say half a line;' }, { env: own, defaultsDir });
  assert.equal(listProposals({ env: own }).find((item) => item.id === second.id).status, 'superseded', '"more" replaces the open card');
  applyProposal(third.id, { env: own, defaultsDir });
  const after = readFileSync(file, 'utf8');
  assert.match(after, /When I work I say half a line;/);
  assert.doesNotMatch(after, /short and exact/);
  const stale = propose({ piece: 'soul', label: '말투', before: 'say half a line;', after: 'say a word;' }, { env: own, defaultsDir });
  writeFileSync(file, 'the user rewrote it in Advanced\n');
  assert.throws(() => applyProposal(stale.id, { env: own, defaultsDir }), (error) => error.code === 'stale' && error.status === 409);
  assert.equal(readFileSync(file, 'utf8'), 'the user rewrote it in Advanced\n');
  assert.equal(listProposals({ env: own }).find((item) => item.id === stale.id).status, 'stale');
});

test("proposals on Segno: a piece without a copy of the user's own applies as a new copy; the default is not touched", (t) => {
  const { env } = machine(t);
  const segno = companionEnv('segno', env);
  const defaultBefore = readFileSync(path.join(defaultsDir, 'coda.pi.md'));
  const proposal = propose({ piece: 'coda', label: '끝맺음', before: '나는 사용자 편이야.', after: '나는 언제나 사용자 편이야.' }, { env: segno, defaultsDir });
  assert.equal(existsSync(personalPiecePath(segno, 'coda')), false);
  applyProposal(proposal.id, { env: segno, defaultsDir });
  assert.match(readFileSync(personalPiecePath(segno, 'coda'), 'utf8'), /나는 언제나 사용자 편이야/);
  assert.deepEqual(readFileSync(path.join(defaultsDir, 'coda.pi.md')), defaultBefore);
});

test('picture: set on either device, kept outside every home, so Roo gets a face without its records changing', (t) => {
  const { env, roo, snapshot } = machine(t);
  const own = companionEnv('roo', env);
  const before = snapshot(roo.home);
  assert.equal(avatarFile(own), null, 'Roo shows no character image until the user gives one');
  const file = setPicture(`data:image/png;base64,${PNG.toString('base64')}`, { env: own });
  assert.equal(avatarFile(own), file);
  assert.ok(!file.startsWith(roo.home));
  assert.deepEqual(snapshot(roo.home), before);
  assert.throws(() => setPicture(`data:image/png;base64,${Buffer.from('not a picture').toString('base64')}`, { env: own }), /JPEG, PNG or WebP/);
  assert.throws(() => setPicture('https://example.com/x.png', { env: own }), /data URL/);
  assert.throws(() => setPicture(`data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]).toString('base64')}`, { env: own }),
    (error) => error.status === 413);
  setPicture(null, { env: own });
  assert.equal(avatarFile(own), null);
  // A drawn picture arrives as a proposal; apply makes it the face.
  const drawn = path.join(env.HOME, 'drawn.png');
  writeFileSync(drawn, PNG);
  const proposal = propose({ image: drawn, label: '새 프사' }, { env: own, defaultsDir });
  assert.equal(avatarFile(own), null);
  applyProposal(proposal.id, { env: own, defaultsDir });
  assert.deepEqual(readFileSync(avatarFile(own)), PNG);
  assert.deepEqual(snapshot(roo.home), before);
});

test('cards: the companion writes its two readable summaries; unknown rows are refused', (t) => {
  const { env } = machine(t);
  const segno = companionEnv('segno', env);
  assert.deepEqual(cardsView(readProfile(segno)), { who: null, me: null, updatedAt: null });
  writeCards({ who: { line: '겉은 늑대, 속은 강아지', speech: '짧은 반말' }, me: { work: '게임 서버' } }, { env: segno, now: () => 0 });
  const view = cardsView(readProfile(segno));
  assert.deepEqual(view.who.rows, [{ key: 'line', text: '겉은 늑대, 속은 강아지' }, { key: 'speech', text: '짧은 반말' }]);
  assert.equal(view.updatedAt, new Date(0).toISOString());
  assert.throws(() => writeCards({ who: { mood: 'x' } }, { env: segno }), /who takes/);
});

test('the tool: pieces change only through a proposal; the first meeting is settled only in a turn the user opened', async (t) => {
  const { env } = machine(t);
  const { id } = createCompanion({ env, defaultsDir, id: 'companion-0000cccc' });
  const own = companionEnv(id, env);
  writeState({ sessionId: 'S1' }, own);
  const sessionsDir = path.join(env.HOME, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const transcript = (entries) => writeFileSync(path.join(sessionsDir, '2026-11-21T00-00-00-000Z_S1.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const service = createCompanionService({ env: own, defaultsDir, telegram: false });
  const retitled = [];
  const call = (request) => companionSettings({ sessionId: 'S1', sessionsDir, env: own, service, request, telegram: false, defaultsDir,
    retitle: async (title) => { retitled.push(title); } });
  transcript([wakeEntry('w1', 'heartbeat', 'tick')]);
  await assert.rejects(call({ action: 'onboarding', onboarding: { set: { name: '미루' } } }), (error) => error.code === 'not-the-user');
  transcript([appEntry('u1', '미루 어때')]);
  const answer = await call({ action: 'onboarding', onboarding: { set: { name: '미루', callsUser: '형', work: '개발', relationship: '친구' } } });
  assert.equal(answer.onboarding.items.filter((item) => item.state === 'set').length, 4);
  const finished = await call({ action: 'onboarding', onboarding: { finish: true } });
  assert.equal(finished.finished, true);
  assert.match(finished.next, /new_context/);
  assert.deepEqual(retitled, ['미루'], 'the conversation takes the name');
  await assert.rejects(call({ action: 'change', change: { piece: { id: 'soul', text: 'x' } } }), (error) => error.code === 'invalid' && /propose/.test(error.message));
  transcript([wakeEntry('w2', 'heartbeat', 'tick')]);
  const proposed = await call({ action: 'propose', proposal: { piece: 'identity', label: '모습', before: '- How I look: {{look}}', after: '- How I look: 검은 늑대 귀' } });
  assert.equal(proposed.proposal.status, 'open', 'any turn may propose: the apply is the authority');
  assert.match(readFileSync(personalPiecePath(own, 'identity'), 'utf8'), /\{\{look\}\}/);
  const cards = await call({ action: 'summary', summary: { who: { line: '새로 태어난 늑대' } } });
  assert.equal(cards.cards.who.rows[0].text, '새로 태어난 늑대');
  const shown = await call({ action: 'show' });
  assert.equal(shown.cards.who.rows.length, 1);
  assert.equal(shown.onboarding, undefined);
});

test('the engine starts a new companion without a restart: its control tower and dream join the running services', (t) => {
  const { env } = machine(t);
  const running = new Set(newCompanionServices(() => false, env).map((spec) => spec.name));
  assert.ok(running.has('companion:roo'));
  assert.deepEqual(newCompanionServices((name) => running.has(name), env), []);
  createCompanion({ env, defaultsDir, id: 'companion-0000dddd' });
  const added = newCompanionServices((name) => running.has(name), env);
  assert.deepEqual(added.map((spec) => spec.name).sort(), ['companion-dream:companion-0000dddd', 'companion:companion-0000dddd']);
  assert.equal(added[0].options.env.RUBATO_COMPANION_MADE_IN_APP, '1');
  assert.ok(!added.some((spec) => spec.name.startsWith('messenger')), 'no Telegram for a new companion');
});

test('rewriting itself: a new companion gets the product prompting-principles; a companion with its own keeps its own', async (t) => {
  const { COMPANION_SKILL_DIRS } = await import('../../rubato-pi/src/system-prompt.mjs');
  const { loadSkillEntries } = await import('../../rubato-pi/src/skills-section.mjs');
  const product = loadSkillEntries(COMPANION_SKILL_DIRS).find((skill) => skill.name === 'prompting-principles');
  assert.match(product.filePath, /companion\/skill-defaults\/prompting-principles\/SKILL\.md$/);
  assert.doesNotMatch(readFileSync(product.filePath, 'utf8'), /Segno|세뇨|루\b|우용/);
  const own = mkdtempSync(path.join(tmpdir(), 'rb-own-skill-'));
  t.after(() => rmSync(own, { recursive: true, force: true }));
  mkdirSync(path.join(own, 'prompting-principles'));
  writeFileSync(path.join(own, 'prompting-principles', 'SKILL.md'), '---\nname: prompting-principles\ndescription: mine\n---\nmine\n');
  const mine = loadSkillEntries([{ dir: own, source: 'personal-companion' }, ...COMPANION_SKILL_DIRS]).find((skill) => skill.name === 'prompting-principles');
  assert.equal(mine.description, 'mine');
});
