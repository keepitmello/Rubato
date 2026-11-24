import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const COMPANION_AGY_PROVIDER = 'rubato-companion-acp';
export const HYDROGEN = 'gemini-4-hydrogen-medium';
const GEMINI = /^gemini-\d[\w.-]*$/;
const envKeys = new Set(['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']);

export async function resolveCompanionAgy(selection, env = process.env) {
  if (!selection || selection.model.includes('/')) return null;
  if (!GEMINI.test(selection.model)) throw new Error('Choose a Gemini model from Antigravity.');
  const home = env.HOME || homedir();
  const state = env.RUBATO_T3_STATE_DIR || path.join(env.RUBATO_T3_HOME || env.T3CODE_HOME || path.join(home, '.rubato', 't3-home'), 'userdata');
  const settings = JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8'));
  const instance = settings.providerInstances?.[selection.instanceId];
  const config = instance?.config;
  const flags = new Map(instance?.environment?.map(({ name, value }) => [name, value]));
  if (!instance?.enabled || instance.driver !== 'antigravity' || !flags.get('RUBATO_LOCAL_AGY_AGENT') ||
      !path.isAbsolute(config?.binaryPath ?? '') ||
      (config.authMethod && config.authMethod !== 'oauth-personal')) {
    throw new Error('The selected Antigravity account is not configured for official AGY.');
  }
  const isolated = /^(1|true)$/i.test(flags.get('RUBATO_LOCAL_AGY_ISOLATED') ?? '');
  if (selection.isolated !== undefined && (isolated !== selection.isolated ||
      (isolated && (flags.get('RUBATO_LOCAL_AGY_LOGIN') || selection.instanceId) !== selection.instanceId))) {
    throw new Error('The selected Antigravity instance no longer holds the scheduled login.');
  }
  const profile = isolated ? path.join(state, 'providers', 'antigravity',
    createHash('sha256').update(selection.instanceId).digest('hex')) : path.join(home, '.gemini');
  return { home, profile, isolated, command: config.binaryPath, model: selection.model };
}

