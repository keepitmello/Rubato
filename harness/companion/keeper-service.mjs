// The keeper as a resident service of the engine (pi-server resident-services.mjs): it runs in
// its own thread, so a fault here ends that thread only and the engine starts it again.
import { startCompanionKeeper } from './keeper.mjs';

export async function start(ctx) {
  const keeper = startCompanionKeeper({ env: ctx.env, onError: ctx.onError, connect: () => ctx.connect(),
    notify: (to, text) => ctx.host.notice({ to, text }) });
  return {
    /** Checks now instead of at the next poll (settings were just saved). */
    poke: () => keeper.poke(),
    sessionId: () => keeper.sessionId ?? null,
    close: () => keeper.close(),
  };
}
