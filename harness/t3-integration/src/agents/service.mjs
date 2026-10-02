// The Agents panel's server half: `/rubato/agents/<action>` on the T3 server lands here
// (RubatoServiceRoute.ts). `transcript` reads a child's conversation from its session file;
// `stop` and `send` go to the thread's live session through the provider's bridge. This
// module imports bridge.mjs by its own path, the same module instance the provider runs.
import { liveBridge } from '../bridge.mjs';
import { readChildTranscript, TASK_ID } from './transcript.mjs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// What the task extension answers when it did not do it. Its reason is meant for a person.
const REFUSED = new Set(['invalid_arguments', 'not_found', 'unavailable', 'scope_denied', 'not_continuable', 'capacity_deferred']);

export function createAgentsService({ bridge = liveBridge, read = readChildTranscript } = {}) {
  const threadOf = (input) => {
    if (typeof input.threadId !== 'string' || !input.threadId) throw fail(400, 'invalid', 'threadId is required');
    return input.threadId;
  };
  const taskOf = (input) => {
    if (typeof input.taskId !== 'string' || !TASK_ID.test(input.taskId)) throw fail(400, 'invalid', 'Unknown agent id');
    return input.taskId;
  };
  const control = async (input, action, message) => {
    const live = bridge();
    if (!live) throw fail(503, 'unavailable', 'The Rubato provider is not running.');
    const outcome = await live.controlAgent(threadOf(input), taskOf(input), action, message);
    if (REFUSED.has(outcome?.kind)) throw fail(409, outcome.kind, outcome.reason ?? 'The agent did not take it.');
    return { outcome: outcome?.kind ?? 'done' };
  };
  return {
    async handle(action, input) {
      if (action === 'transcript') {
        const transcript = await read({ cwd: input.cwd, taskId: taskOf(input), version: input.version });
        const threadId = typeof input.threadId === 'string' ? input.threadId : '';
        return { ...transcript, controllable: Boolean(threadId && bridge()?.controlsAgents(threadId)) };
      }
      if (action === 'stop') return control(input, 'stop');
      if (action === 'send') {
        const message = typeof input.message === 'string' ? input.message.trim() : '';
        if (!message) throw fail(400, 'invalid', 'Write a message first.');
        return control(input, 'send', message);
      }
      throw fail(404, 'unknown-action', `Unknown action: ${action}`);
    },
  };
}

export async function handleAgentsRequest(service, request) {
  if (request.method !== 'POST')
    return Response.json({ error: { code: 'method', message: 'Use POST.' } }, { status: 405 });
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  let input;
  try { input = await request.json(); } catch {
    return Response.json({ error: { code: 'bad-request', message: 'Request body must be JSON.' } }, { status: 400 });
  }
  try {
    return Response.json(await service.handle(action, input ?? {}));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    return Response.json({ error: { code: error?.code ?? 'failed', message: String(error?.message ?? error) } }, { status });
  }
}

let shared;
/** The instance the T3 server uses. */
export function agentsService() {
  shared ??= createAgentsService();
  return shared;
}
