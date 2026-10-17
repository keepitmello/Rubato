import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionClient } from './client.mjs';

/*
 * A restart (SIGTERM from `rubato restart`, an update, the app's Restart) used to abort every
 * running turn: the tool call in flight was cut, and the app showed "Pi process exited
 * unexpectedly". Now the engine drains first:
 *
 *   1. The drain gate (pi-runtime features/drain-gate) closes. A run that reaches its next
 *      model request waits there; the reply it was writing and the tool calls it asked for
 *      finish and are in the session file.
 *   2. Every attached presentation reads `restarting` on its session state, so the app keeps
 *      the turn open across the gap instead of failing it (t3-integration rpc-connection.mjs).
 *   3. The sessions the next engine must take up go to `server/resume.json`, written at the
 *      start (a kill during the drain still resumes them) and again once every run waits.
 *   4. The engine closes. The abort that closes a session ends a waiting run without a message.
 *
 * The next engine reads the file once, removes it, and takes each session up through its own
 * socket: a run in flight continues from its tool results with no new message
 * (conversation-rewind `continue` with `resume`); a lead that was only waiting on children is
 * reopened, and the task extension revives its children and continues their turns.
 *
 * A tool that does not finish within the drain is cut. Its call gets a result saying the restart
 * stopped it, so the model decides whether to run it again.
 */

/** How long a restart waits for running tool calls before it cuts them. */
export const DRAIN_TIMEOUT_MS = 120_000;
/** Every run must wait at the gate this long: a run between two loops is not finished yet. */
export const DRAIN_QUIET_MS = 500;
/** A file older than this is not a restart the person is waiting on (the engine stayed down). */
export const RESUME_MAX_AGE_MS = 30 * 60_000;

export const resumeFilePath = (serverDir) => path.join(serverDir, 'resume.json');

/**
 * What the next engine takes up: a session whose run is in flight continues it; a lead whose
 * children still work is reopened so the task extension revives them.
 */
export async function sessionsToResume(host) {
  const sessions = [];
  for (const handle of host.liveRuntimes()) {
    if (handle.running) { sessions.push({ sessionId: handle.metadata.id, continue: true }); continue; }
    let pending = 0;
    try { pending = await handle.pendingWork(); } catch { /* a runtime that cannot answer has none */ }
    if (pending > 0) sessions.push({ sessionId: handle.metadata.id, continue: false });
  }
  return sessions;
}

async function writeResumeFile(file, sessions, now) {
  if (sessions.length === 0) { await rm(file, { force: true }); return; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, writtenAt: now(), sessions }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Close the gate, tell presentations, and wait until every run waits at the gate (or the
 * timeout, or `signal`). Returns what was written for the next engine.
 */
export async function drainForRestart({ host, gate, resumeFile, timeoutMs = DRAIN_TIMEOUT_MS,
  quietMs = DRAIN_QUIET_MS, signal, now = Date.now, onError = () => {} }) {
  if (!gate) return { drained: false, sessions: [] };
  gate.begin();
  for (const handle of host.liveRuntimes()) handle.publish((draft) => { draft.restarting = true; });
  await writeResumeFile(resumeFile, await sessionsToResume(host), now).catch(onError);
  const deadline = now() + timeoutMs;
  let quietSince;
  while (!signal?.aborted && now() < deadline) {
    if (!gate.quiet) quietSince = undefined;
    else if ((quietSince ??= now()) + quietMs <= now()) break;
    await delay(50);
  }
  const sessions = await sessionsToResume(host);
  await writeResumeFile(resumeFile, sessions, now).catch(onError);
  return { drained: gate.quiet, sessions };
}

/** Read and remove the file. Removed first: a resume that crashes the engine is not retried forever. */
export async function takeResumeFile(file, { now = Date.now, maxAgeMs = RESUME_MAX_AGE_MS } = {}) {
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; await rm(file, { force: true }); throw error; }
  await rm(file, { force: true });
  if (saved?.version !== 1 || !Number.isFinite(saved.writtenAt) || now() - saved.writtenAt > maxAgeMs) return [];
  return (Array.isArray(saved.sessions) ? saved.sessions : [])
    .filter((item) => typeof item?.sessionId === 'string' && item.sessionId)
    .map((item) => ({ sessionId: item.sessionId, continue: item.continue === true }));
}

/** Take up what the previous engine left, through this engine's own socket like any presentation. */
export async function resumeAfterRestart({ descriptor, resumeFile, onError = () => {}, now = Date.now }) {
  const sessions = await takeResumeFile(resumeFile, { now }).catch((error) => { onError(error); return []; });
  const results = [];
  for (const item of sessions) {
    const client = new SessionClient({ ...descriptor, onError });
    try {
      await client.connect();
      await client.attach(item.sessionId);
      const answer = item.continue ? await client.command({ type: 'continue', resume: true }) : null;
      results.push({ ...item, continued: answer?.continued === true });
    } catch (error) {
      onError(new Error(`Could not resume ${item.sessionId} after the restart: ${error?.message ?? error}`));
      results.push({ ...item, continued: false, error: String(error?.message ?? error) });
    } finally {
      await client.detach().catch(() => {});
      await client.close().catch(() => {});
    }
  }
  return results;
}
