// Rubato's clock (harness/companion keeper.mjs: a heartbeat, a greeting, a wake or recall, sleep) wakes
// Segno for its own rhythm. That run stays in Segno's session, where the model sees it, and out
// of every client: the app on the desktop and T3's mobile app read the same server thread, and
// the mobile app cannot be changed, so the run never reaches the thread at all. A run is quiet
// when the first input it takes is a clock wake; it stays quiet until it settles, unless an input
// that is not a clock wake joins it (then it shows from there, as any run would).
import { QUIET_WAKES, SESSION_MESSAGE_TYPE } from './events.mjs';

const isSessionMessage = (message) => message?.role === 'custom' && message.customType === SESSION_MESSAGE_TYPE;

/** A clock wake: Rubato's own session message of kind `wake` for its rhythm (QUIET_WAKES). */
export const isClockWake = (message) => isSessionMessage(message) && message.details?.kind === 'wake'
  && QUIET_WAKES.includes(message.details.what);

/** An input a run takes: the person's message, or a message from another conversation, a messenger or Rubato. */
const isInput = (message) => message?.role === 'user' || isSessionMessage(message);

/**
 * The messages of a stored conversation (Pi's message list, oldest first) that belong to quiet
 * runs: each clock wake and everything after it up to the next input that is not a clock wake.
 */
export function quietMessages(messages) {
  const quiet = new Set();
  let inQuiet = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (isClockWake(message)) inQuiet = true;
    else if (isInput(message)) inQuiet = false;
    if (inQuiet) quiet.add(message);
  }
  return quiet;
}

/**
 * The live filter over one session's events, in order. `accept(event)` answers the events to pass
 * on now (none, the event itself, or what was held before it). A run the client did not start
 * (`owned()` false: no prompt of its own, no turn held open) has its start held until its first
 * input says what it is; a quiet run passes nothing until it settles. `idle()` resolves when no
 * quiet run is open or deciding.
 */
export function createQuietRuns({ owned = () => false } = {}) {
  let state = 'idle'; // idle | opening (agent_start held) | quiet | shown
  let held = [];
  let waiters = [];
  // Whether the last run that settled was quiet: a run opened without any input (a background
  // completion Segno's own quiet run started) continues that stretch, as quietMessages reads it.
  let lastQuiet = false;
  const settle = (next) => {
    if (next === 'idle') lastQuiet = state === 'quiet';
    state = next;
    if (state === 'idle' || state === 'shown') { const done = waiters; waiters = []; for (const resolve of done) resolve(); }
  };
  // Pi's own messages ahead of the input: its hidden custom messages, and the system message that
  // declares the tool list at a run's start (a new conversation, or tools added since the last run).
  const isHiddenOwn = (event) => (event?.type === 'message_start' || event?.type === 'message_end')
    && ((event.message?.role === 'custom' && !isSessionMessage(event.message)) || event.message?.role === 'system');
  const isOwnCustom = (event) => (event?.type === 'message_start' || event?.type === 'message_end')
    && event.message?.role === 'custom' && !isSessionMessage(event.message);
  const inputOf = (event) => (event?.type === 'message_start' || event?.type === 'message_end') && isInput(event.message)
    ? event.message : undefined;
  return {
    get quiet() { return state === 'quiet' || state === 'opening'; },
    idle() { return state === 'quiet' || state === 'opening' ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(); },
    accept(event) {
      const type = event?.type;
      if (type === 'agent_start') {
        if (state === 'quiet') return [];
        const out = state === 'opening' ? held : [];
        if (owned()) { held = []; settle('shown'); return [...out, event]; }
        held = [event];
        state = 'opening';
        return out;
      }
      if (state === 'opening') {
        const input = inputOf(event);
        if (input && isClockWake(input)) { held = []; settle('quiet'); return []; }
        // Pi's turn marker and its own hidden messages come before the input; anything else decides.
        if (!input && (type === 'turn_start' || isHiddenOwn(event))) { held.push(event); return []; }
        // No input at all, after a quiet run, opened by Pi's own message: still Segno's quiet time.
        if (!input && lastQuiet && held.some(isOwnCustom)) { held = []; settle(type === 'agent_settled' ? 'idle' : 'quiet'); if (type === 'agent_settled') lastQuiet = true; return []; }
        const out = [...held, event];
        held = [];
        settle(type === 'agent_settled' ? 'idle' : 'shown');
        return out;
      }
      if (state === 'quiet') {
        if (type === 'agent_settled') { settle('idle'); return []; }
        const input = inputOf(event);
        if (input && !isClockWake(input)) { settle('shown'); return [{ type: 'agent_start' }, event]; }
        return [];
      }
      if (state === 'shown' && type === 'agent_settled') settle('idle');
      return [event];
    },
  };
}
