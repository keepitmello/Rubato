// Segno's thread on the live stream (intent companion-segno rev 11, user item c31022f7). The thread
// is a chat log: the person's own messages, which T3 writes itself, and what Segno says with reply
// or say (said-echo.mjs). Nothing Segno writes, thinks or runs reaches it, in any turn.
//
// A turn the person started (T3's prompt) still has its run, so the thread shows Segno busy until
// the turn ends: of that turn only its start, its end and a question that waits for the person's
// answer pass on. A turn T3 did not start (Rubato's clock, a lead's ending, a message from another
// conversation, a finished background job) passes nothing; the person's next message waits until
// it settles, so it opens a turn of its own.

/** The events of a turn T3 started that Segno's thread gets. */
export const COMPANION_EVENTS = new Set(['agent_start', 'agent_settled', 'extension_ui_request']);

/**
 * The filter for one stream on Segno's session. `owned()` says the next run is T3's (its prompt,
 * a held turn, a restart carried across). `accept(event)` answers the events to pass on.
 */
export function createCompanionStream({ owned = () => false } = {}) {
  let inTurn = false; // a turn T3 started is going
  let foreign = false; // a turn T3 did not start is going
  let waiters = [];
  const release = () => { const done = waiters; waiters = []; for (const resolve of done) resolve(); };
  return {
    get inTurn() { return inTurn; },
    /** At attach: whether the session is already running a turn this stream did not start. */
    attached(running) { inTurn = false; foreign = running === true; if (!foreign) release(); },
    /** T3 took over the run going on (its continuation after an app restart). */
    adopt() { inTurn = true; foreign = false; release(); },
    /** Resolves once no turn T3 did not start is going. */
    idle() { return foreign ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(); },
    accept(event) {
      const type = event?.type;
      if (type === 'agent_start') {
        // A turn T3 holds open goes on in the same turn (the reply reminder's).
        if (inTurn) return [event];
        if (owned()) { inTurn = true; foreign = false; return [event]; }
        foreign = true;
        return [];
      }
      if (type === 'agent_settled') {
        if (foreign) { foreign = false; release(); return []; }
        if (!inTurn) return [];
        inTurn = false;
        return [event];
      }
      return inTurn && COMPANION_EVENTS.has(type) ? [event] : [];
    },
  };
}
