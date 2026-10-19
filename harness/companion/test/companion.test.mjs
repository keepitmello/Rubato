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
