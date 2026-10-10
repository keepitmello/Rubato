import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantPhaseOf, classifyShellCommand, shellWords, toolActivityOf } from '../src/activity.mjs';
import { EventProjection } from '../src/events.mjs';
import { CONTEXT_NOTES_TOOL_NAMES } from '../../rubato-pi/src/context-notes/tools.mjs';
import { TOOL_SEARCH_TOOL_NAME } from '../../pi-runtime/features/tool-search/tool.mjs';
import { createTodoExtension } from '../../pi-runtime/features/prompt-rules/todo.mjs';

test('an assistant message is commentary when it hands off to tools and the answer when it stops', () => {
  const text = (extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text: 'hi', ...extra }] });
  assert.equal(assistantPhaseOf({ ...text(), stopReason: 'toolUse' }), 'commentary');
  assert.equal(assistantPhaseOf({ ...text(), stopReason: 'stop' }), 'final_answer');
  assert.equal(assistantPhaseOf({ ...text(), stopReason: 'length' }), 'final_answer');
  assert.equal(assistantPhaseOf({ ...text(), stopReason: 'error' }), undefined);
  assert.equal(assistantPhaseOf({ ...text(), stopReason: 'aborted' }), undefined);
  assert.equal(assistantPhaseOf(text()), undefined, 'still streaming');
  assert.equal(assistantPhaseOf({ role: 'user', content: 'x', stopReason: 'stop' }), undefined);
});

test('an OpenAI model says its own phase on the text signature, and it wins', () => {
  const signed = (phase) => JSON.stringify({ v: 1, id: 'msg_1', phase });
  assert.equal(assistantPhaseOf({ role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'checking', textSignature: signed('commentary') }] }), 'commentary');
  assert.equal(assistantPhaseOf({ role: 'assistant',
    content: [{ type: 'text', text: 'done', textSignature: signed('final_answer') }] }), 'final_answer');
  assert.equal(assistantPhaseOf({ role: 'assistant', stopReason: 'toolUse',
    content: [{ type: 'text', text: 'x', textSignature: 'legacy-id' }] }), 'commentary');
});

test('shell words honor quotes and escapes', () => {
  assert.deepEqual(shellWords(`rg -n "a b" 'c d' e\\ f`), ['rg', '-n', 'a b', 'c d', 'e f']);
  assert.equal(shellWords('echo "open'), undefined);
});

test('bash commands that only look are exploration; anything else runs', () => {
  const cases = [
    ['sed -n 1,80p src/events.mjs', { kind: 'read', target: 'src/events.mjs' }],
    ['cd /repo/harness; sed -n 222,245p src/bridge.mjs', { kind: 'read', target: 'src/bridge.mjs' }],
    ['cat package.json | head -30', { kind: 'read', target: 'package.json' }],
    ['wc -l a.ts b.ts', { kind: 'read', target: 'b.ts' }],
    ['rg -n "summary.readFiles" pretty/sites.js', { kind: 'search', target: 'summary.readFiles', path: 'pretty/sites.js' }],
    ['cd /tmp/x && grep -rn "phase" packages/contracts/src | head -20', { kind: 'search', target: 'phase', path: 'packages/contracts/src' }],
    ['grep -n -E "a|b" file.ts | head -40', { kind: 'search', target: 'a|b', path: 'file.ts' }],
    ['rg -e foo -g "*.ts" src', { kind: 'search', target: 'foo', path: 'src' }],
    ['ls -la ~/.agents/skills', { kind: 'list', target: '~/.agents/skills' }],
    ['ls', { kind: 'list' }],
    ['find . -name "*.map" | head', { kind: 'search', target: '*.map', path: '.' }],
    ['find src -type f', { kind: 'list', target: 'src' }],
    ['rg --files src', { kind: 'list', target: 'src' }],
    ['git grep -n TODO', { kind: 'search', target: 'TODO' }],
    ['rg foo 2>&1', { kind: 'search', target: 'foo' }],
    ['cd ~/r && grep -rl "x" inbox/ 2>/dev/null | head -20', { kind: 'search', target: 'x', path: 'inbox/' }],
    ['ls -d tests/acceptance 2> /dev/null', { kind: 'list', target: 'tests/acceptance' }],
  ];
  for (const [command, expected] of cases) assert.deepEqual(classifyShellCommand(command), expected, command);
  const runs = [
    'npm test', 'git status --short', 'sqlite3 state.sqlite ".tables"', 'sed -i "s/a/b/" file',
    'cat a > b', 'find . -name "*.tmp" -delete', 'ls | xargs rm', 'echo $(cat secret)', 'cat <<EOF\nx\nEOF',
    'sed -n 1,5p a && npm test', 'node build.mjs &', 'cat a 2>/tmp/err', 'ls >> list.txt',
  ];
  for (const command of runs) assert.deepEqual(classifyShellCommand(command), { kind: 'command', target: command }, command);
});

