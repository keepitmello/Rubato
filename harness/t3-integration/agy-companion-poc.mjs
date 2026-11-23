// Opt-in live smoke test. Uses the official AGY login, never the real companion's home.
// Run: node harness/t3-integration/agy-companion-poc.mjs [gemini-model-id]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { composeCompanionPrompt, defaultPiecePath, writePiece, writeProfile } from '../companion/companion.mjs';
import { openInbox } from '../companion/inbox.mjs';
import { createCompanionHomeFactories } from '../pi-runtime/features/companion-home/index.mjs';
import { agyHome, findAgy } from './agy-lead.mjs';
import { runStdioServer, handleMcpRequest } from './agy-mcp-server.mjs';

const script = fileURLToPath(import.meta.url);
const defaultsDir = fileURLToPath(new URL('../prompts/companion/', import.meta.url));
const toolName = 'inbox_list';
const pocEnv = (root) => ({
  RUBATO_COMPANION_ID: 'agy-poc',
  RUBATO_COMPANION_MADE_IN_APP: '1',
  RUBATO_COMPANION_HOME: path.join(root, 'companion'),
  RUBATO_COMPANIONS_FILE: path.join(root, 'companions.json'),
});

async function serveInbox(root) {
  const [{ factory }] = createCompanionHomeFactories({ env: pocEnv(root) });
  let tool;
  factory({
    registerTool(candidate) { if (candidate.name === toolName) tool = candidate; },
    on() {}, // This isolated read-only tool has no hooks; do not attach the other tools' hooks.
  });
  assert.ok(tool);
  await runStdioServer(process.stdin, process.stdout, {}, async (request) => {
    const reply = (result) => ({ jsonrpc: '2.0', id: request.id, result });
    if (request?.method === 'tools/list') {
      return reply({ tools: [{ name: tool.name, description: tool.description, inputSchema: tool.parameters,
        _meta: { 'antigravity/alwaysLoad': true } }] });
    }
    if (request?.method === 'tools/call') {
      const { name, arguments: args = {} } = request.params ?? {};
      const { status, source, unlinked, limit } = args ?? {};
      const properties = tool.parameters.properties;
      if (name !== tool.name || !args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some((key) => !Object.hasOwn(properties, key)) ||
          (status !== undefined && !properties.status.enum.includes(status)) ||
          (source !== undefined && typeof source !== 'string') ||
          (unlinked !== undefined && typeof unlinked !== 'boolean') ||
          (limit !== undefined && (!Number.isInteger(limit) ||
              limit < properties.limit.minimum || limit > properties.limit.maximum))) {
        return reply({ isError: true, content: [{ type: 'text', text: 'Invalid inbox_list call' }] });
      }
      const { content } = await tool.execute(String(request.id), args);
      await writeFile(path.join(root, 'inbox-called'), 'yes', { mode: 0o600 });
      return reply({ content });
    }
    return handleMcpRequest(request);
  });
}

