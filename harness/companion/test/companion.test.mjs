import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS, PIECES, SEEDED_PIECES, acceptDefault, basePiecePath, clearPersonaReviewRequest, composeCompanionPrompt,
  companionPaths, markDefaultReviewed, pendingDefaultChanges, personalPiecePath, readPersonaReviewRequest, readPieces,
  readSettings, requestPersonaReview, seedPromptPieces, writePiece, writeSettings,
} from '../companion.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
}

/** Rubato's defaults, copied so a test can change one the way an update would. */
function defaultsSandbox(t, edits = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-defaults-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const { id } of PIECES) copyFileSync(path.join(defaultsDir, `${id}.pi.md`), path.join(dir, `${id}.pi.md`));
  for (const [id, text] of Object.entries(edits)) writeFileSync(path.join(dir, `${id}.pi.md`), text);
  return dir;
}

test('every piece has a product default, and only the tools piece has no personal version', () => {
  for (const { id } of PIECES) assert.ok(existsSync(path.join(defaultsDir, `${id}.pi.md`)), id);
  assert.deepEqual(PIECES.filter((piece) => !piece.editable).map((piece) => piece.id), ['tools']);
});

test('the shipped defaults name Segno and never hand the companion a waiting tool', () => {
  const prompt = composeCompanionPrompt({ defaultsDir, env: { RUBATO_COMPANION_HOME: '/nonexistent' } });
  assert.match(prompt, /Segno/);
  assert.doesNotMatch(prompt, /session_wait/);
});

test('a new home starts with the person\'s own copy of who Segno is, and the default it came from', (t) => {
  const env = sandbox(t);
  assert.deepEqual([...SEEDED_PIECES], ['preamble', 'soul', 'identity', 'user']);
  const result = seedPromptPieces({ defaultsDir, env });
  assert.deepEqual(result, { seeded: ['preamble', 'soul', 'identity', 'user'], kept: [] });
  for (const id of SEEDED_PIECES) {
    const defaultText = readFileSync(path.join(defaultsDir, `${id}.pi.md`), 'utf8').trim();
    assert.equal(readFileSync(personalPiecePath(env, id), 'utf8').trim(), defaultText, `${id} is copied`);
    assert.equal(readFileSync(basePiecePath(env, id), 'utf8').trim(), defaultText, `${id} remembers what it was copied from`);
  }
  for (const id of ['companion', 'tools']) {
    assert.equal(existsSync(personalPiecePath(env, id)), false, `${id} is Rubato's work rules and is not copied`);
    assert.equal(existsSync(basePiecePath(env, id)), false);
  }
  // A second setup leaves the copy alone; nothing in the prompt composer reads the base.
  assert.deepEqual(seedPromptPieces({ defaultsDir, env }), { seeded: [], kept: [...SEEDED_PIECES] });
  assert.equal(composeCompanionPrompt({ defaultsDir, env }),
    composeCompanionPrompt({ defaultsDir, env: { RUBATO_COMPANION_HOME: '/nonexistent' } }),
    'a copy of the default reads as the default, once');
});

test('seeding never rewrites a file the person wrote, and records no base for it', (t) => {
  const env = sandbox(t);
  seedPromptPieces({ defaultsDir, env });
  writeFileSync(personalPiecePath(env, 'soul'), 'my own soul\n');
  const result = seedPromptPieces({ defaultsDir, env });
  assert.deepEqual(result.seeded, [], 'nothing was copied over');
  assert.ok(result.kept.includes('soul'));
  assert.equal(readFileSync(personalPiecePath(env, 'soul'), 'utf8'), 'my own soul\n', 'their words stay exactly');
  // The base still names the default this copy started from: they edited a seeded copy.
  assert.equal(readFileSync(basePiecePath(env, 'soul'), 'utf8').trim(),
    readFileSync(path.join(defaultsDir, 'soul.pi.md'), 'utf8').trim());
  const unseeded = sandbox(t);
  mkdirSync(companionPaths(unseeded).prompt, { recursive: true });
  writeFileSync(personalPiecePath(unseeded, 'user'), 'about me\n');
  seedPromptPieces({ defaultsDir, env: unseeded });
  const user = readPieces({ defaultsDir, env: unseeded }).find((piece) => piece.id === 'user');
  assert.equal(user.personalText, 'about me');
  assert.equal(user.baseText, undefined);
  assert.equal(user.baseUnknown, true, 'an older home has no base, and we do not invent one');
});

