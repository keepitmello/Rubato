// Rubato's clock (harness/companion keeper.mjs: a heartbeat, a greeting, a wake or recall, sleep) wakes
// Segno for its own rhythm. That run stays in Segno's session, where the model sees it, and out
// of every client: the app on the desktop and T3's mobile app read the same server thread, and
// the mobile app cannot be changed, so the run never reaches the thread at all. A run is quiet
// when the first input it takes is a clock wake; it stays quiet until it settles, unless an input
// that is not a clock wake joins it (then it shows from there, as any run would).
//
// Segno's own conversation (`companion`) shows only what Segno says to the person (intent
// companion-segno rev 9, user item 9fbe5b98, Roo's model): a turn the person opened, and the end of
// background work they asked for. Every other input opens a quiet run there too — a lead's ending, a
// message from another conversation, team mail — and Segno tells the person what they should know
// with tell_user (said-echo.mjs). A finish of work nobody saw start is private there too. Other
// conversations keep showing those inputs.
import { QUIET_WAKES, SESSION_MESSAGE_TYPE } from './events.mjs';

const isSessionMessage = (message) => message?.role === 'custom' && message.customType === SESSION_MESSAGE_TYPE;

/** A clock wake: Rubato's own session message of kind `wake` for its rhythm (QUIET_WAKES). */
export const isClockWake = (message) => isSessionMessage(message) && message.details?.kind === 'wake'
  && QUIET_WAKES.includes(message.details.what);

/** The custom types a Pi message carries, its own and, for a batch (rubato-runtime:wake), each item's. */
const carriedTypes = (message) => [message?.customType, ...(Array.isArray(message?.details) ? message.details.map((item) => item?.customType) : [])];
/** A teammate's message (senpi-task:team-message, alone or inside a batch): another session speaking, not the clock. */
const isTeamMail = (message) => message?.role === 'custom' && carriedTypes(message).includes('senpi-task:team-message');
/** An input a run takes: the person's message, a teammate's, or a message from another conversation, a messenger or Rubato. */
const isInput = (message) => message?.role === 'user' || isSessionMessage(message) || isTeamMail(message);
/** The person's own words: typed in the app, or from their own chat in a messenger. */
export const isUserInput = (message) => message?.role === 'user'
  || (isSessionMessage(message) && message.details?.kind === 'channel' && message.details?.from?.isUser === true);
/** Whether an input opens (or keeps) a quiet run: a clock wake anywhere, and in Segno's conversation anything not the person's. */
const quietInput = (message, companion) => isClockWake(message) || (companion === true && !isUserInput(message));

/** How many launched ids one live stream remembers; the oldest go first. */
const LAUNCHED_LIMIT = 2000;
/** Pi's own custom message (a background terminal or subagent finishing, a nudge): not an input. */
const isOwnCustomMessage = (message) => message?.role === 'custom' && !isSessionMessage(message);

/**
 * The ids a tool result may later be reported under when its work finishes in the background: a
 * terminal session's id (bash), a subagent's id (Agent), and the tool call's own id (a detached
 * eval cell is reported under it).
 */
export function launchedIds(message) {
  if (message?.role !== 'toolResult') return [];
  const details = message.details && typeof message.details === 'object' ? message.details : {};
  const { bash_id: bashId, agentId, agentIds } = details;
  return [message.toolCallId, bashId, agentId, ...(Array.isArray(agentIds) ? agentIds : [])]
    .filter((id) => typeof id === 'string' && id.length >= 4);
}



/**
 * The work a finish reports on, from where each kind names its subject — never from the output it
 * quotes: a terminal session in its header ("Background terminal session <id> finished"), a detached
 * eval cell in its header ("Detached eval cell <toolCallId> (…)"), subagents in details[].agentId.
 */