async function run(modelArg) {
  const agy = await findAgy(process.env);
  assert.ok(agy, 'Install and sign into the official agy CLI first');
  const home = agyHome(process.env) || homedir();
  const root = await mkdtemp(path.join(tmpdir(), 'rubato-agy-companion-'));
  const agent = `rubato-companion-poc-${randomUUID().slice(0, 8)}`;
  const profile = path.join(root, 'gemini');
  const agentFile = path.join(profile, 'config', 'agents', `${agent}.md`);
  let child;
  let currentStage = 'prepare';
  const pending = new Map();
  let nextId = 0;
  let answer = '';
  let stderr = '';
  let allowedInbox = false;
  let inTurn = false;
  const isInbox = (event) => event?.name === `mcp_rubato_companion_poc_${toolName}` ||
    (event?.rawInput?.ServerName === 'rubato_companion_poc' && event.rawInput.ToolName === toolName);
  const stop = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  try {
    const env = pocEnv(root);
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const name = `노을-${randomUUID().slice(0, 8)}`;
    const memory = `달빛쿠키-${randomUUID().slice(0, 8)}`;
    const title = `인박스-${randomUUID().slice(0, 8)}`;
    writeProfile({ facts: { name } }, env);
    writePiece('memory', `사용자가 가장 좋아하는 간식 이름은 ${memory}이다.`, { defaultsDir, env });
    const inbox = openInbox({ env });
    try { inbox.add({ title }); } finally { inbox.close(); }
    const toolsFile = defaultPiecePath(defaultsDir, 'tools', env);
    const prompt = composeCompanionPrompt({ defaultsDir, env, readFile: (file) => file === toolsFile
      ? '# 이 테스트 대화의 도구\n인박스는 `inbox_list`로 읽어. 사용자에게는 이 대화에서 텍스트로 직접 대답해. 다른 도구나 통로는 연결돼 있지 않아.'
      : readFileSync(file, 'utf8') });
    assert.ok(prompt.includes(name) && prompt.includes(memory) && !prompt.includes(title));
    await mkdir(path.dirname(agentFile), { recursive: true });
    const mcpServers = {
      rubato_companion_poc: { command: process.execPath, args: [script, '--serve-inbox', root], eager: true },
    };
    await writeFile(path.join(profile, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers }), { mode: 0o600 });
    await writeFile(agentFile, `---\nname: ${agent}\ndescription: Isolated Rubato companion smoke test\nmainAgent: true\nsubagent: false\nexcludeDefaultComponents: true\ninheritMcp: true\ntools:\n  - read_file\ncommandExecutionPolicy: sandbox\n---\n\n${prompt}\n`, { flag: 'wx', mode: 0o600 });
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'].includes(key)));
    child = spawn(agy, ['acp', '--sandbox', '--gemini-dir', profile, '--agent', agent], {
      cwd: workspace, env: { ...childEnv, HOME: home, GEMINI_HOME: profile },
    });
    child.on('error', stop);
    child.on('exit', (code) => stop(new Error(`agy exited (${code}) during ${currentStage}\n${stderr}`)));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.stdin.on('error', stop);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && Object.hasOwn(message, 'id')) {
        if (message.method === 'session/request_permission') {
          const call = message.params?.toolCall;
          if (process.env.RUBATO_AGY_POC_TRACE) console.error('Permission:', JSON.stringify(message.params));
          const option = inTurn && allowedInbox && isInbox(call)
            ? message.params.options.find(({ optionKind, kind }) => (optionKind ?? kind) === 'allow_once')
            : undefined;
          send({ id: message.id, result: { outcome: option
            ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
        } else {
          send({ id: message.id, error: { code: -32601, message: 'Client operation not supported by smoke test' } });
        }
      } else if (message.method === 'session/update') {
        const update = message.params.update;
        if (process.env.RUBATO_AGY_POC_TRACE && update.sessionUpdate.startsWith('tool_call')) console.error('Tool:', JSON.stringify(update));
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') answer += update.content.text;
        if (update.sessionUpdate === 'tool_call' && (!allowedInbox || !isInbox(update))) {
          stop(new Error(`Unexpected tool in isolated smoke test: ${update.name ?? update.title}`));
        }
      } else if (pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${currentStage}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      }
    });
    const request = async (method, params) => {
      currentStage = method;
      const id = ++nextId;
      const timeout = setTimeout(() => stop(new Error(`${method} timed out\n${stderr}`)), 90_000);
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          send({ id, method, params });
        });
      } finally { clearTimeout(timeout); }
    };
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'rubato-companion-poc', version: '0.0.1' } });
    console.log('ACP', JSON.stringify({ agent: init.agentInfo, mcp: init.agentCapabilities?.mcpCapabilities }));
    const session = await request('session/new', { cwd: workspace, mcpServers: [{
      name: 'rubato_companion_poc', command: process.execPath, args: [script, '--serve-inbox', root], env: [],
    }] });
    const { sessionId } = session;
    const config = session.configOptions?.find(({ category, id }) => category === 'model' || id === 'model');
    const current = config?.currentValue ?? session.models?.currentModelId;
    const models = config?.options?.flatMap((option) => option.options ?? [option]).map(({ value }) => value) ??
      session.models?.availableModels?.map(({ modelId }) => modelId) ?? [];
    const model = modelArg ?? (/^gemini-/i.test(current ?? '') ? current
      : models.find((id) => /^gemini-.*neon/i.test(id)) ?? models.find((id) => /^gemini-/i.test(id)));
    assert.ok(/^gemini-/i.test(model ?? '') && (model === current || models.includes(model)),
      `Expected an available Gemini model. Current: ${current}; listed: ${models.join(', ')}`);
    if (model !== current) {
      if (config) {
        const set = await request('session/set_config_option', { sessionId, configId: config.id, value: model });
        assert.equal(set.configOptions?.find(({ id }) => id === config.id)?.currentValue, model);
      } else {
        await request('session/set_model', { sessionId, modelId: model });
      }
    }
    console.log('Model:', model);
    async function ask(text) {
      answer = '';
      inTurn = true;
      try {
        const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
        assert.equal(result.stopReason, 'end_turn');
        return answer;
      } finally { inTurn = false; }
    }
    const identity = await ask('도구를 쓰지 말고 네 이름과 내가 제일 좋아하는 간식 이름을 그대로 알려줘.');
    assert.ok(identity.includes(name) && identity.includes(memory), `Identity and memory not found in answer: ${identity}`);
    console.log('Identity + resident memory:', identity.trim());
    allowedInbox = true;
    const lookup = await ask('rubato_companion_poc 서버의 inbox_list로 인박스를 한 번 읽고 제목을 그대로 알려줘. 실패하면 다른 도구를 쓰지 말고 알려줘.');
    assert.equal(await readFile(path.join(root, 'inbox-called'), 'utf8').catch(() => ''), 'yes',
      `Native inbox_list was not called. Answer: ${lookup}`);
    assert.ok(lookup.includes(title), `MCP result missing from answer: ${lookup}`);
    console.log('Native inbox_list via MCP:', lookup.trim());
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill('SIGKILL');
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--serve-inbox') await serveInbox(process.argv[3]);
else await run(process.argv[2]);
