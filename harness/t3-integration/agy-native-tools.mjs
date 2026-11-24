import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDescriptor } from '../pi-server/src/descriptor.mjs';
import { SessionClient } from '../pi-server/src/client.mjs';
import { ORDINARY_SESSION_LINK_METHODS } from '../pi-server/src/session-link.mjs';
import { clearCompanionEnv } from '../companion/registry.mjs';
import { stockPiSupportEnv } from '../rubato-pi/src/launch.mjs';
import { createSessionMcpTools, listSessionMcpTools } from '../pi-runtime/features/provider-execution/session-mcp.mjs';

// This bridge session lives in memory, with no transcript, so tools that read or write a
// session's saved notes and history window can only refuse or return nothing. agy keeps
// its own conversation record.
export const isSessionRecordTool = name => /^(history_|notes_)/.test(name) ||
  name === 'new_context' || name === 'get_context_remaining';

/** The official AGY MCP process owns one ordinary Rubato workspace session.
 * No model is run by this session. Tools resolve through its live registry and policies.
 */
export function createAgyToolUi(base, elicit, sessionSignal) {
  async function field(message, schema, opts) {
    const signal = opts?.signal ? AbortSignal.any([sessionSignal, opts.signal]) : sessionSignal;
    const answer = await elicit(message, { type: 'object', properties: { answer: schema }, required: ['answer'] }, signal);
    return answer?.action === 'accept' ? answer.content?.answer : undefined;
  }
  return {
    ...base,
    async select(title, options, opts) {
      if (!options?.length) return undefined;
      const answer = await field(title, { type: 'string', title: 'Choose an option', enum: options }, opts);
      return options.includes(answer) ? answer : undefined;
    },
    async confirm(title, message, opts) {
      return await field(`${title}\n\n${message}`, { type: 'boolean', title: 'Approve this request?', default: false }, opts) === true;
    },
    async input(title, placeholder, opts) {
      const answer = await field(title, { type: 'string', title: placeholder || 'Answer' }, opts);
      return typeof answer === 'string' ? answer : undefined;
    },
    async editor(title, prefill) {
      const answer = await field(title, { type: 'string', title: 'Answer', default: prefill ?? '' });
      return typeof answer === 'string' ? answer : undefined;
    },
  };
}

export async function openAgyNativeTools({ cwd = process.cwd(), env = process.env, elicit } = {}) {
  const home = env.HOME || homedir();
  const agentDir = await realpath(env.RUBATO_PI_CODING_AGENT_DIR || path.join(home, '.rubato-pi', 'agent'));
  const descriptor = await readDescriptor(path.join(agentDir, 'server', 'connection.json'));
  if (!descriptor.runtimeRoot) throw new Error('The Rubato engine does not advertise its installed runtime');
  const root = await realpath(descriptor.runtimeRoot);
  const workspace = await realpath(env.RUBATO_AGY_WORKSPACE || cwd);
  const load = file => import(pathToFileURL(path.join(root, file)).href);
  const toolEnv = { ...clearCompanionEnv(env), ...stockPiSupportEnv(), RUBATO_PI_ROLE: 'lead', PI_OFFLINE: '1' };
  const { prepareRubatoCandidate } = await load('rubato-features/rubato-components/candidate-main.mjs');
  const { createRubatoExtensionFactories } = await prepareRubatoCandidate(agentDir);
  const sdk = await load('node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const { emitSessionShutdownEvent } = await load('node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
  const settingsManager = sdk.SettingsManager.create(workspace, agentDir);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json') });
  let linkClient;
  const sessionLink = descriptor.externalLeadTools === true
    ? Object.fromEntries(ORDINARY_SESSION_LINK_METHODS.map(name => [name, async (args = {}) => {
      const { signal, ...wireArgs } = args;
      signal?.throwIfAborted();
      linkClient ??= new SessionClient(descriptor);
      if (!linkClient.client.connected) await linkClient.connect();
      return linkClient.externalLeadTool(workspace, name, wireArgs);
    }])) : undefined;
  const { extensionFactories } = createRubatoExtensionFactories({
    cwd: workspace, agentDir, settingsManager, modelRuntime, env: toolEnv, sessionLink,
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: workspace, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noContextFiles: true, noThemes: true, extensionFactories,
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await sdk.createAgentSession({
    cwd: workspace, agentDir, settingsManager, modelRuntime, resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(workspace),
  });
  const active = new AbortController();
  async function close() {
    active.abort();
    try { await emitSessionShutdownEvent(session.extensionRunner, { type: 'session_shutdown', reason: 'quit' }); }
    finally { session.dispose(); await linkClient?.close(); }
  }
  try {
    const errors = extensionsResult.errors ?? [];
    if (errors.length) throw new Error(`Rubato tools did not load: ${errors.map(error => error.error ?? error.message).join('; ')}`);
    await session.bindExtensions({
      ...(elicit ? { uiContext: createAgyToolUi(session.extensionRunner.getUIContext(), elicit, active.signal) } : {}),
      onError: error => process.stderr.write(`rubato-tools: ${error.error ?? error.message}\n`),
    });
    const tools = createSessionMcpTools({
      signal: active.signal,
      listTools: () => listSessionMcpTools(session).filter(tool => !isSessionRecordTool(tool.name)),
      executeTool: (name, args, options) => session.executeTool(name, args, options),
      alwaysLoad: ['tool_search'],
    });
    return { ...tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
