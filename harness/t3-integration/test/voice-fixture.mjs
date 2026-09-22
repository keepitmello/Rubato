import { createPresenceTracker } from '../src/voice/targets.mjs';
import { createSessionStore } from '../src/voice/sessions.mjs';
import { createVoiceService } from '../src/voice/service.mjs';
import { createSubmitter } from '../src/voice/submit.mjs';

export function fixture(options = {}) {
  let time = 100_000;
  const now = () => time;
  const threads = new Map([['a', { id: 'a', projectId: 'p', title: 'Conversation A',
    runtimeMode: 'full-access', interactionMode: 'default', session: { status: 'ready' }, latestTurn: null }]]);
  const projects = new Map([['p', { id: 'p', title: 'Rubato', defaultModelSelection: {
    providerInstanceId: 'rubato', model: 'b-ai/deepseek-v4.1-flash',
  } }]]);
  const commands = [];
  const accepted = new Set();
  const t3 = {
    now, environmentId: 'env',
    readThread: async (id) => threads.get(id),
    readProject: async (id) => projects.get(id),
    listThreads: async () => [...threads.values()],
    dispatch: async (command) => {
      if (accepted.has(command.commandId)) return;
      if (command.type === 'thread.turn.start' && threads.get(command.threadId)?.session?.status === 'running') {
        throw new Error('RUBATO_VOICE_THREAD_BUSY');
      }
      await options.beforeDispatch?.(command);
      accepted.add(command.commandId);
      commands.push(command);
      if (command.type === 'thread.create') threads.set(command.threadId, {
        id: command.threadId, projectId: command.projectId, title: command.title,
        runtimeMode: command.runtimeMode, interactionMode: command.interactionMode, session: null,
      });
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
  return { ...t3, service, store, presence, threads, projects, commands, mobile, view,
    advance: (ms) => { time += ms; },
    sent: () => commands.filter((c) => c.type === 'thread.turn.start'),
  };
}
