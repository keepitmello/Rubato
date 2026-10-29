// Settings authority is not an output destination. Machine context must revoke the
// last user's authority even when a reply still belongs to that user's messenger.
import { launchedIds, reportedIds } from './messenger/quiet-runs.mjs';
import { readEntriesFrom, SESSION_MESSAGE_TYPE } from './messenger/sync.mjs';

const MAX_LAUNCHES = 2000;
const userOrigin = origin => origin?.unverified !== true &&
  (origin?.kind === 'app' || (origin?.kind === 'channel' && origin.isUser === true));
export const freshOrigin = () => ({ origin: { kind: 'unknown' }, launches: {} });

export function stepOrigin(state, entry) {
  if (!entry) { state.origin = { kind: 'unknown' }; return; }
  const message = entry.type === 'message' ? entry.message : entry.type === 'custom_message'
    ? { role: 'custom', ...entry } : undefined;
  if (!message) return;
  if (message.role === 'user') { state.origin = { kind: 'app' }; return; }
  if (entry.type === 'custom_message' && entry.customType === SESSION_MESSAGE_TYPE) {
    const details = entry.details ?? {};
    if (details.kind === 'channel') state.origin = { kind: 'channel', isUser: details.from?.isUser === true };
    else if (details.kind === 'notice') {
      const owner = state.launches[details.from?.sessionId];
      state.origin = userOrigin(owner) ? { ...owner } : { kind: 'notice', unverified: true };
    } else state.origin = { kind: details.kind ?? 'unknown', what: details.what };
    return;
  }
  const completed = reportedIds(message);
  if (completed.length) {
    const owners = completed.map(id => state.launches[id]);
    state.origin = owners.every(userOrigin) ? { ...owners[0] } : { kind: 'completion', unverified: true };
    return;
  }
  if (message.role === 'custom') { state.origin = { kind: 'unknown', unverified: true }; return; }
  if (message.role !== 'toolResult' || message.isError === true) return;
  const ids = launchedIds(message);
  if (['session_create', 'session_fork'].includes(message.toolName) && typeof message.details?.sessionId === 'string')
    ids.push(message.details.sessionId);
  if (message.toolName === 'session_send' && typeof message.details?.to?.sessionId === 'string')
    ids.push(message.details.to.sessionId);
  for (const id of ids) {
    delete state.launches[id];
    state.launches[id] = { ...state.origin };
  }
  const keys = Object.keys(state.launches);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LAUNCHES))) delete state.launches[key];
}

export async function originAt(file) {
  const state = freshOrigin();
  let offset = 0;
  for (;;) {
    const { entries } = await readEntriesFrom(file, offset);
    if (!entries.length) break;
    for (const { entry, end } of entries) { stepOrigin(state, entry); offset = end; }
  }
  return state.origin;
}
