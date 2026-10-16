import { createPresenceTracker } from '../src/voice/targets.mjs';
import { createSessionStore } from '../src/voice/sessions.mjs';
import { createVoiceService } from '../src/voice/service.mjs';
import { createSubmitter } from '../src/voice/submit.mjs';

// A stand-in for T3's orchestrator V2 with the behavior voice relies on: a message
// sent while a run is active waits in the thread's queue (whatever its dispatch
// mode), a repeated command id answers from its receipt, and only a queued run can
// be cancelled.
export function fixture(options = {}) {
  let time = 100_000;
  const now = () => time;
  const threads = new Map([['a', { id: 'a', projectId: 'p', title: 'Conversation A',
    runtimeMode: 'full-access', interactionMode: 'default', activeRunId: null, archivedAt: null, deletedAt: null }]]);
  const projects = new Map([['p', { id: 'p', title: 'Rubato', defaultModelSelection: {
    instanceId: 'rubato', model: 'b-ai/deepseek-v4.1-flash',
  } }]]);
  const commands = [];
  const receipts = new Map();
  const runs = new Map();
  const handle = (command) => {
    switch (command.type) {
      case 'thread.create':
        if (threads.has(command.threadId)) throw new Error('Thread already exists');
        threads.set(command.threadId, {
          id: command.threadId, projectId: command.projectId, title: command.title,
          runtimeMode: command.runtimeMode, interactionMode: command.interactionMode,
          activeRunId: null, archivedAt: null, deletedAt: null,
        });
        return { runs: [] };
      case 'message.dispatch': {
        const thread = threads.get(command.threadId);
        const run = { id: `run-${runs.size + 1}`, threadId: command.threadId, userMessageId: command.messageId,
          status: thread.activeRunId ? 'queued' : 'running' };
        runs.set(run.id, run);
        if (!thread.activeRunId) thread.activeRunId = run.id;
        return { runs: [{ ...run }] };
      }
      case 'queued-run.cancel': {
        const run = runs.get(command.runId);
        if (run?.status !== 'queued') throw new Error(`Run ${command.runId} is not queued.`);
        run.status = 'cancelled';
        return { runs: [{ ...run }] };
      }
      default: throw new Error(`Unexpected command ${command.type}`);
    }
  };
  const t3 = {
    now, environmentId: 'env',
    readThread: async (id) => threads.get(id) ?? null,
    readProject: async (id) => projects.get(id) ?? null,
    listThreads: async () => [...threads.values()],
    dispatch: async (command) => {
      if (receipts.has(command.commandId)) return receipts.get(command.commandId);
      await options.beforeDispatch?.(command);
      const result = handle(command);
      receipts.set(command.commandId, result);
      commands.push(command);
      return result;
    },
  };
  const presence = createPresenceTracker({ now });
  const store = createSessionStore({ now, filename: options.filename });
  const submitter = createSubmitter(t3);
  const service = createVoiceService({ ...t3, presence, store, submitter, defaultProjectId: 'p',
    transcriber: options.transcriber ?? (async () => ({ text: 'Rubato 확인해줘' })),
  });
  const mobile = { sessionId: 'auth', rpcClientId: 1, clientId: 'iphone', clientKind: 'mobile',
    visible: true, focused: true, appState: 'active' };
  const view = (threadId = 'a') => {
    const end = presence.noteSubscription({ ...mobile, threadId });
    presence.noteActivity(mobile);
    return end;
  };
  // The thread's active run finishes and the next queued one starts, as T3 does.
  const finishTurn = (threadId = 'a') => {
    const thread = threads.get(threadId);
    if (thread.activeRunId) runs.get(thread.activeRunId).status = 'completed';
    const next = [...runs.values()].find((run) => run.threadId === threadId && run.status === 'queued');
    if (next) next.status = 'running';
    thread.activeRunId = next?.id ?? null;
  };
  return { ...t3, service, store, presence, threads, projects, commands, runs, mobile, view, finishTurn,
    advance: (ms) => { time += ms; },
    busy: (threadId = 'a') => { threads.get(threadId).activeRunId = 'run-other'; runs.set('run-other', { id: 'run-other', threadId, status: 'running' }); },
    sent: () => commands.filter((c) => c.type === 'message.dispatch'),
    runOf: (messageId) => [...runs.values()].find((run) => run.userMessageId === messageId),
  };
}
