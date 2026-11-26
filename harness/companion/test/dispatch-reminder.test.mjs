import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanionHomeFactories } from '../../pi-runtime/features/companion-home/index.mjs';
import { DISPATCH_REMINDER, SHORT_SEND, installDispatchReminder } from '../../pi-runtime/features/companion-home/dispatch-reminder.mjs';
import { createSessionTools } from '../../pi-runtime/features/session-link/tools.mjs';

/** The reminder as the runtime installs it: Pi's call and result events. Returns the text added to a result, or undefined. */
function session() {
  const handlers = {};
  installDispatchReminder({ on: (name, handler) => (handlers[name] ??= []).push(handler) });
  let id = 0;
  const emit = (name, event) => (handlers[name] ?? []).map((handler) => handler(event, {})).find(Boolean);
  return {
    agentStart: () => emit('agent_start', {}),
    async call(toolName, input, isError = false) {
      const event = { toolCallId: `c${++id}`, toolName, input };
      emit('tool_call', event);
      const patched = emit('tool_result', { ...event, content: [{ type: 'text', text: 'ok' }], isError });
      return patched?.content?.slice(1).map((part) => part.text).join('').trim();
    },
  };
}
const long = 'x'.repeat(SHORT_SEND);

test('session_create always carries the reminder; session_send carries it only when long enough to be a brief', async () => {
  const run = session();
  assert.equal(await run.call('session_create', { text: 'a' }), DISPATCH_REMINDER);
  assert.equal(await run.call('session_send', { sessionId: 's', text: long }), DISPATCH_REMINDER);
  assert.equal(await run.call('session_send', { sessionId: 's', text: long.slice(1) }), undefined, 'a short operating message');
  assert.equal(await run.call('session_send', { sessionId: 's', text: '  ' + long.slice(2) + '  ' }), undefined, 'padding does not make it long');
  assert.equal(await run.call('session_create', { text: long }, true), undefined, 'a call that failed sent nothing');
  assert.equal(await run.call('session_list', {}), undefined);
  assert.equal(await run.call('bash', { command: 'ls' }), undefined);
});

test('a run that opened the skill is not reminded; the next run is', async () => {
  const run = session();
  assert.equal(await run.call('read', { path: '/Users/x/.agents/skills/dispatching/SKILL.md' }), undefined);
  assert.equal(await run.call('session_create', { text: long }), undefined);
  run.agentStart();
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_REMINDER);
  // Another skill, or a command that only names this one, has not read it.
  assert.equal(await run.call('read', { path: '/x/skills/prompting-principles/SKILL.md' }), undefined);
  assert.equal(await run.call('bash', { command: 'echo dispatching/SKILL.md' }), undefined);
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_REMINDER);
  assert.equal(await run.call('bash', { command: 'cat ~/.agents/skills/dispatching/SKILL.md' }), undefined);
  assert.equal(await run.call('session_create', { text: long }), undefined);
});

test('the call-side hint is in the companion descriptions before the call, and a lead or other conversation has none', () => {
  const describe = (companion) => Object.fromEntries(createSessionTools(() => ({}), { companion })
    .filter((tool) => ['session_create', 'session_send'].includes(tool.name)).map((tool) => [tool.name, tool.description]));
  const companion = describe(true);
  const lead = describe(false);
  for (const name of ['session_create', 'session_send']) {
    assert.match(companion[name], /dispatching skill \(~\/\.agents\/skills\/dispatching\/SKILL\.md\)/);
    assert.match(companion[name], /leads for the lead to verify/);
    assert.doesNotMatch(lead[name], /dispatching/);
  }
});

test('the reminder is installed in the companion extension, which only a companion session loads', () => {
  const seen = [];
  const [feature] = createCompanionHomeFactories({ env: {} });
  feature.factory({ registerTool() {}, on: (name) => seen.push(name), sendMessage() {} });
  assert.ok(seen.filter((name) => name === 'tool_result').length >= 2);
});
