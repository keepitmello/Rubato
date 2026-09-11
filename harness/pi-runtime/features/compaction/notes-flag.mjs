/** Live env flag used by the summary overlay and Anthropic server-compaction wrap.
 * Matches product contextMode() for the summary vs notes gate: unset → notes (safe
 * during session load); session_start writes RUBATO_CONTEXT_MODE afterwards.
 */
export const HISTORY_NOTES_MODE = "history-notes";
export const SUMMARY_MODE = "summary";

export function contextMode(env = process.env) {
  const raw = env.RUBATO_CONTEXT_MODE?.trim();
  if (!raw) return HISTORY_NOTES_MODE;
  return raw;
}

export function historyNotesEnabled(env = process.env) {
  return contextMode(env) !== SUMMARY_MODE;
}

export function summaryModeActive(env = process.env) {
  return contextMode(env) === SUMMARY_MODE;
}