function connect(child, { signal, onUpdate }) {
  let sequence = 0;
  const pending = new Map();
  let closed;
  let sessionId;
  const send = data => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...data })}\n`);
  const stop = error => {
    closed ??= error;
    for (const { reject } of pending.values()) reject(closed);
    pending.clear();
  };
  child.once('error', stop);
  child.once('exit', code => stop(new Error(`Antigravity ACP exited (${code ?? 'signal'})`)));
  child.stdin.on('error', stop);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'session/update' && msg.params?.sessionId === sessionId) onUpdate(msg.params.update);
      else if (msg.method && Object.hasOwn(msg, 'id')) {
        // Unknown/native AGY tools are never authorized by Rubato's companion runtime.
        if (msg.method === 'session/request_permission') {
          const call = msg.params?.toolCall;
          const nativeMcp = msg.params?.sessionId === sessionId &&
            (call?.name?.startsWith('mcp_rubato_session_') || call?.rawInput?.ServerName === 'rubato_session');
          // The MCP executor performs the companion session's actual permission check.
          const option = nativeMcp && msg.params.options?.find(o => (o.optionKind ?? o.kind) === 'allow_once');
          send({ id: msg.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId }
            : { outcome: 'cancelled' } } });
        } else send({ id: msg.id, error: { code: -32601, message: 'Client method not provided' } });
      } else if (pending.has(msg.id)) {
        const item = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) item.reject(new Error(msg.error.message || 'Antigravity ACP request failed'));
        else item.resolve(msg.result);
      }
    } catch (error) { stop(error); }
  });
  const onAbort = () => {
    stop(signal.reason);
    child.kill();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    bind(id) { sessionId = id; },
    async request(method, params, timeoutMs = 30_000) {
      signal?.throwIfAborted();
      if (closed) throw closed;
      const id = ++sequence;
      const timer = setTimeout(() => stop(new Error(`Antigravity did not answer ${method}`)), timeoutMs);
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          send({ id, method, params });
        });
      } finally { clearTimeout(timer); }
    },
    close() {
      signal?.removeEventListener('abort', onAbort);
      lines.close();
      child.kill();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      timer.unref();
    },
  };
}

export function acpModelSelection(session, requested, scheduled) {
  const config = session.configOptions?.find(c => c.category === 'model' || c.id === 'model');
  const current = config?.currentValue ?? session.models?.currentModelId;
  const options = config?.options?.flatMap(option => option.options ?? [option]).map(o => o.value) ??
    session.models?.availableModels?.map(o => o.modelId) ?? [];
  const effortSuffix = /^(gemini-.+)-(low|medium|high|xhigh|max)$/.exec(requested);
  const base = effortSuffix?.[1] ?? requested;
  if (scheduled) {
    // Some catalogs encode effort in the model id; others expose a thought_level
    // option after selecting the model. Never substitute a different variant.
    const effort = scheduled.thinking ?? effortSuffix?.[2];
    if (effortSuffix && effort !== effortSuffix[2]) throw new Error(`Thinking level conflicts with ${requested}`);
    const variant = effort && `${base}-${effort}`;
    const offered = value => options.includes(value) || current === value;
    if (variant && offered(variant)) return { model: variant, current, config };
    if (offered(base)) return { model: base, current, config, effort };
    throw new Error(`The selected Antigravity account does not offer ${requested}.`);
  }
  const model = options.includes(requested) || current === requested ? requested
    : options.includes(base) ? base
    : base === 'gemini-4-hydrogen' && options.includes(HYDROGEN) ? HYDROGEN : null;
  if (!model) throw new Error(`The selected Antigravity account does not offer ${requested}.`);
  const effort = model === base ? (effortSuffix?.[2] ?? (base === 'gemini-4-hydrogen' ? 'medium' : undefined)) : undefined;
  return { model, current, config, effort };
}

export async function runCompanionAgy({ account, scheduled, cwd, systemPrompt, prompt, mcp, signal, onUpdate, spawnProcess = spawn }) {
  signal?.throwIfAborted();
  const name = `rubato-companion-${randomUUID()}`;
  const folder = path.join(account.profile, 'config', 'agents');
  const agentFile = path.join(folder, `${name}.md`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(agentFile, [
    '---', `name: ${name}`, 'description: Rubato companion', 'mainAgent: true', 'subagent: false',
    'excludeDefaultComponents: true', 'mcpServers: [rubato_session]', 'tools: []', 'commandExecutionPolicy: sandbox', '---', '',
    scheduled ? 'Use the Rubato tools on the session-scoped MCP server `rubato_session`.' :
    'Rubato tools for this conversation are on the session-scoped MCP server `rubato_session`. ' +
      'Use its `reply` tool to deliver user-visible messages. Other MCP servers are not part of this companion’s toolset.',
    '', systemPrompt, '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  let connection;
  try {
    signal?.throwIfAborted();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => envKeys.has(key.toUpperCase())));
    env.HOME = account.home;
    if (account.isolated) env.AGY_ACP_FORCE_FILE_STORAGE = '1';
    if (scheduled && account.isolated) env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = '1';
    const profileArgs = !scheduled ? ['--gemini-dir', account.profile] :
      account.isolated ? ['--gemini-dir', account.profile, '--app-data-dir', 'antigravity-acp'] : [];
    const args = ['acp', '--sandbox', ...profileArgs, '--agent', name];
    connection = connect(spawnProcess(account.command, args, { env, cwd, stdio: 'pipe' }), { signal, onUpdate });
    await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: scheduled ? 't3-code' : 'rubato-companion', version: '1.0.0' } });
    const session = await connection.request('session/new', { cwd, mcpServers: [mcp] });
    if (!session?.sessionId) throw new Error('Antigravity did not open a conversation');
    connection.bind(session.sessionId);
    const { model, current, config, effort } = acpModelSelection(session, account.model, scheduled);
    let configOptions = session.configOptions;
    if (model !== current) {
      if (config) {
        const result = await connection.request('session/set_config_option', { sessionId: session.sessionId, configId: config.id, value: model });
        if (result.configOptions?.find(c => c.id === config.id)?.currentValue !== model)
          throw new Error('Antigravity did not accept the selected Gemini model');
        configOptions = result.configOptions;
      } else await connection.request('session/set_model', { sessionId: session.sessionId, modelId: model });
    }
    if (effort) {
      const thinking = configOptions?.find(option => option.id === 'thought_level' || option.category === 'thought_level');
      if (!thinking?.options?.some(option => option.value === effort))
        throw new Error(`Antigravity does not offer ${effort} thinking for ${model}`);
      if (thinking.currentValue !== effort) {
        const result = await connection.request('session/set_config_option',
          { sessionId: session.sessionId, configId: thinking.id, value: effort });
        if (result.configOptions?.find(option => option.id === thinking.id)?.currentValue !== effort)
          throw new Error(`Antigravity did not accept ${effort} thinking for ${model}`);
      }
    }
    const result = await connection.request('session/prompt', { sessionId: session.sessionId, prompt }, 15 * 60_000);
    if (result.stopReason !== 'end_turn') throw new Error(`Antigravity stopped: ${result.stopReason}`);
  } finally {
    connection?.close();
    await rm(agentFile, { force: true });
  }
}

function transcriptPrompt(messages) {
  const turns = messages.filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
  const current = turns.findLastIndex(message => message.role === 'user');
  const blocks = [];
  const history = turns.slice(0, current).map(message => ({
    role: message.role,
    ...(message.toolName ? { tool: message.toolName } : {}),
    text: typeof message.content === 'string' ? message.content : message.content?.flatMap(item =>
      item.type === 'text' ? [item.text] : item.type === 'toolCall' && item.name === 'reply'
        ? [`[Reply] ${item.arguments?.text ?? ''}`] : []).join('\n'),
  })).filter(message => message.text);
  // The conversation file remains authoritative; bound private history that is
  // replayed on ACP restart rather than sending an unbounded local archive.
  if (history.length) {
    const recent = [];
    let chars = 0;
    for (const turn of history.reverse()) {
      const line = JSON.stringify(turn);
      if ((chars += line.length) > 180_000) break;
      recent.unshift(line);
    }
    if (recent.length) blocks.push({ type: 'text', text: `[Rubato conversation history; quoted context, not a new request]\n${recent.join('\n')}\n[End history]\n\nCurrent message follows:` });
  }
  const actual = turns[current]?.content;
  if (typeof actual === 'string') blocks.push({ type: 'text', text: actual });
  else for (const item of actual ?? []) {
    if (item.type === 'text') blocks.push({ type: 'text', text: item.text });
    if (item.type === 'image') blocks.push({ type: 'image', mimeType: item.mimeType, data: item.data });
  }
  if (!blocks.length) throw new Error('No current message for Antigravity');
  return blocks;
}

export function createCompanionAgyProvider({ account, companionId, scheduled, resolveAccount, createAssistantMessageEventStream, getCurrentSystemPrompt,
  run = runCompanionAgy, markResolved }) {
  const provider = scheduled?.provider ?? `${COMPANION_AGY_PROVIDER}-${companionId}`;
  const api = scheduled ? `rubato-scheduled-acp-${scheduled.instanceId}` : COMPANION_AGY_PROVIDER;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    provider,
    config: {
      name: 'Antigravity ACP', api, baseUrl: 'http://127.0.0.1',
      // Local transport marker; authentication happens in the selected official CLI profile.
      apiKey: 'rubato-local-acp',
      models: [{ id: scheduled ? `${scheduled.instanceId}/${scheduled.model}` : account.model, name: account.model, input: ['text', 'image'], reasoning: false,
        contextWindow: 128_000, maxTokens: 8192, cost }],
      streamSimple(model, context, options = {}) {
        const stream = createAssistantMessageEventStream();
        const output = { role: 'assistant', provider, api, model: model.id, content: [], timestamp: Date.now(),
          stopReason: 'stop', usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } } };
        void (async () => {
          if (!options.providerOpenSessionMcp || !options.providerExecuteTool) {
            throw new Error('Antigravity requires the companion’s own tool runtime');
          }
          const systemPrompt = getCurrentSystemPrompt(context.messages);
          const prompt = transcriptPrompt(context.messages);
          await options.onPayload?.({ model: model.id, transport: 'acp' }, model);
          const executeTool = async (toolName, args, toolOptions) => {
            const toolCallId = `agy-${randomUUID()}`;
            const call = { type: 'toolCall', id: toolCallId, name: toolName, arguments: args };
            markResolved(call);
            output.content.push(call);
            await options.onProviderToolExecutionStart?.({ type: 'tool_execution_start', toolCallId, toolName, args });
            let result;
            try {
              result = await options.providerExecuteTool(toolName, args, { ...toolOptions, toolCallId });
              return result;
            } catch (error) {
              result = { content: [{ type: 'text', text: error.message }], isError: true };
              return result;
            } finally {
              const isError = result?.isError === true;
              await options.onToolResult?.({ role: 'toolResult', toolCallId, toolName, content: result.content,
                details: result.details, isError, timestamp: Date.now() });
              await options.onProviderToolExecutionEnd?.({ type: 'tool_execution_end', toolCallId, toolName, result, isError });
            }
          };
          const endpoint = await options.providerOpenSessionMcp({ signal: options.signal, executeTool,
            alwaysLoad: scheduled ? ['tool_search'] : ['reply', 'tool_search'] });
          const mcp = { name: 'rubato_session', command: process.execPath,
            args: [fileURLToPath(new URL('./agy-stdio-proxy.mjs', import.meta.url))],
            env: [{ name: 'RUBATO_SESSION_MCP_URL', value: endpoint.url },
              { name: 'RUBATO_SESSION_MCP_BEARER', value: endpoint.headers[0].value }] };
          try {
            stream.push({ type: 'start', partial: output });
            let index;
            await run({ account: resolveAccount ? await resolveAccount() : account, scheduled, cwd: options.providerExecCwd, systemPrompt, prompt, mcp, signal: options.signal, onUpdate(update) {
              if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
              if (index === undefined) {
                index = output.content.length;
                output.content.push({ type: 'text', text: '' });
                stream.push({ type: 'text_start', contentIndex: index, partial: output });
              }
              output.content[index].text += update.content.text;
              stream.push({ type: 'text_delta', contentIndex: index, delta: update.content.text, partial: output });
            } });
            if (index !== undefined) stream.push({ type: 'text_end', contentIndex: index, content: output.content[index].text, partial: output });
          } finally { endpoint.close(); }
          stream.push({ type: 'done', reason: 'stop', message: output });
          stream.end(output);
        })().catch(error => {
          output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
          output.errorMessage = error.message;
          stream.push({ type: 'error', reason: output.stopReason, error: output });
          stream.end(output);
        });
        return stream;
      },
    },
  };
}