test('a copy the person deleted comes back at the next setup, and the work rules never appear', (t) => {
  const env = sandbox(t);
  seedPromptPieces({ defaultsDir, env });
  rmSync(personalPiecePath(env, 'identity'));
  assert.deepEqual(seedPromptPieces({ defaultsDir, env }), { seeded: ['identity'], kept: ['preamble', 'soul', 'user'] });
  assert.deepEqual(readFileSync(personalPiecePath(env, 'identity'), 'utf8').trim(),
    readFileSync(path.join(defaultsDir, 'identity.pi.md'), 'utf8').trim());
  for (const id of ['companion', 'tools']) assert.equal(existsSync(personalPiecePath(env, id)), false);
});

test('a seeded copy reads as the person\'s own text, keeps its base through their edit, and loses it on reset', (t) => {
  const env = sandbox(t);
  seedPromptPieces({ defaultsDir, env });
  const pieces = readPieces({ defaultsDir, env });
  for (const id of SEEDED_PIECES) {
    const piece = pieces.find((entry) => entry.id === id);
    assert.equal(piece.personalText, piece.defaultText, `${id} is their copy from the start`);
    assert.equal(piece.baseText, piece.defaultText);
    assert.equal(piece.baseUnknown, undefined);
  }
  for (const id of ['companion', 'tools']) assert.equal(pieces.find((piece) => piece.id === id).personalText, undefined);
  const seededSoul = pieces.find((piece) => piece.id === 'soul').baseText;
  writePiece('soul', 'mine now', { defaultsDir, env });
  const edited = readPieces({ defaultsDir, env }).find((piece) => piece.id === 'soul');
  assert.equal(edited.personalText, 'mine now');
  assert.equal(edited.baseText, seededSoul, 'what it started from is still known after their edit');
  writePiece('soul', '', { defaultsDir, env });
  assert.equal(existsSync(basePiecePath(env, 'soul')), false, 'back to default leaves no stale base');
});

test('the companion is off until the person turns it on, with the heartbeat on by default', (t) => {
  const env = sandbox(t);
  assert.deepEqual(readSettings(env), DEFAULT_SETTINGS);
  assert.equal(readSettings(env).enabled, false);
  assert.equal(readSettings(env).heartbeat.enabled, true);
});

test('saved settings merge over what is stored and refuse what the page cannot offer', (t) => {
  const env = sandbox(t);
  writeSettings({ enabled: true }, env);
  writeSettings({ heartbeat: { everyMinutes: 30 } }, env);
  writeSettings({ dailyReport: { time: '18:30' } }, env);
  assert.deepEqual(readSettings(env), { enabled: true, heartbeat: { enabled: true, everyMinutes: 30 }, dailyReport: { enabled: true, time: '18:30' } });
  assert.throws(() => writeSettings({ dailyReport: { time: '25:00' } }, env), /HH:MM/);
  assert.throws(() => writeSettings({ heartbeat: { everyMinutes: 7 } }, env), /everyMinutes/);
  assert.throws(() => writeSettings({ enabled: 'yes' }, env), /enabled/);
  writeFileSync(companionPaths(env).settings, '{ broken');
  assert.deepEqual(readSettings(env), DEFAULT_SETTINGS, 'an unreadable file reads as the defaults');
});

test('a personal piece replaces only that piece, and saving the default or nothing removes it', (t) => {
  const env = sandbox(t);
  writePiece('user', 'I run a small studio.', { defaultsDir, env });
  const pieces = readPieces({ defaultsDir, env });
  assert.equal(pieces.find((piece) => piece.id === 'user').personalText, 'I run a small studio.');
  assert.equal(pieces.find((piece) => piece.id === 'soul').personalText, undefined);
  const prompt = composeCompanionPrompt({ defaultsDir, env });
  assert.match(prompt, /I run a small studio\./);
  assert.ok(prompt.includes(readFileSync(path.join(defaultsDir, 'soul.pi.md'), 'utf8').trim()));

  const userDefault = readFileSync(path.join(defaultsDir, 'user.pi.md'), 'utf8');
  writePiece('user', `${userDefault}\n`, { defaultsDir, env });
  assert.equal(existsSync(path.join(companionPaths(env).prompt, 'user.md')), false);
  writePiece('soul', 'mine', { defaultsDir, env });
  writePiece('soul', '   ', { defaultsDir, env });
  assert.equal(existsSync(path.join(companionPaths(env).prompt, 'soul.md')), false);
});