test('tool calls classify by what they do', () => {
  assert.deepEqual(toolActivityOf('read', { path: '/r/a.ts' }), { kind: 'read', target: '/r/a.ts' });
  assert.deepEqual(toolActivityOf('grep', { pattern: 'foo', path: 'src' }), { kind: 'search', target: 'foo', path: 'src' });
  assert.deepEqual(toolActivityOf('ls', { path: 'src' }), { kind: 'list', target: 'src' });
  assert.deepEqual(toolActivityOf('edit', { path: 'a.ts' }), { kind: 'edit', target: 'a.ts' });
  assert.deepEqual(toolActivityOf('apply_patch', { input: '*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** End Patch' }),
    { kind: 'edit', target: 'a.ts', count: 2 });
  assert.deepEqual(toolActivityOf('webfetch', { url: 'https://x.dev' }), { kind: 'web', target: 'https://x.dev' });
  assert.deepEqual(toolActivityOf('bash', { command: 'npm test' }), { kind: 'command', target: 'npm test' });
  assert.deepEqual(toolActivityOf('Agent', { prompt: 'go' }), { kind: 'other' });
});

test('calls that only keep the agent\'s own records are bookkeeping', () => {
  // The todo tool's name, as its extension registers it.
  const registered = [];
  createTodoExtension()({ on() {}, registerTool: (tool) => registered.push(tool.name) });
  const names = [...CONTEXT_NOTES_TOOL_NAMES, TOOL_SEARCH_TOOL_NAME, ...registered];
  assert.ok(registered.length > 0);
  for (const name of names) assert.deepEqual(toolActivityOf(name, {}), { kind: 'other', bookkeeping: true }, name);
  assert.equal(toolActivityOf('bash', { command: 'npm test' }).bookkeeping, undefined);
});

const project = () => {
  const events = [];
  const projection = new EventProjection({ threadId: 'thread', sessionId: 'session', instanceId: 'instance',
    emit: (event) => events.push(event) });
  projection.project({ type: 'agent_start' });
  return { events, projection };
};

test('every tool row the timeline draws knows what the call does, from its first update to its completion', () => {
  const { events, projection } = project();
  projection.project({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1', args: { command: 'rg -n foo src' } });
  projection.project({ type: 'tool_execution_update', toolName: 'bash', toolCallId: 't1', partialResult: { content: [] } });
  projection.project({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 't1', result: { content: [] }, isError: false });
  const rows = events.filter((event) => event.type.startsWith('item.'));
  assert.deepEqual(rows.map((event) => event.type), ['item.started', 'item.updated', 'item.updated', 'item.completed']);
  const activity = { kind: 'search', target: 'foo', path: 'src' };
  for (const event of rows) assert.deepEqual(event.payload.data.rubatoActivity, activity, event.type);
  // T3 skips tool.started; the update right after it and the completion name the command.
  assert.equal(rows[1].payload.data.command, 'rg -n foo src');
  assert.equal(rows[1].payload.status, 'inProgress');
  assert.equal(rows[3].payload.data.command, 'rg -n foo src');
  assert.equal(projection.toolArgs.size, 0, 'arguments are forgotten when the call ends');
});

test('a quiet tool shows while it runs, and a spawn keeps its own rows', () => {
  const { events, projection } = project();
  projection.project({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'r1', args: { path: 'a.ts' } });
  const update = events.find((event) => event.type === 'item.updated');
  assert.deepEqual(update.payload.data, { toolCallId: 'r1', rubatoActivity: { kind: 'read', target: 'a.ts' } });
  events.length = 0;
  projection.project({ type: 'tool_execution_start', toolName: 'Agent', toolCallId: 'a1', args: { prompt: 'go' } });
  assert.equal(events.filter((event) => event.type === 'item.updated').length, 0);
  assert.equal(events.find((event) => event.type === 'item.started').payload.data.rubatoActivity, undefined);
});

test('a completed assistant message carries its phase to the timeline', () => {
  const { events, projection } = project();
  const commentary = { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'Looking.' }], stopReason: 'toolUse' };
  const answer = { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' };
  projection.project({ type: 'message_end', message: commentary });
  projection.project({ type: 'message_end', message: answer });
  const completed = events.filter((event) => event.type === 'item.completed');
  assert.deepEqual(completed.map((event) => event.payload.data), [{ rubatoPhase: 'commentary' }, { rubatoPhase: 'final_answer' }]);
});
