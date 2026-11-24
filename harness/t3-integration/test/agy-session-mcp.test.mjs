import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcpRequest } from '../agy-mcp-server.mjs';
import { isSessionRecordTool } from '../agy-native-tools.mjs';
import { createSessionMcpTools, listSessionMcpTools, openSessionMcpEndpoint } from '../../pi-runtime/features/provider-execution/session-mcp.mjs';

const schema = { type: 'object', properties: { value: { type: 'string' } } };
const tool = name => ({ name, description: `Native ${name}`, parameters: schema });
const request = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });

test('MCP serves the bound session only, including authority changes after tools/list', async () => {
  let allowed = [tool('reply')];
  const calls = [];
  const sessionTools = createSessionMcpTools({
    listTools: () => allowed,
    async executeTool(...args) { calls.push(args); return { content: [{ type: 'text', text: 'sent' }], details: { private: true } }; },
  });
  const dispatch = (method, params) => handleMcpRequest(request(method, params), { sessionTools });
  assert.deepEqual((await dispatch('tools/list')).result.tools, [
    { name: 'reply', description: 'Native reply', inputSchema: schema },
  ]);
  assert.equal((await dispatch('tools/call', { name: 'memory_search' })).result.isError, true);
  assert.equal((await dispatch('tools/call', { name: 'reply', arguments: [] })).result.isError, true);
  assert.deepEqual((await dispatch('tools/call', { name: 'reply', arguments: { value: 'hi' } })).result,
    { content: [{ type: 'text', text: 'sent' }] });
  allowed = [];
  assert.equal((await dispatch('tools/call', { name: 'reply' })).result.isError, true);
  assert.deepEqual(calls, [['reply', { value: 'hi' }, { signal: undefined, activateInactiveTool: true }]]);
});

test('both roles expose lazy native tools, not the other role or hidden tools', () => {
  const definition = (name, exposure = 'direct') => ({ ...tool(name), exposure });
  const make = (callable, tools) => ({ getCallableToolNames: () => callable, getAllTools: () => tools });
  const lead = make(['read'], [definition('read'), definition('team_create', 'search'), definition('private', 'hidden')]);
  const companion = make(['reply'], [definition('reply'), definition('companion_settings', 'search'), definition('private', 'hidden')]);
  assert.deepEqual(listSessionMcpTools(lead).map(tool => tool.name), ['read', 'team_create']);
  assert.deepEqual(listSessionMcpTools(companion).map(tool => tool.name), ['reply', 'companion_settings']);
});

test('MCP returns native rejection and does not run tools after turn cancellation', async () => {
  const abort = new AbortController();
  let count = 0;
  const sessionTools = createSessionMcpTools({
    listTools: () => [tool('reply')],
    signal: abort.signal,
    async executeTool() { count++; throw new Error('Approval denied'); },
  });
  assert.deepEqual(await sessionTools.call('reply'), { isError: true, content: [{ type: 'text', text: 'Approval denied' }] });
  abort.abort();
  await assert.rejects(sessionTools.call('reply'), { name: 'AbortError' });
  assert.equal(count, 1);
});

test('provider MCP endpoints isolate turns and close on cancellation', async () => {
  const abort = new AbortController();
  const executeTool = async () => ({ content: [{ type: 'text', text: 'ok' }] });
  const a = await openSessionMcpEndpoint({ listTools: () => [tool('reply')], executeTool, signal: abort.signal });
  const b = await openSessionMcpEndpoint({ listTools: () => [tool('schedule')], executeTool });
  const send = (endpoint, source = endpoint, method = 'tools/list', params) => fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...Object.fromEntries(source.headers.map(({ name, value }) => [name, value])) },
    body: JSON.stringify(request(method, params)),
  });
  try {
    assert.equal((await send(a, b)).status, 403);
    const list = await (await send(a)).json();
    assert.deepEqual(list.result.tools.map(({ name }) => name), ['reply']);
    const cross = await (await send(a, a, 'tools/call', { name: 'schedule' })).json();
    assert.equal(cross.result.isError, true);
    abort.abort();
    await assert.rejects(send(a));
    assert.equal((await send(b)).status, 200);
  } finally {
    a.close();
    b.close();
  }
});

test('the in-memory bridge session hides tools that need a saved transcript', () => {
  for (const name of ['notes_write_file', 'notes_read_file', 'history_list_items', 'history_read_item', 'new_context', 'get_context_remaining']) {
    assert.equal(isSessionRecordTool(name), true, name);
  }
  for (const name of ['read', 'bash', 'session_list', 'memory_search', 'todo']) assert.equal(isSessionRecordTool(name), false, name);
});
