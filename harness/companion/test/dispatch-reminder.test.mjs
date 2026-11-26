import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompanionHomeFactories } from '../../pi-runtime/features/companion-home/index.mjs';
import { DISPATCH_BLOCK, SHORT_SEND, installDispatchReminder } from '../../pi-runtime/features/companion-home/dispatch-reminder.mjs';
import { createSessionTools } from '../../pi-runtime/features/session-link/tools.mjs';

const DISPATCHING = '/Users/x/.agents/skills/dispatching/SKILL.md';
const MODEL_GUIDE = '/Users/x/.agents/skills/model-guide/SKILL.md';

/** The check as the runtime installs it: Pi's call and result events. Returns the block reason, or undefined when the call goes through. */
function session() {
  const handlers = {};
  installDispatchReminder({ on: (name, handler) => (handlers[name] ??= []).push(handler) });
  let id = 0;
  const emit = (name, event) => (handlers[name] ?? []).map((handler) => handler(event, {})).find(Boolean);
  return {
    agentStart: () => emit('agent_start', {}),
    async call(toolName, input, { isError = false } = {}) {
      const event = { toolCallId: `c${++id}`, toolName, input };
      const verdict = emit('tool_call', event);
      if (verdict?.block) return verdict.reason;
      emit('tool_result', { ...event, content: [{ type: 'text', text: 'ok' }], isError });
      return undefined;
    },
  };
}
const long = 'x'.repeat(SHORT_SEND);
const send = (text = long) => ['session_send', { sessionId: 's', text }];

test('without the two skills read, session_create and a brief-sized session_send are stopped with one line; the call does not run', async () => {
  const run = session();
  assert.equal(await run.call('session_create', { text: 'a' }), DISPATCH_BLOCK);
  assert.equal(await run.call(...send()), DISPATCH_BLOCK);
  assert.equal(DISPATCH_BLOCK.includes('\n'), false);
  assert.match(DISPATCH_BLOCK, /skill\(dispatching\).*skill\(model-guide\)/);
});

test('both skills read this turn: the same calls go through, with nothing added', async () => {
  const run = session();
  assert.equal(await run.call('read', { path: DISPATCHING }), undefined);
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_BLOCK, 'one skill is not enough');
  assert.equal(await run.call('bash', { command: `cat ${MODEL_GUIDE}` }), undefined);
  assert.equal(await run.call('session_create', { text: long }), undefined);
  assert.equal(await run.call(...send()), undefined);
});

test('the only way through is the reading: a repeated call is stopped again, and a failed or merely named read does not count', async () => {
  const run = session();
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_BLOCK);
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_BLOCK);
  assert.equal(await run.call('read', { path: DISPATCHING }, { isError: true }), undefined);
  assert.equal(await run.call('read', { path: MODEL_GUIDE }), undefined);
  assert.equal(await run.call('bash', { command: 'echo dispatching/SKILL.md' }), undefined);
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_BLOCK);
});

test('a short session_send and the other session tools are never stopped', async () => {
  const run = session();
  assert.equal(await run.call(...send(long.slice(1))), undefined);
  assert.equal(await run.call(...send('  ' + long.slice(2) + '  ')), undefined, 'padding does not make it a brief');
  assert.equal(await run.call('session_list', {}), undefined);
  assert.equal(await run.call('session_read', { sessionId: 's' }), undefined);
  assert.equal(await run.call('bash', { command: 'ls' }), undefined);
});

test('the next turn must read again', async () => {
  const run = session();
  await run.call('read', { path: DISPATCHING });
  await run.call('read', { path: MODEL_GUIDE });
  assert.equal(await run.call('session_create', { text: long }), undefined);
  run.agentStart();
  assert.equal(await run.call('session_create', { text: long }), DISPATCH_BLOCK);
  await run.call('read', { path: MODEL_GUIDE });
  await run.call('read', { path: DISPATCHING });
  assert.equal(await run.call('session_create', { text: long }), undefined);
});

test('a skill read through its bundle path counts: the agents folder links to it', async () => {
  const run = session();
  await run.call('read', { path: '/Users/x/Github-repos/rubato-lab/rubato/harness/skills/dispatching/SKILL.md' });
  await run.call('read', { path: '/Users/x/Github-repos/rubato-lab/rubato/harness/skills/model-guide/SKILL.md' });
  assert.equal(await run.call('session_create', { text: long }), undefined);
});

test('the companion descriptions say it before the call, and a lead or other conversation has none', () => {
  const describe = (companion) => Object.fromEntries(createSessionTools(() => ({}), { companion })
    .filter((tool) => ['session_create', 'session_send'].includes(tool.name)).map((tool) => [tool.name, tool.description]));
  const companion = describe(true);
  const lead = describe(false);
  for (const name of ['session_create', 'session_send']) {
    assert.match(companion[name], /dispatching skill \(~\/\.agents\/skills\/dispatching\/SKILL\.md\)/);
    assert.match(companion[name], /model-guide skill/);
    assert.doesNotMatch(lead[name], /dispatching|model-guide/);
  }
});

test('the check is installed in the companion extension, which only a companion session loads', () => {
  const seen = [];
  const [feature] = createCompanionHomeFactories({ env: {} });
  feature.factory({ registerTool() {}, on: (name) => seen.push(name), sendMessage() {} });
  assert.ok(seen.filter((name) => name === 'tool_call').length >= 3);
});