export function reportedIds(message) {
  if (!isOwnCustomMessage(message)) return [];
  const text = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';
  const ids = [];
  // Each notice's header starts its own block; a batch (rubato-runtime:wake) joins several.
  for (const terminal of text.matchAll(/(?:^|\n)\s*(?:<system-reminder>)?\s*Background terminal session (\S+) finished\b/g)) ids.push(terminal[1]);
  for (const cell of text.matchAll(/(?:^|\n)\s*(?:<system-reminder>)?\s*Detached eval cell (\S+) \(/g)) ids.push(cell[1]);
  // Subagents name themselves in details: [{ agentId }], or inside a batch [{ customType, details: [{ agentId }] }].
  const walk = (value, depth) => {
    for (const detail of Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []) {
      if (typeof detail?.agentId === 'string') ids.push(detail.agentId);
      if (Array.isArray(detail?.agentIds)) ids.push(...detail.agentIds.filter((id) => typeof id === 'string'));
      if (depth < 2 && detail?.details !== undefined) walk(detail.details, depth + 1);
    }
  };
  walk(message.details, 0);
  return ids;
}

/**
 * Which launched work Pi's own message reports on: `{ quiet, id }` of the run that launched it, or
 * undefined when it names none we saw start. A batch can report several: one the person (a shown
 * run) asked for makes the turn theirs.
 */
function launcherOf(message, launched) {
  let quietOne;
  for (const id of reportedIds(message)) {
    if (!Object.hasOwn(launched, id)) continue;
    if (!launched[id]) return { quiet: false, id };
    quietOne ??= { quiet: true, id };
  }
  return quietOne;
}

function remember(launched, id, quiet) {
  delete launched[id];
  launched[id] = quiet;
  const keys = Object.keys(launched);
  for (let i = 0; i < keys.length - LAUNCHED_LIMIT; i += 1) delete launched[keys[i]];
}

/**
 * A fresh state for quietStep: plain data, so a reader that follows a file can store it between
 * passes. `companion` says the conversation is Segno's (its session list row's `companion`).
 */
export const newQuietState = ({ companion = false } = {}) => ({ inQuiet: false, launched: {}, ended: true, ...(companion ? { companion: true } : {}) });

/**
 * One message of a stored conversation, in order: whether it belongs to a quiet run, and for a
 * message that opened a turn by reporting background work, the id of the work that decided it
 * (`launcher`). `state` ({ inQuiet, launched: { [id]: quiet }, ended }) is updated in place. A clock wake
 * starts a quiet stretch and any other input ends it; a turn opened by work finishing belongs to
 * the run that launched that work — the user's request stays the user's even when a heartbeat ran
 * in between, and work Segno started in its own quiet time stays quiet; a finish that names no work
 * seen starting continues the stretch.
 */
export function quietStep(state, message) {
  let launcher;
  if (isInput(message)) state.inQuiet = quietInput(message, state.companion);
  else {
    const found = launcherOf(message, state.launched);
    // A finish that opens a turn (the last one had ended) takes its launcher's side. One steered into
    // a turn already going can bring the person's work into a quiet turn, never hide a shown one.
    const opens = state.ended !== false;
    if (found && (opens || !found.quiet)) { state.inQuiet = found.quiet; launcher = found.id; }
    // In Segno's conversation only work the person asked for comes back to them: a finish whose start
    // nobody saw is private there.
    else if (!found && opens && state.companion === true && isOwnCustomMessage(message)) state.inQuiet = true;
  }
  for (const id of launchedIds(message)) remember(state.launched, id, state.inQuiet);
  state.ended = message?.role === 'assistant' && message.stopReason !== 'toolUse';
  return launcher === undefined ? { quiet: state.inQuiet } : { quiet: state.inQuiet, launcher };
}

/** The messages of a stored conversation (Pi's message list, oldest first) that belong to quiet runs (quietStep). */
export function quietMessages(messages, { companion = false } = {}) {
  const quiet = new Set();
  const state = newQuietState({ companion });
  for (const message of Array.isArray(messages) ? messages : []) if (quietStep(state, message).quiet) quiet.add(message);
  return quiet;
}

/**
 * The live filter over one session's events, in order. `accept(event)` answers the events to pass
 * on now (none, the event itself, or what was held before it). A run the client did not start
 * (`owned()` false: no prompt of its own, no turn held open) has its start held until its first
 * input says what it is; a quiet run passes nothing until it settles. `idle()` resolves when no
 * quiet run is open or deciding.
 */
export function createQuietRuns({ owned = () => false, seeded: startSeeded = true, companion: startCompanion = false } = {}) {
  let companion = startCompanion === true;
  let state = 'idle'; // idle | opening (agent_start held) | pending (a run already going, asked about) | quiet | shown
  let held = [];
  let waiters = [];
  // Whether the last run that settled was quiet, and which run launched each piece of background
  // work: a run opened without any input (work finishing) belongs to the run that launched that work,
  // else it continues the last stretch — as quietMessages reads it.
  let lastQuiet = false;
  let launched = {};
  // A stream that attached late has not seen what ran before (its buffer holds the last events
  // only): the first input-less turn it cannot place asks for the stored conversation (wantsLookup).
  let seeded = startSeeded;
  let lookup = false;
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
  let settledWhilePending = false;
  const undecided = () => state === 'quiet' || state === 'opening' || state === 'pending';
  return {
    get quiet() { return undecided(); },
    /** Whether this stream's conversation is Segno's (newQuietState); set when the stream attaches to a session. */
    set companion(value) { companion = value === true; },
    get companion() { return companion; },
    idle() { return undecided() ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(); },
    /**
     * A run was already going when this stream attached and its start is no longer in the engine's
     * buffer: hold everything until `resolve` says, from the stored conversation's tail, whose it is.
     */
    inFlight() { state = 'pending'; held = []; settledWhilePending = false; },
    /** Whether the filter holds a turn it cannot place without the stored conversation; asking clears it. */
    takeLookup() { const asked = lookup; lookup = false; return asked; },
    /** What the stored conversation says (quietStep's state at its end): the launches and the last stretch. */
    seed(quietState) {
      launched = { ...(quietState?.launched ?? {}) };
      if (state === 'idle') lastQuiet = quietState?.inQuiet === true;
      seeded = true;
    },
    /** Ends `inFlight`: a quiet run drops what was held; any other passes it on. Returns what to pass. */
    resolve(quiet) {
      if (state !== 'pending') return [];
      const out = quiet ? [] : held;
      held = [];
      if (settledWhilePending) { state = quiet ? 'quiet' : 'shown'; settle('idle'); }
      else settle(quiet ? 'quiet' : 'shown');
      return out;
    },
    accept(event) {
      const type = event?.type;
      if (type === 'message_end' && (state === 'quiet' || state === 'shown')) {
        for (const id of launchedIds(event.message)) remember(launched, id, state === 'quiet');
      }
      if (state === 'pending') {
        if (type === 'agent_settled') settledWhilePending = true;
        held.push(event);
        return [];
      }
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
        if (input && quietInput(input, companion)) { held = []; settle('quiet'); return []; }
        // Pi's turn marker and its own hidden messages come before the input; anything else decides.
        if (!input && (type === 'turn_start' || isHiddenOwn(event))) { held.push(event); return []; }
        // No input at all, opened by Pi's own message (work finishing): the run that launched the work
        // decides; work nobody here saw start continues the last stretch.
        if (!input && held.some(isOwnCustom)) {
          const verdicts = held.map((one) => (one.type === 'message_end' ? launcherOf(one.message, launched)?.quiet : undefined));
          const by = verdicts.includes(false) ? false : verdicts.includes(true) ? true : undefined;
          if (by === undefined && !seeded) {
            held.push(event);
            state = 'pending';
            settledWhilePending = type === 'agent_settled';
            lookup = true;
            return [];
          }
          if (by ?? (companion || lastQuiet)) { held = []; settle(type === 'agent_settled' ? 'idle' : 'quiet'); if (type === 'agent_settled') lastQuiet = true; return []; }
        }
        const out = [...held, event];
        held = [];
        settle(type === 'agent_settled' ? 'idle' : 'shown');
        return out;
      }
      if (state === 'quiet') {
        if (type === 'agent_settled') { settle('idle'); return []; }
        const input = inputOf(event);
        if (input && !quietInput(input, companion)) { settle('shown'); return [{ type: 'agent_start' }, event]; }
        // The person's work finishing, steered into this turn: from here the turn is theirs.
        if (isOwnCustom(event) && launcherOf(event.message, launched)?.quiet === false) { settle('shown'); return [{ type: 'agent_start' }, event]; }
        return [];
      }
      if (state === 'shown' && type === 'agent_settled') settle('idle');
      return [event];
    },
  };
}
