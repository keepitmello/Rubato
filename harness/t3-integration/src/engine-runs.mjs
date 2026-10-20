// A conversation the engine runs while T3 holds no stream on its thread shows there as it happens
// (user item 4c2a0df1): a lead Segno opened with session_create, a scheduled run, team mail to a
// thread T3 let go idle. T3 opens a stream only for a turn it starts itself, so nothing else would
// follow the session; the inventory imports it once (RubatoPiInventory.ts) and the thread stood
// still at its first message while the engine kept working.
//
// The follower attaches to the session while it runs, and for each of its runs:
//   agent_start (or a run already going)  →  a run in the thread, running (RubatoPiSessions openEngineRun)
//   each finished message                 →  what the thread lacks, written into that run (backfill.mjs)
//   agent_settled                         →  the run completes, so the thread finishes like any other
// and it lets the session go as soon as the session is at rest: no stream is kept on an idle
// session. Segno's own conversation is not followed: what it shows is its own rule (quiet-runs.mjs).
import { backfillItem, missingItems } from './backfill.mjs';

const BUSY = new Set(['running', 'starting']);

/**
 * Follows one session for `threadId` until it is at rest. `bridge` gives projectedThread,
 * importedMessages, appendSessionMessage, openEngineRun and closeEngineRun; `connect()` a session
 * client on the engine. Resolves once the follower is attached and has placed a run already going.
 */
export async function followEngineRun({ bridge, connect, threadId, sessionId, throttleMs = 1000, onEnd = () => {}, log = () => {} }) {
  const client = await connect();
  let unsubscribe;
  let runId = null;
  let opening;
  let ended = false;
  let syncing = Promise.resolve();
  let syncTimer;
  let sequence;
  const end = async () => {
    if (ended) return;
    ended = true;
    clearTimeout(syncTimer);
    await syncing.catch(() => {});
    await unsubscribe?.().catch(() => {});
    await client.detach().catch(() => {});
    await client.close().catch(() => {});
    onEnd();
  };
  // What the thread lacks of the session goes into the run going now; the same ids as the backfill,
  // so whichever writes first, the other writes nothing.
  const sync = () => (syncing = syncing.then(async () => {
    if (ended) return;
    const thread = await bridge.projectedThread(threadId);
    if (!thread) return;
    const reply = await client.command({ type: 'get_messages' });
    const items = bridge.importedMessages(sessionId, Array.isArray(reply?.messages) ? reply.messages : [], threadId);
    for (const { item, runId: anchor } of missingItems(items, thread.messages)) {
      await bridge.appendSessionMessage(threadId, backfillItem(item, threadId, runId ?? anchor));
    }
  }).catch((error) => log('engine run sync failed', error)));
  const soon = () => {
    if (throttleMs <= 0) return sync();
    if (syncTimer) return syncing;
    syncTimer = setTimeout(() => { syncTimer = undefined; void sync(); }, throttleMs);
    return syncing;
  };
  // No run means the thread runs something of T3's own (a turn the person just started): T3 shows
  // that itself, and the follower leaves.
  let busy = false;
  const open = () => (opening ??= Promise.resolve(bridge.openEngineRun(threadId, { sessionId, startedAt: new Date().toISOString() }))
    .then((id) => { runId = typeof id === 'string' ? id : null; busy = runId === null; })
    .catch((error) => { busy = true; log('engine run not opened', error); }));
  const close = async (status) => {
    await opening;
    clearTimeout(syncTimer); syncTimer = undefined;
    await sync();
    const id = runId;
    runId = null; opening = undefined;
    if (id) await Promise.resolve(bridge.closeEngineRun(threadId, id, status)).catch((error) => log('engine run not closed', error));
  };
  let queue = Promise.resolve();
  const onState = (state) => {
    queue = queue.then(async () => {
      if (ended || !state) return;
      if (sequence === undefined) {
        // What ran before the attach is in the session already; only a run going on now matters.
        sequence = state.sequence ?? 0;
        if (BUSY.has(state.status)) await open();
        if (BUSY.has(state.status) && !busy) await sync(); else await end();
        return;
      }
      for (const record of (state.events ?? []).filter((one) => one.sequence > sequence)) {
        sequence = record.sequence;
        const type = record.event?.type;
        if (type === 'agent_start') await open();
        else if (type === 'message_end') { if (!opening) await open(); if (!busy) await soon(); }
        else if (type === 'agent_settled') await close('completed');
        if (busy) { await end(); return; }
      }
      if (!BUSY.has(state.status) && !opening) await end();
    }).catch((error) => log('engine run follow failed', error));
    return queue;
  };
  try {
    await client.attach(sessionId);
    unsubscribe = await client.subscribeSession((state) => { void onState(state); });
    await queue;
  } catch (error) {
    await end();
    throw error;
  }
  // Stopping (the T3 server closing) lets go of the session and leaves the thread as it is: T3's
  // own startup recovery settles a run it finds still running.
  return { stop: end, get ended() { return ended; } };
}
