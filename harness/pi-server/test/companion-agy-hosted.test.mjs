import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createCompanion } from '../../companion/manage.mjs';
import { serveProfile } from '../src/profile-server.mjs';
import { loadHostedRuntime } from '../src/hosted-runtime.mjs';
import { SessionClient } from '../src/client.mjs';
import { HYDROGEN } from '../src/companion-agy.mjs';

const candidate = process.env.RUBATO_TEST_CANDIDATE;
const liveBinary = process.env.RUBATO_TEST_AGY_BINARY;
const defaultsDir = path.resolve(import.meta.dirname, '../../prompts/companion');
const otherModel = 'gemini-4-neon';

test('the hosted companion room starts on Hydrogen, executes reply, and resumes its explicit model on restart',
  { skip: !candidate, timeout: 45_000 }, async t => {
    const root = await mkdtemp('/tmp/rbagy-');
    const env = {
      HOME: root, RUBATO_COMPANIONS_FILE: path.join(root, 'companions.json'),
      RUBATO_T3_STATE_DIR: path.join(root, 't3'), PI_OFFLINE: '1',
      RUBATO_PROMPTS_DIR: path.dirname(defaultsDir),
    };
    const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    let engine, client;
    t.after(async () => {
      await client?.close();
      await engine?.close();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    const executable = path.join(root, 'fixture-agy');
    const trace = path.join(root, 'trace.jsonl');
    await writeFile(executable, `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const out = data => console.log(JSON.stringify(data));
const sessionId = 'acp-fixture';
let model = ${JSON.stringify(otherModel)};
let mcp;
forCommand();
async function forCommand() {
 for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  let result = {};
  if (method === 'session/new') {
    mcp = params.mcpServers[0];
    result = { sessionId, configOptions: [{ id: 'model', category: 'model', currentValue: model,
      options: [{ value: ${JSON.stringify(HYDROGEN)} }, { value: ${JSON.stringify(otherModel)} }] }] };
  }
  if (method === 'session/set_config_option') {
    model = params.value;
    result = { configOptions: [{ id: 'model', currentValue: model }] };
  }
  if (method === 'session/prompt') {
    const proxy = spawn(mcp.command, mcp.args, { env: Object.fromEntries(mcp.env.map(e => [e.name, e.value])) });
    proxy.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'reply', arguments: { text: 'Observed ' + model } } }) + '\\n');
    let answer = '';
    for await (const chunk of proxy.stdout) answer += chunk;
    const [inventory, reply] = answer.trim().split('\\n').filter(Boolean).map(JSON.parse);
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ model, text: params.prompt.map(part => part.text).filter(Boolean).join('\\n'),
      tools: inventory?.result?.tools?.map(tool => tool.name), reply: reply?.result }) + '\\n');
    result = { stopReason: 'end_turn' };
  }
  out({ jsonrpc: '2.0', id, result });
 }
}
`, { mode: 0o700 });
    await mkdir(env.RUBATO_T3_STATE_DIR);
    const instanceId = 'agy-fixture';
    await writeFile(path.join(env.RUBATO_T3_STATE_DIR, 'settings.json'), JSON.stringify({ providerInstances: {
      [instanceId]: { driver: 'antigravity', enabled: true, config: { binaryPath: executable },
        environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'rubato-lead' }] },
    } }));
    const { id, home } = createCompanion({ env, defaultsDir, modelSelection: { instanceId, model: HYDROGEN } });
    const agentDir = path.join(root, 'agent');
    const socketPath = path.join(root, 'engine.sock');
    async function start() {
      engine = await serveProfile({ agentDir, socketPath, runtimeRoot: candidate, onError: error => t.diagnostic(error.message) });
      client = await new SessionClient({ socketPath, serverId: engine.serverId, timeoutMs: 10_000 }).connect();
    }
    async function waitForTurn(count) {
      for (let i = 0; i < 100; i++) {
        const rows = await readFile(trace, 'utf8').then(text => text.trim().split('\n').map(JSON.parse), () => []);
        const state = await client.command({ type: 'get_state' });
        if (rows.length >= count && !state.isStreaming) return rows.at(-1);
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      const history = await client.command({ type: 'get_messages' });
      assert.fail(`No ACP turn ${count}: ${JSON.stringify(history).slice(-2500)}`);
    }
    await start();
    const { sessionId } = await client.create({ cwd: home, companion: true, companionId: id, title: 'New companion' });
    await client.attach(sessionId);
    assert.equal((await client.command({ type: 'get_state' })).model.id, HYDROGEN);
    await client.command({ type: 'prompt', message: 'First message in the room.' });
    let observed = await waitForTurn(1);
    assert.match(observed.text, /First message in the room\./);
    assert.equal(observed.model, HYDROGEN);
    for (const name of ['reply', 'companion_settings', 'inbox_list', 'user_schedule', 'image_create']) {
      assert.ok(observed.tools.includes(name), `Missing native companion tool: ${name}`);
    }
    assert.equal(observed.reply?.isError, undefined, JSON.stringify(observed.reply));
    assert.match(observed.reply?.content?.[0]?.text ?? '', /sent to the user/i);
    const selected = await client.command({ type: 'set_companion_model', modelSelection: { instanceId, model: otherModel } });
    assert.equal(selected.id, otherModel);
    await client.close(); await engine.close();
    await start();
    await client.attach(sessionId);
    assert.equal((await client.command({ type: 'get_state' })).model.id, otherModel);
    const runtime = await loadHostedRuntime({ runtimeRoot: candidate, agentDir });
    await runtime.sessionLink.wake({ to: sessionId, what: 'schedule', text: 'Scheduled message in the same room.' });
    observed = await waitForTurn(2);
    assert.equal(observed.model, otherModel);
    assert.match(observed.text, /Scheduled message in the same room\./);
  });

test('a newly created Rubato room gets its first live Hydrogen turn through official ACP',
  { skip: !candidate || !liveBinary, timeout: 150_000 }, async t => {
    const root = await mkdtemp('/tmp/rbagy-live-');
    const env = {
      RUBATO_COMPANIONS_FILE: path.join(root, 'companions.json'),
      RUBATO_T3_STATE_DIR: path.join(root, 't3'), PI_OFFLINE: '1', RUBATO_PROMPTS_DIR: path.dirname(defaultsDir),
      RUBATO_DEFAULT_COMPANION_HOME: path.join(root, 'default-companion'),
    };
    const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    let engine, client;
    t.after(async () => {
      await client?.close();
      await engine?.close();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    // Use the official account while keeping every Rubato companion record in the fixture.
    const instanceId = 'agy-live-fixture';
    await mkdir(env.RUBATO_T3_STATE_DIR);
    await writeFile(path.join(env.RUBATO_T3_STATE_DIR, 'settings.json'), JSON.stringify({ providerInstances: {
      [instanceId]: { driver: 'antigravity', enabled: true, config: { binaryPath: liveBinary },
        environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'rubato-lead' }] },
    } }));
    // createCompanion stores app-made homes next to this isolated registry.
    const { id, home } = createCompanion({ env, defaultsDir, modelSelection: { instanceId, model: HYDROGEN } });
    const agentDir = path.join(root, 'agent');
    const socketPath = path.join(root, 'engine.sock');
    engine = await serveProfile({ agentDir, socketPath, runtimeRoot: candidate, onError: error => t.diagnostic(error.message) });
    client = await new SessionClient({ socketPath, serverId: engine.serverId, timeoutMs: 120_000 }).connect();
    const { sessionId } = await client.create({ cwd: home, companion: true, companionId: id, title: 'New companion' });
    await client.attach(sessionId);
    assert.equal((await client.command({ type: 'get_state' })).model?.id, HYDROGEN);
    await client.command({ type: 'prompt', message: '연결 확인이야. 사용자에게 답하는 도구를 한 번 써서 “수소 연결됐어”라고 짧게 말해줘.' });
    const end = Date.now() + 105_000;
    while (Date.now() < end) {
      const response = await client.command({ type: 'get_messages' });
      const messages = response?.messages ?? response;
      const last = messages.findLast(message => message.role === 'assistant');
      if (last?.stopReason && last.stopReason !== 'stop') assert.fail(last.errorMessage ?? last.stopReason);
      if (last?.stopReason === 'stop' && messages.some(message => message.role === 'toolResult' && message.toolName === 'reply' && !message.isError)) {
        assert.equal(last.model, HYDROGEN);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.fail('No completed native reply arrived through live Hydrogen');
  });
