import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { handleMcpRequest, runStdioServer } from '../agy-mcp-server.mjs';
import { createAgyToolUi } from '../agy-native-tools.mjs';
import { fileURLToPath } from 'node:url';

test('actual stdio round-trip resumes only the matching, explicitly accepted form', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const reader = createInterface({ input: output })[Symbol.asyncIterator]();
  const send = record => input.write(JSON.stringify({ jsonrpc: '2.0', ...record }) + '\n');
  const next = async () => JSON.parse((await reader.next()).value);
  const session = new AbortController();
  let writes = 0;
  const server = runStdioServer(input, output, {}, async (message, opts) => {
    if (message.method !== 'tools/call') return handleMcpRequest(message, opts);
    const approved = await createAgyToolUi({}, opts.elicit, session.signal)
      .confirm('Permission required', 'Write a fixture file', { signal: opts.signal });
    if (approved) writes++;
    return { jsonrpc: '2.0', id: message.id, result: { approved } };
  });
  send({ method: 'initialize', id: 1, params: { capabilities: { elicitation: { form: {} } } } });
  assert.equal((await next()).id, 1);
  for (const [id, action, answer, expected] of [
    [2, 'accept', true, true], [3, 'accept', 'true', false], [4, 'decline', true, false],
  ]) {
    send({ method: 'tools/call', id });
    const form = await next();
    assert.equal(form.method, 'elicitation/create');
    assert.match(form.params.message, /Write a fixture file/);
    send({ id: form.id, result: { action, content: { answer } } });
    assert.deepEqual((await next()).result, { approved: expected });
  }
  send({ method: 'tools/call', id: 5 });
  const fifth = await next();
  send({ method: 'notifications/cancelled', params: { requestId: 5 } });
  assert.equal((await next()).params.requestId, fifth.id);
  send({ id: fifth.id, result: { action: 'accept', content: { answer: true } } });
  send({ method: 'ping', id: 6 });
  assert.equal((await next()).id, 6);
  assert.equal(writes, 1);
  input.end();
  await server;
  output.end();
});

test('the ACP adapter binds approval to the active session and rejects a wrong token', { timeout: 10_000 }, async t => {
  const bridge = fileURLToPath(new URL('../agy-acp-approval.mjs', import.meta.url));
  const fixture = `
    import { createInterface } from 'node:readline';
    const url = process.env.RUBATO_AGY_APPROVAL_URL;
    const token = process.env.RUBATO_AGY_APPROVAL_TOKEN;
    const submit = bearer => fetch(url, {method:'POST', headers:{authorization:bearer}, body:JSON.stringify({
      message:'Approve temporary fixture', requestedSchema:{type:'object', properties:{answer:{type:'boolean'}}}
    })});
    for await (const line of createInterface({input:process.stdin})) {
      const {id,method} = JSON.parse(line);
      const denied = await submit('Bearer invalid');
      const granted = await submit(token);
      console.log(JSON.stringify({jsonrpc:'2.0', id, result:{
        wrongToken:denied.status, result:await granted.json()
      }}));
      break;
    }
  `;
  const peer = spawn(process.execPath, [bridge, process.execPath, '--input-type=module', '-e', fixture], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => peer.kill());
  const reader = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
  const send = record => peer.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...record }) + '\n');
  const next = async () => JSON.parse((await reader.next()).value);
  send({ id: 1, method: 'session/prompt', params: { sessionId: 'room-fixture', prompt: [] } });
  const request = await next();
  assert.equal(request.method, 'elicitation/create');
  assert.equal(request.params.sessionId, 'room-fixture');
  assert.equal(request.params.message, 'Approve temporary fixture');
  send({ id: request.id, result: { action: 'accept', content: { answer: true } } });
  assert.deepEqual(await next(), { jsonrpc: '2.0', id: 1, result: {
    wrongToken: 403, result: { action: 'accept', content: { answer: true } },
  } });
});
