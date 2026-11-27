import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acpModelSelection, createCompanionAgyProvider, HYDROGEN, resolveCompanionAgy, runCompanionAgy } from '../src/companion-agy.mjs';
import { scheduledAgy } from '../src/scheduled-agy.mjs';

test('Hydrogen base plus Medium stays Medium on the ACP config-option surface', () => {
  const config = { id: 'model', category: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-hydrogen' }] };
  assert.deepEqual(acpModelSelection({ configOptions: [config] }, HYDROGEN),
    { config, current: 'gemini-4-neon', model: 'gemini-4-hydrogen', effort: 'medium' });
});

test('account selection uses the configured official binary, not an arbitrary provider', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-companion-agy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = path.join(home, 'state');
  await mkdir(state);
  const provider = {
    driver: 'antigravity', enabled: true, config: { binaryPath: '/official/agy', authMethod: 'oauth-personal' },
    environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'rubato-lead' }],
  };
  await writeFile(path.join(state, 'settings.json'), JSON.stringify({
    providerInstances: { agy: provider, other: { ...provider, enabled: false } },
  }));
  const env = { HOME: home, RUBATO_T3_STATE_DIR: state };
  assert.deepEqual(await resolveCompanionAgy({ instanceId: 'agy', model: HYDROGEN }, env),
    { home, profile: path.join(home, '.gemini'), isolated: false, command: '/official/agy', model: HYDROGEN });
  await assert.rejects(resolveCompanionAgy({ instanceId: 'other', model: HYDROGEN }, env), /not configured/);
  assert.equal(await resolveCompanionAgy({ instanceId: 'rubato', model: 'anthropic/other' }, env), null);
});

test('official account routes distinguish the CLI login from an isolated profile without claiming an expired login', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rb-agy-routes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = path.join(home, 'state');
  await mkdir(state);
  const main = {
    driver: 'antigravity', enabled: true, config: { binaryPath: '/official/agy' },
    environment: [{ name: 'RUBATO_LOCAL_AGY_AGENT', value: 'rubato-lead' }],
  };
  const sub = { ...main, environment: [...main.environment, { name: 'RUBATO_LOCAL_AGY_ISOLATED', value: '1' }] };
  await writeFile(path.join(state, 'settings.json'), JSON.stringify({
    providerInstances: {
      main, sub,
      alias: { ...sub, environment: [...sub.environment, { name: 'RUBATO_LOCAL_AGY_LOGIN', value: 'sub' }] },
    },
  }));
  const env = { HOME: home, RUBATO_T3_STATE_DIR: state };
  const mainRoute = `rubato-agy-cli/main/${HYDROGEN}`;
  const subRoute = `rubato-agy-profile/sub/${HYDROGEN}`;
  assert.equal((await resolveCompanionAgy(scheduledAgy(mainRoute), env)).isolated, false);
  assert.equal((await resolveCompanionAgy(scheduledAgy(subRoute), env)).isolated, true);
  for (const [wrong, correct] of [
    [`rubato-agy-profile/main/${HYDROGEN}`, mainRoute],
    [`rubato-agy-cli/sub/${HYDROGEN}`, subRoute],
  ]) {
    await assert.rejects(resolveCompanionAgy(scheduledAgy(wrong), env), error => {
      assert.match(error.message, /route prefix/);
      assert.ok(error.message.includes(correct));
      assert.doesNotMatch(error.message, /no longer holds|expired|sign.?in/i);
      return true;
    });
  }
  // A genuinely different login remains a refusal, not a silent account switch.
  await assert.rejects(resolveCompanionAgy(scheduledAgy(`rubato-agy-profile/alias/${HYDROGEN}`), env),
    /no longer holds the scheduled login/);
});

test('an empty ACP completion is a visible failure, but text and tool-only replies remain valid', async () => {
  for (const mode of ['empty', 'whitespace', 'text', 'tool']) {
    let finish, executeTool, closed = false;
    const result = new Promise(resolve => { finish = resolve; });
    const events = [];
    const route = createCompanionAgyProvider({
      companionId: 'test', account: { model: HYDROGEN },
      createAssistantMessageEventStream: () => ({
        push: event => events.push(event), end: finish,
      }),
      getCurrentSystemPrompt: () => 'Test',
      markResolved: () => {},
      run: async ({ onUpdate }) => {
        if (mode === 'text' || mode === 'whitespace') onUpdate({
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'text' ? 'Connected' : '  ' },
        });
        if (mode === 'tool') await executeTool('reply', { text: 'Connected' });
      },
    });
    route.config.streamSimple(route.config.models[0], {
      messages: [{ role: 'user', content: 'Check the connection' }],
    }, {
      providerExecCwd: '/tmp',
      providerExecuteTool: async () => ({ content: [{ type: 'text', text: 'sent' }] }),
      providerOpenSessionMcp: async options => {
        executeTool = options.executeTool;
        return { url: 'http://localhost/test', headers: [{ value: 'test' }], close: () => { closed = true; } };
      },
    });
    const output = await result;
    assert.equal(closed, true);
    if (mode === 'empty' || mode === 'whitespace') {
      assert.equal(output.stopReason, 'error');
      assert.match(output.errorMessage, /without a response or a Rubato tool call/);
      assert.equal(events.at(-1).type, 'error');
    } else {
      assert.equal(output.stopReason, 'stop');
      assert.equal(events.at(-1).type, 'done');
    }
  }
});

test('ACP picks the requested Hydrogen model before prompting and rejects unavailable models', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'rb-companion-acp-turn-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const peer = path.join(cwd, 'peer.mjs');
  const record = path.join(cwd, 'trace.jsonl');
  await writeFile(peer, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = data => console.log(JSON.stringify(data));
for await (const l of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(l);
  appendFileSync(${JSON.stringify(record)}, JSON.stringify({ method, params }) + '\\n');
  let result = {};
  if (method === 'session/new') result = { sessionId: 'companion', configOptions: [
    { category: 'model', id: 'model', currentValue: 'gemini-4-neon', options: [{ value: ${JSON.stringify(HYDROGEN)} }] },
  ] };
  if (method === 'session/set_config_option') result = { configOptions: [{ id: 'model', currentValue: params.value }] };
  if (method === 'session/prompt') {
    out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'companion', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'connected' },
    } } });
    result = { stopReason: 'end_turn' };
  }
  out({ jsonrpc: '2.0', id, result });
}
`);
  const profile = path.join(cwd, 'profile');
  const updates = [];
  const { spawn } = await import('node:child_process');
  const account = { home: cwd, profile, command: '/official/agy', model: HYDROGEN };
  await runCompanionAgy({ account, cwd, systemPrompt: 'fixture', prompt: [{ type: 'text', text: 'Hi' }],
    mcp: { name: 'rubato_session' }, onUpdate: update => updates.push(update.content.text),
    spawnProcess(command, args, options) {
      assert.equal(command, account.command);
      assert.ok(args.includes('--sandbox'));
      assert.ok(args.includes(profile));
      return spawn(process.execPath, [peer], options);
    },
  });
  assert.deepEqual(updates, ['connected']);
  const trace = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(trace.map(({ method }) => method),
    ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
  assert.equal(trace[2].params.value, HYDROGEN);
  assert.deepEqual(await readdir(path.join(profile, 'config', 'agents')), []);
  assert.throws(() => acpModelSelection({ models: { availableModels: [] } }, HYDROGEN), /does not offer/);
});