test('a personal file left for the tools piece is never read', (t) => {
  const env = sandbox(t);
  mkdirSync(companionPaths(env).prompt, { recursive: true });
  writeFileSync(path.join(companionPaths(env).prompt, 'tools.md'), 'invented tools');
  assert.doesNotMatch(composeCompanionPrompt({ defaultsDir, env }), /invented tools/);
  assert.throws(() => writePiece('nope', 'x', { defaultsDir, env }), /Unknown prompt piece/);
});

test("the space beside Segno's chat lists what it follows and what recently finished", async (t) => {
  const { composePanel, followingStore, readFinished, readPanel, writePanel, FINISHED_LIMITS } = await import('../companion.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-panel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: dir };
  const store = followingStore(env);
  const now = Date.now();
  store.finished({ sessionId: 'old', outcome: 'completed', at: now - FINISHED_LIMITS.ageMs - 1, title: 'Old' });
  store.finished({ sessionId: 'done', outcome: 'completed', at: now - 1000, title: 'Fix login', cwd: '/w/app' });
  store.finished({ sessionId: 'again', outcome: 'stopped', at: now - 500, title: 'Payments' });
  assert.deepEqual(readFinished(env, { now }).map((entry) => entry.sessionId), ['again', 'done'], 'newest first, older than a day dropped');
  const rows = [
    { sessionId: 'run', title: 'Login timeout', cwd: '/w/hash-game', status: 'running' },
    { sessionId: 'ask', title: 'Deploy', cwd: '/w/ops', status: 'waiting' },
    { sessionId: 'answered', title: 'Docs', cwd: '/w/docs', status: 'idle' },
    { sessionId: 'again', title: 'Payments v2', cwd: '/w/pay', status: 'running' },
  ];
  const following = { run: { since: now - 60_000 }, ask: { since: now - 30_000 }, answered: { since: now - 90_000, asked: true }, again: { since: now - 10 } };
  const panel = composePanel({ following, finished: readFinished(env, { now }), rows });
  assert.deepEqual(panel.leads.map((lead) => [lead.sessionId, lead.state, lead.title]), [
    ['answered', 'asked', 'Docs'], ['run', 'running', 'Login timeout'], ['ask', 'asked', 'Deploy'], ['again', 'running', 'Payments v2']]);
  assert.equal(panel.leads[1].cwd, '/w/hash-game');
  assert.equal(panel.leads[1].since, now - 60_000);
  // A conversation followed again is not also listed as finished.
  assert.deepEqual(panel.finished.map((entry) => [entry.sessionId, entry.outcome, entry.title]), [['done', 'completed', 'Fix login']]);
  assert.equal(writePanel(panel, env), true);
  assert.equal(writePanel(panel, env), false, 'an unchanged panel is not rewritten');
  assert.deepEqual(readPanel(env).leads, panel.leads);
});

test("Segno's art is one swappable file per expression: the person's own, else the default that ships", async (t) => {
  const { stageArtFile, companionPaths, STAGE_STATES } = await import('../companion.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-art-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { RUBATO_COMPANION_HOME: dir };
  for (const state of STAGE_STATES) {
    assert.match(stageArtFile(env, state), new RegExp(`harness/companion/art/stage-${state}\\.webp$`));
    assert.ok(existsSync(stageArtFile(env, state)), state);
  }
  assert.throws(() => stageArtFile(env, 'dancing'), /Unknown stage state/);
  mkdirSync(companionPaths(env).art, { recursive: true });
  writeFileSync(path.join(companionPaths(env).art, 'stage.png'), 'png');
  assert.equal(stageArtFile(env, 'working'), path.join(dir, 'art', 'stage.png'), 'one file of their own stands for every state');
  writeFileSync(path.join(companionPaths(env).art, 'stage-night.webp'), 'webp');
  assert.equal(stageArtFile(env, 'night'), path.join(dir, 'art', 'stage-night.webp'));
  assert.equal(stageArtFile(env, 'idle'), path.join(dir, 'art', 'stage.png'));
});

test('a default that moved away from the base is one review; the same change is not asked again', (t) => {
  const env = sandbox(t);
  const before = defaultsSandbox(t);
  seedPromptPieces({ defaultsDir: before, env });
  assert.deepEqual(pendingDefaultChanges({ defaultsDir: before, env }), [], 'nothing moved yet');
  const after = defaultsSandbox(t, { soul: '# I am Segno\n\nA new default voice.\n' });
  const pending = pendingDefaultChanges({ defaultsDir: after, env });
  assert.deepEqual(pending.map((change) => change.id), ['soul']);
  assert.equal(pending[0].defaultText, '# I am Segno\n\nA new default voice.');
  assert.equal(pending[0].personalText, readFileSync(personalPiecePath(env, 'soul'), 'utf8').trim(),
    'the review carries the person\'s own file');
  const piece = readPieces({ defaultsDir: after, env }).find((entry) => entry.id === 'soul');
  assert.equal(piece.defaultChanged, true);
  assert.equal(piece.reviewDue, true);
  assert.ok(piece.baseText.length > 0);
  markDefaultReviewed('soul', { defaultsDir: after, env });
  assert.deepEqual(pendingDefaultChanges({ defaultsDir: after, env }), [], 'the same default does not wake again');
  assert.equal(readPieces({ defaultsDir: after, env }).find((entry) => entry.id === 'soul').reviewDue, undefined);
  const later = defaultsSandbox(t, { soul: '# I am Segno\n\nA third default voice.\n' });
  assert.deepEqual(pendingDefaultChanges({ defaultsDir: later, env }).map((change) => change.id), ['soul'],
    'a newer default is a new review');
});

test('a copy with no base is compared but never reviewed on its own', (t) => {
  const env = sandbox(t);
  const after = defaultsSandbox(t);
  mkdirSync(companionPaths(env).prompt, { recursive: true });
  writeFileSync(personalPiecePath(env, 'soul'), 'my own soul\n');
  assert.deepEqual(pendingDefaultChanges({ defaultsDir: after, env }), [], 'no base, nothing to compare with');
  const piece = readPieces({ defaultsDir: after, env }).find((entry) => entry.id === 'soul');
  assert.equal(piece.baseUnknown, true);
  assert.equal(piece.defaultChanged, undefined);
});

test('taking the default moves the base to the new default and stops the review', (t) => {
  const env = sandbox(t);
  const before = defaultsSandbox(t);
  seedPromptPieces({ defaultsDir: before, env });
  const after = defaultsSandbox(t, { identity: '# Who I am\n\nA new identity.\n' });
  assert.deepEqual(pendingDefaultChanges({ defaultsDir: after, env }).map((change) => change.id), ['identity']);
  writePiece('identity', 'my own identity, with what I liked', { defaultsDir: after, env, accepted: true });
  assert.equal(readFileSync(basePiecePath(env, 'identity'), 'utf8').trim(), '# Who I am\n\nA new identity.');
  assert.deepEqual(pendingDefaultChanges({ defaultsDir: after, env }), []);
  const piece = readPieces({ defaultsDir: after, env }).find((entry) => entry.id === 'identity');
  assert.equal(piece.personalText, 'my own identity, with what I liked');
  assert.equal(piece.defaultChanged, undefined, 'the base now names the current default');
  assert.equal(acceptDefault('identity', { defaultsDir: after, env }).baseText, '# Who I am\n\nA new identity.');
});

test('the page asks for a review with a request the keeper can read and clear', (t) => {
  const env = sandbox(t);
  assert.equal(readPersonaReviewRequest(env), undefined);
  requestPersonaReview(env, { at: Date.parse('2026-10-20T05:00:00.000Z') });
  assert.equal(readPersonaReviewRequest(env), '2026-10-20T05:00:00.000Z');
  clearPersonaReviewRequest(env);
  assert.equal(readPersonaReviewRequest(env), undefined);
});
