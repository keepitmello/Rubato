import { VoiceSessionError, textFingerprint, VOICE_SESSION_TTL_MS } from './sessions.mjs';

// How often a message waiting in T3's queue is looked at: it is sent when its turn starts, and
// taken back out as expired when the session's time runs out first (V1's queued TTL).
export const QUEUE_WATCH_MS = 5_000;
import { resolveTarget } from './targets.mjs';

export function createVoiceService({ presence, store, submitter, transcriber,
  readThread, readProject, listThreads, defaultProjectId, now = Date.now, queueWatchMs = QUEUE_WATCH_MS } = {}) {
  let drainPromise;
  let watchTimer;
  let wakeAgain = false;
  let closed = false;
  const publicState = (s) => ({
    voiceSessionId: s.voiceSessionId, target: s.target, threadId: s.threadId ?? null,
    projectId: s.projectId ?? null, label: s.label,
    // 'pending' is a claim on its way to T3; clients have always called that 'sending'.
    status: s.state === 'pending' ? 'sending' : s.state,
    deepLink: s.deepLink ?? null, expiresAt: s.expiresAt, candidates: s.candidates,
    ...(s.error ? { error: s.error } : {}),
  });
  const required = (id) => {
    const session = store.get(id);
    if (!session) throw new VoiceSessionError('unknown-session', 'Voice session not found', 404);
    return session;
  };
  const open = (id) => {
    const session = required(id);
    if (session.expiresAt <= now()) throw new VoiceSessionError('expired-session', 'Voice session expired', 410);
    if (session.state !== 'open') throw new VoiceSessionError('session-closed', 'This voice session is no longer open');
    return session;
  };
  // The text leaves private state as soon as T3 holds it or it will never be sent.
  const available = (thread) => thread && !thread.archivedAt && !thread.deletedAt;
  const notify = async (session, state) => {
    // A notice that fails must not turn a sent message into a second send.
    try { await submitter.notice?.(session, state); } catch { /* the status stays readable over HTTP */ }
  };
  // A message that sat in T3's queue reports how it ended; a direct send needs no notice.
  const finish = async (session, changes) => {
    const wasQueued = session.state === 'queued';
    store.update(session.voiceSessionId, { ...changes, text: undefined, expiresAt: now() + VOICE_SESSION_TTL_MS });
    if (wasQueued || changes.state !== 'sent') await notify(session, changes.state);
  };
  const STARTED_GONE = new Set(['cancelled', 'rolled_back']);
  // A queued message keeps its session's deadline (expiresAt) until it leaves T3's queue.
  const settleQueued = async (session) => {
    if (session.state !== 'queued') return;
    const status = await submitter.runStatus(session);
    if (store.get(session.voiceSessionId)?.state !== 'queued') return;
    if (status === 'queued') {
      if (session.expiresAt > now()) return;
      await finish(session, { state: (await submitter.withdraw(session)) ? 'expired' : 'sent' });
      return;
    }
    await finish(session, { state: status === null || STARTED_GONE.has(status) ? 'cancelled' : 'sent' });
  };
  const watchQueued = () => {
    clearTimeout(watchTimer);
    const queued = store.all().filter((session) => session.state === 'queued');
    if (!queued.length || closed) return;
    const due = Math.min(queueWatchMs, ...queued.map((session) => Math.max(1, session.expiresAt - now())));
    watchTimer = setTimeout(() => { void service.refreshQueued(); }, due);
    watchTimer.unref?.();
  };
  const service = {
    async rememberMobileProject() {
      const decision = resolveTarget({ presence: presence.snapshot(), now: now() });
      if (decision.target === 'existing-thread') {
        const thread = await readThread(decision.threadId);
        if (thread) store.rememberProject(thread.projectId);
      }
    },
    async startSession({ mode = 'mobile' } = {}) {
      if (mode === 'draft') return publicState(store.start({ target: 'draft', label: 'Current input' }));
      if (mode !== 'mobile') throw new VoiceSessionError('invalid-mode', 'Unknown voice mode', 400);
      presence.prune();
      const decision = resolveTarget({ presence: presence.snapshot(), now: now() });
      if (decision.target === 'existing-thread') {
        const thread = await readThread(decision.threadId);
        if (available(thread)) {
          store.rememberProject(thread.projectId);
          return publicState(store.start({
            target: 'existing-thread', threadId: thread.id, projectId: thread.projectId, label: thread.title,
          }));
        }
        decision.target = 'ambiguous';
      }
      if (decision.target === 'ambiguous') {
        const candidates = (await listThreads()).filter(available).slice(0, 100)
          .map((t) => ({ threadId: t.id, projectId: t.projectId, label: t.title }));
        return publicState(store.start({ target: 'ambiguous', label: 'Choose a conversation', candidates }));
      }
      for (const projectId of [store.lastMobileProject, defaultProjectId].filter(Boolean)) {
        const project = await readProject(projectId);
        if (project) return publicState(store.start({ target: 'new-thread', projectId,
          label: `New conversation · ${project.title}` }));
      }
      throw new VoiceSessionError('no-project', 'Configure a default voice project on this Mac');
    },
    async select(id, threadId) {
      const session = open(id);
      if (session.target !== 'ambiguous') throw new VoiceSessionError('target-pinned', 'This target is already pinned');
      const choice = session.candidates.find((candidate) => candidate.threadId === threadId);
      const thread = choice && await readThread(threadId);
      if (!available(thread)) throw new VoiceSessionError('invalid-target', 'Choose an available conversation from the list');
      store.rememberProject(thread.projectId);
      return publicState(store.update(id, { target: 'existing-thread', ...choice, candidates: undefined }));
    },
    async transcribe({ voiceSessionId, ...audio }) {
      const session = open(voiceSessionId);
      if (session.target === 'ambiguous') throw new VoiceSessionError('choose-target', 'Choose a conversation first');
      const result = await transcriber(audio);
      open(voiceSessionId); // Cancellation/expiry while the provider was working.
      return { ...publicState(session), text: result.text };
    },
    async submit({ voiceSessionId, text }) {
      if (typeof text !== 'string' || !text.trim() || text.length > 100_000) {
        throw new VoiceSessionError('invalid-text', 'Provide non-empty text up to 100000 characters', 400);
      }
      const session = required(voiceSessionId);
      const fingerprint = textFingerprint(text);
      if (session.fingerprint) {
        if (session.fingerprint !== fingerprint) throw new VoiceSessionError('different-text', 'This session already submitted different text');
        await drainPromise;
        return publicState(session);
      }
      open(voiceSessionId);
      if (!['existing-thread', 'new-thread'].includes(session.target)) {
        throw new VoiceSessionError('invalid-target', 'This session cannot send messages');
      }
      // Synchronous durable claim excludes concurrent submissions with other text.
      store.update(voiceSessionId, { fingerprint, text, state: 'pending' });
      await service.wake();
      return publicState(session);
    },
    /** The status, after looking at where a queued message is in T3 now. */
    async current(id) {
      const session = required(id);
      try { await settleQueued(session); } catch { /* T3 unreadable: the last known status */ }
      return service.status(id);
    },
    async refreshQueued() {
      for (const session of store.all()) {
        if (closed) return;
        try { await settleQueued(session); } catch { /* looked at again on the next round */ }
      }
      watchQueued();
    },
    status(id) {
      const session = required(id);
      if (session.expiresAt <= now() && session.state === 'open') {
        throw new VoiceSessionError('expired-session', 'Voice session expired', 410);
      }
      return publicState(session);
    },
    async cancel(id) {
      const session = required(id);
      if (session.state === 'queued') {
        // Waiting in T3's queue: take it back out unless its turn already began.
        if (!(await submitter.withdraw(session))) {
          throw new VoiceSessionError('already-sending', 'This message is already being sent');
        }
      } else if (['pending', 'sent'].includes(session.state)) {
        throw new VoiceSessionError('already-sending', 'This message is already being sent');
      }
      await finish(session, { state: 'cancelled' });
      return publicState(session);
    },
    // Hands every pending claim to T3. Runs at submit and once at startup, for
    // claims a restart interrupted.
    wake() {
      if (closed) return Promise.resolve();
      if (drainPromise) { wakeAgain = true; return drainPromise; }
      drainPromise = (async () => {
        do {
          wakeAgain = false;
          for (const session of store.all()) {
            if (closed || session.state !== 'pending') continue;
            if (session.expiresAt <= now()) { await finish(session, { state: 'expired' }); continue; }
            try {
              const result = await submitter.submit(session);
              const placed = { threadId: result.threadId, runId: result.runId, deepLink: result.deepLink };
              if (result.status === 'queued') {
                // T3 holds the text now; the session's deadline still applies until it starts.
                store.update(session.voiceSessionId, { ...placed, state: 'queued', text: undefined });
                await notify(session, 'queued');
              } else await finish(session, { ...placed, state: 'sent' });
            } catch (error) {
              await finish(session, { state: 'failed', error: {
                code: error instanceof VoiceSessionError ? error.code : 'send-failed',
                message: error instanceof VoiceSessionError ? error.message : 'T3 could not accept the message',
              } });
            }
          }
        } while (wakeAgain && !closed);
      })().finally(() => { drainPromise = undefined; watchQueued(); });
      return drainPromise;
    },
    async close() {
      closed = true;
      clearTimeout(watchTimer);
      await drainPromise;
    },
  };
  return service;
}
