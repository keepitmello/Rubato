// isolated-home.sh against a fake "live" home: it clones memory and Segno, switches the clone off,
// runs commands with nothing inherited from the calling shell, and refuses a live path or low disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../isolated-home.sh', import.meta.url));

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'rb-isolated-home-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const live = path.join(base, 'live');
  const segno = path.join(live, '.rubato/companion');
  mkdirSync(path.join(live, '.rubato/memory/agents/rubato/repo/decisions'), { recursive: true });
  writeFileSync(path.join(live, '.rubato/memory/agents/rubato/repo/decisions/a.md'), 'a decision\n');
  for (const dir of ['inbox', 'messenger', 'memory', 'dream']) mkdirSync(path.join(segno, dir), { recursive: true });
  writeFileSync(path.join(segno, 'memory/status.md'), '# status\n');
  writeFileSync(path.join(segno, 'state.json'), JSON.stringify({ sessionId: 'live-session' }));
  writeFileSync(path.join(segno, 'following.json'), '{}');
  writeFileSync(path.join(segno, 'settings.json'), JSON.stringify({ enabled: true, heartbeat: { enabled: true, everyMinutes: 30 },
    greetings: { enabled: true }, schedule: { sources: ['/somewhere/calendar.ics'] } }));
  const root = path.join(base, 'iso');
  const env = { ...process.env, RUBATO_ISOLATED_LIVE_HOME: live, RUBATO_ISOLATED_MIN_FREE_GB: '0', LEAKED_FROM_SHELL: 'yes',
    RUBATO_COMPANIONS_FILE: path.join(live, '.rubato/companions.json') };
  const run = (...args) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  return { live, segno, root, home: path.join(root, 'home'), run };
}

test('prepare clones memory and Segno, and the cloned Segno cannot act on its own', (t) => {
  const { root, home, run } = fixture(t);
  const prepared = run('prepare', root, '--memory', '--segno');
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(readFileSync(path.join(home, 'memory/agents/rubato/repo/decisions/a.md'), 'utf8'), 'a decision\n');
  const clone = path.join(home, '.rubato/companion');
  assert.equal(readFileSync(path.join(clone, 'memory/status.md'), 'utf8'), '# status\n');
  for (const gone of ['inbox', 'messenger', 'dream', 'state.json', 'following.json']) assert.equal(existsSync(path.join(clone, gone)), false, gone);
  const settings = JSON.parse(readFileSync(path.join(clone, 'settings.json'), 'utf8'));
  assert.equal(settings.enabled, false);
  assert.equal(settings.heartbeat.enabled, false);
  assert.equal(settings.greetings.enabled, false);
  assert.deepEqual(settings.schedule.sources, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, '.rubato/companions.json'), 'utf8')), { companions: [] });
  assert.equal(existsSync(path.join(root, 't3home')), true);
});

test('run starts from an empty environment whose every Rubato path is inside the isolated home', (t) => {
  const { root, home, run } = fixture(t);
  assert.equal(run('prepare', root).status, 0);
  const shown = run('run', root, 'node', '-e', 'console.log(JSON.stringify(process.env))');
  assert.equal(shown.status, 0, shown.stderr);
  const env = JSON.parse(shown.stdout);
  assert.equal(env.HOME, home);
  assert.equal(env.LEAKED_FROM_SHELL, undefined, 'nothing from the calling shell');
  assert.equal(env.RUBATO_COMPANIONS_FILE, path.join(home, '.rubato/companions.json'), 'not the inherited live companions file');
  for (const [key, value] of Object.entries(env)) if (/^(RUBATO|PI)_/.test(key)) assert.ok(value.startsWith(home), `${key}=${value}`);
});

test('a live path in a copied configuration, or too little disk, refuses the launch', (t) => {
  const { live, root, home, run } = fixture(t);
  assert.equal(run('prepare', root).status, 0);
  writeFileSync(path.join(home, '.rubato/companions.json'), JSON.stringify({ companions: [{ id: 'roo', home: path.join(live, '.claude/roo-channel') }] }));
  const refused = run('run', root, 'true');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /a live path is in a copied configuration/);
  writeFileSync(path.join(home, '.rubato/companions.json'), '{ "companions": [] }\n');
  const full = spawnSync('bash', [script, 'check', root], { env: { ...process.env, RUBATO_ISOLATED_LIVE_HOME: live, RUBATO_ISOLATED_MIN_FREE_GB: '100000' }, encoding: 'utf8' });
  assert.equal(full.status, 1);
  assert.match(full.stderr, /GB free/);
});
