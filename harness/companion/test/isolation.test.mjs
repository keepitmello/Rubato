// Segno stays Segno's (user, 2026-10-21, items 77d5f888 and c9ea0b95): no other conversation is
// given Segno's prompt, its own skills or its way of speaking, and Segno's records stay in its home.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveRole } from '../../rubato-pi/src/role-contract.mjs';
import { COMPANION_SKILL_DIRS, loadRolePrompt, replaceSystemPrompt } from '../../rubato-pi/src/system-prompt.mjs';
import { createUiScope } from '../../pi-runtime/features/session-ui/context.mjs';
import { getShellEnv } from '../../pi-runtime/features/terminal/src/host/shell.ts';
import { LINKED_WRITE_REFUSAL, OUTSIDE_WRITE_REFUSAL, writeRefusal } from '../../pi-runtime/features/companion-home/index.mjs';

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARK = 'SEGNO-PERSONAL-MARK-7c1';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-segno-isolation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The role prompts as build.sh makes them, from this checkout's pieces.
  const prompts = path.join(dir, 'prompts');
  cpSync(path.join(harness, 'prompts'), prompts, { recursive: true });
  execFileSync('bash', [path.join(prompts, 'build.sh')], { stdio: 'ignore' });
  const home = path.join(dir, 'companion');
  mkdirSync(path.join(home, 'prompt'), { recursive: true });
  for (const piece of ['preamble', 'soul', 'identity', 'user']) writeFileSync(path.join(home, 'prompt', `${piece}.md`), `${MARK} ${piece} 오빠`);
  return { dir, env: { HOME: dir, RUBATO_PROMPTS_DIR: prompts, RUBATO_COMPANION_HOME: home } };
}

test('only the conversation the engine marks as the companion is Segno: every other role resolves to its own', () => {
  assert.equal(resolveRole({ env: {} }), 'lead');
  assert.equal(resolveRole({ env: { RUBATO_TASK_MEMBER: 'x' } }), 'owner');
  assert.equal(resolveRole({ env: { PI_CODING_AGENT_SESSION_DIR: '/tmp/x' } }), 'agent');
  assert.equal(resolveRole({ env: { RUBATO_PI_ROLE: 'companion' } }), 'companion');
});

test("a lead, owner, verifier or subagent prompt carries nothing of Segno: not its pieces, not the user's copy of them", (t) => {
  const { env } = sandbox(t);
  const segnoDefaults = ['identity', 'soul', 'companion'].map((piece) =>
    readFileSync(path.join(harness, 'prompts', 'companion', `${piece}.pi.md`), 'utf8').split('\n').find((line) => line.trim().length > 40).trim());
  for (const role of ['lead', 'owner', 'verifier', 'agent']) {
    const prompt = loadRolePrompt(role, { env });
    assert.ok(prompt.length > 1000, `${role} has its own prompt`);
    assert.ok(!prompt.includes(MARK), `${role} carries no personal Segno piece`);
    assert.ok(!prompt.includes('오빠'), `${role} carries no name Segno calls the user by`);
    for (const line of segnoDefaults) assert.ok(!prompt.includes(line), `${role} carries no default Segno piece: ${line.slice(0, 40)}`);
  }
  assert.ok(loadRolePrompt('companion', { env }).includes(MARK), 'the companion itself is composed from them');
});

test("Segno's shell commands do not run as Segno: its role stays in the engine's scope, not in what its commands inherit", () => {
  const scope = createUiScope({ env: { ...process.env, RUBATO_PI_ROLE: 'companion' } });
  const inherited = scope.run(() => getShellEnv());
  assert.notEqual(inherited.RUBATO_PI_ROLE, 'companion');
});

