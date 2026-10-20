// Which input opened each run of Segno's conversation, read one message at a time: the Telegram
// mirror (sync.mjs) sends nothing from a run Rubato's clock started, and the settings tool
// (harness/companion/settings.mjs, through sync.mjs runAt) lets only a run the person opened change a
// setting. A run is quiet when the first input it takes is a clock wake, and stays quiet until another
// input joins it; a turn opened by work finishing belongs to the run that launched the work.
//
// Segno's thread in the app does not use this: it is a chat log of the person's messages and what
// Segno says with reply or say (t3-integration companion-thread.mjs, said-echo.mjs).
const SESSION_MESSAGE_TYPE = 'rubato-session-message';
/** The wakes of Rubato's clock (harness/companion keeper.mjs). */
export const QUIET_WAKES = Object.freeze(['heartbeat', 'greeting', 'wake', 'recall', 'daily-report', 'sleep']);

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

/** A fresh state for quietStep: plain data, so a reader that follows a file can store it between passes. */
export const newQuietState = () => ({ inQuiet: false, launched: {}, ended: true });

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
  if (isInput(message)) state.inQuiet = isClockWake(message);
  else {
    const found = launcherOf(message, state.launched);
    // A finish that opens a turn (the last one had ended) takes its launcher's side. One steered into
    // a turn already going can bring the person's work into a quiet turn, never hide a shown one.
    const opens = state.ended !== false;
    if (found && (opens || !found.quiet)) { state.inQuiet = found.quiet; launcher = found.id; }
  }
  for (const id of launchedIds(message)) remember(state.launched, id, state.inQuiet);
  state.ended = message?.role === 'assistant' && message.stopReason !== 'toolUse';
  return launcher === undefined ? { quiet: state.inQuiet } : { quiet: state.inQuiet, launcher };
}
