// The keeper as a resident service of the engine (pi-server resident-services.mjs): it runs in
// its own thread, so a fault here ends that thread only and the engine starts it again.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { startCompanionKeeper } from './keeper.mjs';

export async function start(ctx) {
  // The engine writes a conversation as `<created>_<id>.jsonl` in its sessions folder (pi-server session-files.mjs).
  const sessionExists = async (id) => (await readdir(path.join(ctx.agentDir, 'sessions')).catch(() => []))
    .some((name) => name.endsWith(`_${id}.jsonl`));
  const keeper = startCompanionKeeper({ env: ctx.env, onError: ctx.onError, connect: () => ctx.connect(), sessionExists,
    notify: (to, text, what) => ctx.host.wake({ to, what, text }) });
  return {
    /** Checks now instead of at the next poll (settings were just saved). */
    poke: () => keeper.poke(),
    sessionId: () => keeper.sessionId ?? null,
    close: () => keeper.close(),
  };
}
