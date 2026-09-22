import { createHash } from 'node:crypto';
import { VoiceSessionError } from './sessions.mjs';

export const voiceEntityId = (sessionId, kind) =>
  `voice-${kind}-${createHash('sha256').update(`${sessionId}:${kind}`).digest('hex').slice(0, 32)}`;
export const voiceThreadId = (id) => voiceEntityId(id, 'thread');
export const voiceMessageId = (id) => voiceEntityId(id, 'message');
export const voiceCommandId = (id, kind) => voiceEntityId(id, `cmd-${kind}`);
export const threadBusy = (thread) =>
  ['running', 'starting'].includes(thread.session?.status) ||
  thread.latestTurn?.state === 'running';

export function createSubmitter({ dispatch, readThread, readProject, environmentId, now = Date.now }) {
  const deepLinkFor = (threadId) =>
    `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  return {
    deepLinkFor,
    async submit(session) {
      const id = session.voiceSessionId;
      let threadId = session.threadId;
      if (session.target === 'new-thread') {
        threadId = voiceThreadId(id);
        const project = await readProject(session.projectId);
        if (!project?.defaultModelSelection) {
          throw new VoiceSessionError('no-project-model', 'Set a default model for this project in T3');
        }
        await dispatch({
          type: 'thread.create', commandId: voiceCommandId(id, 'create'), threadId,
          projectId: session.projectId, title: session.text.slice(0, 80),
          modelSelection: project.defaultModelSelection,
          runtimeMode: 'full-access', interactionMode: 'default',
          branch: null, worktreePath: null, createdAt: new Date(session.createdAt).toISOString(),
        });
      }
      const thread = await readThread(threadId);
      if (!thread || thread.archivedAt) throw new VoiceSessionError('thread-unavailable', 'The target conversation is unavailable');
      if (session.expiresAt <= now()) throw new VoiceSessionError('expired-session', 'Voice session expired', 410);
      if (threadBusy(thread)) return { status: 'queued', threadId, deepLink: deepLinkFor(threadId) };
      try {
        await dispatch({
          type: 'thread.turn.start', commandId: voiceCommandId(id, 'send'), threadId,
          // The engine checks this inside its serial command worker. A read here
          // alone cannot prevent a simultaneous normal message turning us into steer.
          onlyWhenIdle: true,
          message: { messageId: voiceMessageId(id), role: 'user', text: session.text, attachments: [] },
          runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode,
          createdAt: new Date(session.createdAt).toISOString(),
        });
      } catch (error) {
        if (String(error?.message).includes('RUBATO_VOICE_THREAD_BUSY')) {
          return { status: 'queued', threadId, deepLink: deepLinkFor(threadId) };
        }
        throw error;
      }
      return { status: 'sent', threadId, deepLink: deepLinkFor(threadId) };
    },
    async notice(session, state) {
      if (!session.threadId) return;
      const summary = ({
        queued: 'Voice message queued until the current turn finishes.',
        sent: 'Queued voice message sent.',
        cancelled: 'Queued voice message cancelled.',
        failed: 'Voice message was not sent. Check the shortcut status and try again.',
        expired: 'Queued voice message expired without being sent.',
      })[state];
      if (!summary) return;
      const createdAt = new Date(now()).toISOString();
      await dispatch({
        type: 'thread.activity.append', commandId: voiceCommandId(session.voiceSessionId, state),
        threadId: session.threadId, createdAt,
        activity: { id: voiceEntityId(session.voiceSessionId, state), createdAt,
          tone: ['failed', 'expired'].includes(state) ? 'error' : 'info',
          kind: 'runtime.warning', summary, payload: { voiceSessionId: session.voiceSessionId, state }, turnId: null },
      });
    },
  };
}