test("Segno's own skills are listed for Segno only, and the shared skills folder holds none of them", (t) => {
  const { dir } = sandbox(t);
  const shared = path.join(dir, 'shared');
  mkdirSync(path.join(shared, 'plain'), { recursive: true });
  writeFileSync(path.join(shared, 'plain', 'SKILL.md'), '---\nname: plain\ndescription: "A shared skill."\n---\n');
  const hooks = { loadRolePrompt: () => 'ROLE', skillDirs: [{ dir: shared, source: 'agents' }] };
  const lead = replaceSystemPrompt('', 'lead', hooks);
  const segno = replaceSystemPrompt('', 'companion', hooks);
  assert.match(lead, /"plain"/);
  assert.doesNotMatch(lead, /companion-settings/);
  assert.match(segno, /"plain"/);
  assert.match(segno, /companion-settings/);
  // The engine's own listing (shared folders only) is replaced for Segno, kept for everyone else.
  const engineListing = 'The following skills provide specialized instructions\n<available_skills>\n["plain","A shared skill."]\n</available_skills>';
  assert.match(replaceSystemPrompt(engineListing, 'companion', hooks), /companion-settings/);
  assert.doesNotMatch(replaceSystemPrompt(engineListing, 'lead', hooks), /companion-settings/);
  // Not bundled into the folder every session and CLI reads, and taken out of it on update.
  for (const { dir: own } of COMPANION_SKILL_DIRS) assert.ok(existsSync(path.join(own, 'companion-settings', 'SKILL.md')));
  assert.ok(!existsSync(path.join(harness, 'skills', 'companion-settings')));
  assert.match(readFileSync(path.join(harness, 'scripts', 'install-skills.sh'), 'utf8'), /for name in [^\n]*companion-settings/);
});

test("Segno writes only inside its home: linked repository documents are read-only and other folders are a lead's", (t) => {
  const { dir, env } = sandbox(t);
  const home = env.RUBATO_COMPANION_HOME;
  const repo = path.join(dir, 'repo', 'docs');
  mkdirSync(path.join(repo, 'ops'), { recursive: true });
  writeFileSync(path.join(repo, 'guide.md'), '# guide');
  mkdirSync(path.join(home, 'memory', 'ref'), { recursive: true });
  symlinkSync(path.join(repo, 'guide.md'), path.join(home, 'memory', 'ref', 'guide.md'));
  symlinkSync(path.join(repo, 'ops'), path.join(home, 'memory', 'ref', 'ops'), 'dir');
  symlinkSync(path.join(repo, 'not-yet.md'), path.join(home, 'memory', 'ref', 'later.md'));
  const call = (toolName, file) => writeRefusal({ toolName, input: { path: file } }, { cwd: home, env });
  assert.equal(call('write', 'memory/ref/guide.md'), LINKED_WRITE_REFUSAL);
  assert.equal(call('edit', path.join(home, 'memory', 'ref', 'ops', 'map.md')), LINKED_WRITE_REFUSAL);
  assert.equal(call('write', 'memory/ref/later.md'), LINKED_WRITE_REFUSAL, 'a dangling link would create the file in the repository');
  assert.equal(call('write', 'memory/2026-10-21.md'), undefined, "Segno's own files stay writable");
  assert.equal(call('read', 'memory/ref/guide.md'), undefined, 'reading is what the links are for');
  assert.equal(call('write', path.join(dir, 'elsewhere.md')), OUTSIDE_WRITE_REFUSAL);
  assert.equal(call('edit', '../repo/docs/guide.md'), OUTSIDE_WRITE_REFUSAL);
  const patch = (body) => writeRefusal({ toolName: 'apply_patch', input: { input: `*** Begin Patch\n${body}\n*** End Patch` } }, { cwd: home, env });
  assert.equal(patch('*** Update File: memory/ref/guide.md\n@@\n-# guide\n+# mine'), LINKED_WRITE_REFUSAL);
  assert.equal(patch('*** Update File: memory/self.md\n*** Move to: memory/ref/ops/self.md'), LINKED_WRITE_REFUSAL);
  assert.equal(patch('*** Add File: memory/work/new.md\n+# new'), undefined);
  assert.equal(patch(`*** Add File: ${path.join(dir, 'repo', 'x.md')}\n+# x`), OUTSIDE_WRITE_REFUSAL);
  assert.equal(readFileSync(path.join(repo, 'guide.md'), 'utf8'), '# guide');
});
