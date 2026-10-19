// Keeps the companion's conversation loaded in the engine while the person has it turned on.
//
// The engine unloads a runtime a minute after its last attachment goes (pi-server host.mjs). The
// keeper is one more attachment that never leaves: it attaches to the companion's conversation
// like any window would, so the companion stays loaded, its warmer keeps running and a message
// reaches a live runtime. Turning the companion off in Settings › Companion releases it, and the
// engine's ordinary idle rule takes over. The engine starts the keeper itself
// (profile-server.mjs), so the companion comes back whenever the engine does.
//
// The first time the companion is on, the keeper creates its conversation in the companion's
// home folder and records which one it is (state.json). That record is how the app finds it.
import { mkdirSync } from 'node:fs';
import { COMPANION_TITLE, companionPaths, readSettings, readState, writeState } from './companion.mjs';

const LIVE = new Set(['starting', 'running', 'waiting', 'idle']);

/**
 * @param {{ connect: () => Promise<object>, env?: NodeJS.ProcessEnv, onError?: (error: unknown) => void, pollMs?: number }} options
 *   `connect` opens a session client to this engine (pi-server client.mjs SessionClient).
 */
export function startCompanionKeeper({ connect, env = process.env, onError = () => {}, pollMs = 3000 }) {
  let client;
  let attachedTo;
  let closed = false;
  let ticking;

  async function release() {
    const held = client;
    client = undefined;
    attachedTo = undefined;
    await held?.close().catch(onError);
  }

  async function ensureSession(active) {
    const { sessionId } = readState(env);
    const rows = await active.list();
    if (sessionId && rows.some((row) => row.sessionId === sessionId)) return { sessionId, rows };
    const { home } = companionPaths(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const created = await active.create({ cwd: home, title: COMPANION_TITLE, titleLocked: true, companion: true });
    if (!created?.sessionId) throw new Error('The engine did not return the companion conversation it created');
    writeState({ sessionId: created.sessionId }, env);
    return { sessionId: created.sessionId, rows: await active.list() };
  }

  async function tick() {
    if (closed) return;
    if (!readSettings(env).enabled) { if (client) await release(); return; }
    try {
      client ??= await connect();
      const { sessionId, rows } = await ensureSession(client);
      const row = rows.find((item) => item.sessionId === sessionId);
      // A runtime that ended (an error, or the engine reclaimed it) took this attachment with it.
      const live = row && LIVE.has(row.status) && row.runtimeId !== null;
      if (attachedTo === sessionId && live) return;
      if (attachedTo !== undefined) { await release(); client = await connect(); }
      await client.attach(sessionId);
      attachedTo = sessionId;
    } catch (error) {
      onError(error);
      await release();
    }
  }

  const run = () => ticking ??= tick().finally(() => { ticking = undefined; });
  const timer = setInterval(() => { void run(); }, pollMs);
  timer.unref?.();
  const ready = run();
  return {
    ready,
    /** Checks now instead of at the next poll (settings were just saved). */
    poke: run,
    get sessionId() { return attachedTo; },
    async close() {
      closed = true;
      clearInterval(timer);
      await ticking;
      await release();
    },
  };
}
