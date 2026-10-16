import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export const VOICE_SESSION_TTL_MS = 10 * 60_000;
export const textFingerprint = (text) => createHash('sha256').update(text).digest('hex');
export class VoiceSessionError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'VoiceSessionError';
    this.code = code;
    this.status = status;
  }
}

// Persist the claim BEFORE dispatch. The T3 command ids are stable, so a restart
// after dispatch but before the receipt retries the same command and T3 answers
// it from its receipt.
export function createSessionStore({ now = Date.now, filename, newId = randomUUID,
  ttlMs = VOICE_SESSION_TTL_MS } = {}) {
  let saved = { version: 1, lastMobileProject: null, sessions: [] };
  if (filename) {
    try {
      saved = JSON.parse(readFileSync(filename, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error('Invalid voice state');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // A claim that had not reached T3 is sent again. Files from before T3 kept the
  // queue held such claims as 'sending' or as 'queued' with their text still present.
  const unsent = (session) => session.state === 'sending' ||
    (session.state === 'queued' && session.text !== undefined);
  const sessions = new Map(saved.sessions.map((session) => [session.voiceSessionId, {
    ...session, state: unsent(session) ? 'pending' : session.state,
  }]));
  const persist = () => {
    if (!filename) return;
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = `${filename}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...saved, sessions: [...sessions.values()] }), { mode: 0o600 });
    renameSync(temp, filename);
  };
  const store = {
    all: () => [...sessions.values()],
    get: (id) => sessions.get(id),
    start(target) {
      store.prune();
      if (sessions.size >= 100) throw new VoiceSessionError('too-many-sessions', 'Too many voice sessions', 429);
      const session = { ...target, voiceSessionId: newId(), createdAt: now(),
        expiresAt: now() + ttlMs, state: 'open' };
      sessions.set(session.voiceSessionId, session);
      persist();
      return session;
    },
    update(id, changes) {
      const session = sessions.get(id);
      if (!session) throw new VoiceSessionError('unknown-session', 'Voice session not found', 404);
      Object.assign(session, changes);
      persist();
      return session;
    },
    prune() {
      for (const [id, session] of sessions) {
        // Claims not yet handed to T3 are resolved by the service, not silently lost.
        if (session.state !== 'pending' && session.expiresAt <= now()) sessions.delete(id);
      }
      persist();
    },
    get lastMobileProject() { return saved.lastMobileProject; },
    rememberProject(projectId) {
      if (projectId === saved.lastMobileProject) return;
      saved.lastMobileProject = projectId;
      persist();
    },
  };
  return store;
}
