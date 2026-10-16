import { VoiceSessionError, textFingerprint, VOICE_SESSION_TTL_MS } from './sessions.mjs';
import { resolveTarget } from './targets.mjs';

export function createVoiceService({ presence, store, submitter, transcriber,
  readThread, readProject, listThreads, defaultProjectId, now = Date.now } = {}) {
  let drainPromise;
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
  const finish = (session, changes) => {
    store.update(session.voiceSessionId, { ...changes, text: undefined, expiresAt: now() + VOICE_SESSION_TTL_MS });
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
      finish(session, { state: 'cancelled' });
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
            if (session.expiresAt <= now()) { finish(session, { state: 'expired' }); continue; }
            try {
              const result = await submitter.submit(session);
              finish(session, {
                state: result.status, threadId: result.threadId, runId: result.runId, deepLink: result.deepLink,
              });
            } catch (error) {
              finish(session, { state: 'failed', error: {
                code: error instanceof VoiceSessionError ? error.code : 'send-failed',
                message: error instanceof VoiceSessionError ? error.message : 'T3 could not accept the message',
              } });
            }
          }
        } while (wakeAgain && !closed);
      })().finally(() => { drainPromise = undefined; });
      return drainPromise;
    },
    async close() {
      closed = true;
      await drainPromise;
    },
  };
  return service;
}
