import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCompanionHomeFactories } from '../../pi-runtime/features/companion-home/index.mjs';
import { PIECE_REMINDER, installPromptPieceReminder } from '../../pi-runtime/features/companion-home/prompt-piece-reminder.mjs';

function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-piece-reminder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'companion');
  for (const sub of ['prompt/lead-roles', 'memory', 'notes']) mkdirSync(path.join(root, sub), { recursive: true });
  for (const file of ['prompt/soul.md', 'prompt/identity.md', 'prompt/lead-roles/lbt-ops.md', 'memory/MEMORY.md', 'memory/2026-11-27.md', 'notes/a.md'])
    writeFileSync(path.join(root, file), `old ${file}\n`);
  return { root, env: { HOME: dir, RUBATO_COMPANION_HOME: root } };
}

/** The reminder as the runtime installs it: Pi's call and result events, run for real when a shell is the tool. */
function session(env, cwd) {
  const handlers = {};
  installPromptPieceReminder({ on: (name, handler) => (handlers[name] ??= []).push(handler) }, { env });
  let id = 0;
  const emit = (name, event) => (handlers[name] ?? []).map((handler) => handler(event, { cwd })).find(Boolean);
  return {
    agentStart: () => emit('agent_start', {}),
    /** One tool call: the call event, whatever `run` does, then the result event. Returns the reminder text or undefined. */
    async call(toolName, input, run = () => {}) {
      const event = { toolCallId: `c${++id}`, toolName, input };
      emit('tool_call', event);
      await run();
      const patched = emit('tool_result', { ...event, content: [{ type: 'text', text: 'ok' }], isError: false });
      const added = patched?.content?.slice(1).map((part) => part.text).join('');
      return added?.trim();
    },
  };
}
const patch = (file) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch`;
const shell = (home, rel) => () => execFileSync("python3", ["-c", `open(${JSON.stringify(path.join(home, rel))}, "a").write("x")`]);

test('apply_patch on a piece and a python write to a piece each carry the reminder; other files carry none', async (t) => {
  const { root, env } = home(t);
  const run = session(env, root);
  assert.equal(await run.call('apply_patch', { input: patch('prompt/soul.md') }), PIECE_REMINDER);
  const bashPiece = await run.call('bash', { command: 'python3 write soul' }, shell(root, 'prompt/identity.md'));
  assert.equal(bashPiece, PIECE_REMINDER);
  assert.match(readFileSync(path.join(root, 'prompt/identity.md'), 'utf8'), /x$/);
  assert.equal(await run.call('bash', { command: 'python3 write lead role' }, shell(root, 'prompt/lead-roles/lbt-ops.md')), PIECE_REMINDER);
  assert.equal(await run.call('bash', { command: 'python3 write resident' }, shell(root, 'memory/MEMORY.md')), PIECE_REMINDER);
  // The same files by the file tools, and the other tools' routes.
  assert.equal(await run.call('edit', { path: path.join(root, 'prompt/user.md') }), PIECE_REMINDER);
  assert.equal(await run.call('write', { path: 'prompt/lead-roles/new-role.md' }), PIECE_REMINDER);
  assert.equal(await run.call('companion_settings', { action: 'propose', proposal: { piece: 'soul', label: '말투', before: 'a', after: 'b' } }), PIECE_REMINDER);
  // Not pieces.
  assert.equal(await run.call('apply_patch', { input: patch('memory/2026-11-27.md') }), undefined);
  assert.equal(await run.call('bash', { command: 'python3 write daily' }, shell(root, 'memory/2026-11-27.md')), undefined);
  assert.equal(await run.call('bash', { command: 'python3 write note' }, shell(root, 'notes/a.md')), undefined);
  assert.equal(await run.call('edit', { path: 'notes/a.md' }), undefined);
  assert.equal(await run.call('bash', { command: 'cat prompt/soul.md' }), undefined, 'reading a piece is not editing it');
  assert.equal(await run.call('companion_settings', { action: 'propose', proposal: { image: '/tmp/a.png', label: '프사' } }), undefined);
  assert.equal(await run.call('companion_settings', { action: 'show', piece: 'soul' }), undefined);
});

test('a run that opened the skill is not reminded; the next run is', async (t) => {
  const { root, env } = home(t);
  const run = session(env, root);
  assert.equal(await run.call('read', { path: '/x/companion/skills/prompting-principles/SKILL.md' }), undefined);
  assert.equal(await run.call('apply_patch', { input: patch('prompt/soul.md') }), undefined);
  run.agentStart();
  assert.equal(await run.call('apply_patch', { input: patch('prompt/soul.md') }), PIECE_REMINDER);
  // A write that only mentions the skill's name has not read it.
  assert.equal(await run.call('bash', { command: 'python3 write mention prompting-principles' }, shell(root, 'prompt/soul.md')), PIECE_REMINDER);
});

test("the reminder is installed in the companion's own extension, which only a companion session loads", () => {
  const seen = [];
  const [feature] = createCompanionHomeFactories({ env: {} });
  feature.factory({ registerTool() {}, on: (name) => seen.push(name), sendMessage() {} });
  assert.ok(seen.includes('tool_result'));
  assert.match(readFileSync(new URL('../../pi-runtime/features/rubato-components/bootstrap.mjs', import.meta.url), 'utf8'),
    /RUBATO_PI_ROLE === "companion" \? createCompanionHomeFactories/);
});
