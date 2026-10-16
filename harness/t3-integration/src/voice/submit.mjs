import { createHash } from 'node:crypto';
import { VoiceSessionError } from './sessions.mjs';

export const voiceEntityId = (sessionId, kind) =>
  `voice-${kind}-${createHash('sha256').update(`${sessionId}:${kind}`).digest('hex').slice(0, 32)}`;
export const voiceThreadId = (id) => voiceEntityId(id, 'thread');
export const voiceMessageId = (id) => voiceEntityId(id, 'message');
export const voiceCommandId = (id, kind) => voiceEntityId(id, `cmd-${kind}`);
// T3 decides under its thread lock whether the message starts now or waits
// behind the running turn. A read here could not: a normal message sent in the
// same moment would turn ours into steer.
export const VOICE_DISPATCH_MODE = Object.freeze({ type: 'queue_after_active' });
// The phone's Shortcut is the author; T3 shows it as the person's own message.
export const VOICE_AUTHOR = Object.freeze({ createdBy: 'user', creationSource: 'mobile' });
const VOICE_RUNTIME_MODE = 'full-access';
const VOICE_INTERACTION_MODE = 'default';

/**
 * Sends one claimed voice session through T3's orchestrator.
 * `dispatch(command)` resolves to `{ runs: [{ id, status, userMessageId }] }`, the runs
 * the command created or changed. Retrying with the same session repeats the same
 * command ids, which T3 answers from its receipt instead of sending twice.
 */
// What the conversation shows as the voice message moves (V1's in-thread notices).
const NOTICES = {
  queued: 'Voice message queued until the current turn finishes.',
  sent: 'Queued voice message sent.',
  cancelled: 'Queued voice message cancelled.',
  failed: 'Voice message was not sent. Check the shortcut status and try again.',
  expired: 'Queued voice message expired without being sent.',
};

export function createSubmitter({ dispatch, readThread, readProject, readRun = async () => null,
  appendNotice = async () => {}, environmentId, now = Date.now }) {
  const deepLinkFor = (threadId) =>
    `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  return {
    deepLinkFor,
    async submit(session) {
      const id = session.voiceSessionId;
      const newThread = session.target === 'new-thread';
      let threadId = session.threadId;
      if (newThread) {
        threadId = voiceThreadId(id);
        // A retry after the create landed finds the thread; creating again would be refused.
        if (!(await readThread(threadId))) {
          const project = await readProject(session.projectId);
          if (!project?.defaultModelSelection) {
            throw new VoiceSessionError('no-project-model', 'Set a default model for this project in T3');
          }
          await dispatch({
            type: 'thread.create', commandId: voiceCommandId(id, 'create'), threadId, ...VOICE_AUTHOR,
            projectId: session.projectId, title: session.text.trim().slice(0, 80) || 'Voice message',
            modelSelection: project.defaultModelSelection,
            // Always full access, as before: nobody watches a phone-started thread for approvals.
            runtimeMode: VOICE_RUNTIME_MODE,
            interactionMode: VOICE_INTERACTION_MODE, branch: null, worktreePath: null,
          });
        }
      }
      const thread = await readThread(threadId);
      if (!thread || thread.archivedAt || thread.deletedAt) {
        throw new VoiceSessionError('thread-unavailable', 'The target conversation is unavailable');
      }
      if (session.expiresAt <= now()) throw new VoiceSessionError('expired-session', 'Voice session expired', 410);
      const messageId = voiceMessageId(id);
      const result = await dispatch({
        type: 'message.dispatch', commandId: voiceCommandId(id, 'send'), threadId, ...VOICE_AUTHOR,
        messageId, text: session.text, attachments: [], dispatchMode: VOICE_DISPATCH_MODE,
        // A new conversation gets its title the way the composer's first message does.
        ...(newThread ? { titleSeed: session.text.trim().slice(0, 80) || 'Voice message' } : {}),
      });
      const run = result?.runs?.find((candidate) => candidate.userMessageId === messageId);
      return {
        status: run?.status === 'queued' ? 'queued' : 'sent',
        threadId, runId: run?.id ?? null, deepLink: deepLinkFor(threadId),
      };
    },
    // The status of the run a queued message waits as, or null once T3 no longer has it.
    async runStatus(session) {
      if (!session.threadId || !session.runId) return null;
      return readRun(session.threadId, session.runId);
    },
    async notice(session, state) {
      const message = NOTICES[state];
      if (!session.threadId || !message) return;
      await appendNotice({ threadId: session.threadId, id: voiceEntityId(session.voiceSessionId, `notice-${state}`), message });
    },
    // Takes a message back out of T3's queue. Resolves false once it already started.
    async withdraw(session) {
      if (!session.threadId || !session.runId) return false;
      try {
        await dispatch({
          type: 'queued-run.cancel', commandId: voiceCommandId(session.voiceSessionId, 'withdraw'),
          threadId: session.threadId, runId: session.runId,
        });
        return true;
      } catch { return false; }
    },
  };
}
