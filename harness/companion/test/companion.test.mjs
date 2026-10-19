import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS, PIECES, composeCompanionPrompt, companionPaths, readPieces, readSettings, writePiece, writeSettings,
} from '../companion.mjs';

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'companion');

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-companion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { RUBATO_COMPANION_HOME: path.join(dir, 'home') };
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
