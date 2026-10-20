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

const BUSY = new Set(['running', 'starting', 'waiting']);

/**
 * Follows one session for `threadId` until it is at rest. `bridge` gives projectedThread,
 * importedMessages, appendSessionMessage, openEngineRun and closeEngineRun; `connect()` a session
 * client on the engine. Resolves once the follower is attached and has placed a run already going.
 */
/**
 * When a read of the session that failed is tried again: a few times right away before a run is
 * closed, then, after the follower let the session go, from the stored conversation (no stream).
 */
export const SYNC_RETRY_MS = Object.freeze({ beforeClose: [500, 1000, 2000], afterEnd: [5000, 15_000, 30_000, 60_000, 120_000] });

export async function followEngineRun({ bridge, connect, threadId, sessionId, throttleMs = 1000, retryMs = SYNC_RETRY_MS,
  onEnd = () => {}, closed = () => false, watchMs = 2000, idleGraceMs = 5000, log = () => {} }) {
  const client = await connect();
  let unsubscribe;
  let runId = null;
  let opening;
  let ended = false;
  let syncing = Promise.resolve();
  let syncTimer;
  let sequence;
  // Whether the last read of the session reached the thread; a failed one is tried again until one does.
  let synced = true;
  let stopped = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    stopWatch();
    clearTimeout(idleTimer);
    clearTimeout(syncTimer);
    await syncing.catch(() => {});
    await unsubscribe?.().catch(() => {});
    await client.detach().catch(() => {});
    await client.close().catch(() => {});
    onEnd();
    // A last read that failed still reaches the thread: from the stored conversation, with no stream.
    if (!synced) void (async () => {
      for (const ms of retryMs.afterEnd) {
        await new Promise((resolve) => setTimeout(resolve, ms).unref?.());
        // The bridge closing ends the retries too: the follower has already left its list by then.
        if (stopped || closed() || (await sync())) return;
      }
      log('engine run sync gave up', new Error(`${threadId} still lacks part of ${sessionId}`));
    })();
  };
  const messagesOf = async () => {
    const reply = ended ? await bridge.transcript(sessionId) : await client.command({ type: 'get_messages' });
    if (!Array.isArray(reply?.messages)) throw new Error('the session gave no messages');
    return reply.messages;
  };
  // What the thread lacks of the session goes into the run going now; the same ids as the backfill,
  // so whichever writes first, the other writes nothing. Answers whether it got through.
  const sync = () => (syncing = syncing.then(async () => {
    const thread = await bridge.projectedThread(threadId);
    if (!thread) return (synced = true);
    const items = bridge.importedMessages(sessionId, await messagesOf(), threadId);
    for (const { item, runId: anchor } of missingItems(items, thread.messages, { whole: true })) {
      await bridge.appendSessionMessage(threadId, backfillItem(item, threadId, runId ?? anchor));
    }
    return (synced = true);
  }).catch((error) => { synced = false; log('engine run sync failed', error); return false; }));
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
    // The run's last words must be in before it shows as finished.
    for (const ms of [0, ...retryMs.beforeClose]) {
      if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
      if (await sync()) break;
    }
    const id = runId;
    runId = null; opening = undefined;
    if (id) await Promise.resolve(bridge.closeEngineRun(threadId, id, status)).catch((error) => log('engine run not closed', error));
  };
  let queue = Promise.resolve();
  let status;
  let idleTimer;
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
      status = state.status;
      if (BUSY.has(status)) { clearTimeout(idleTimer); idleTimer = undefined; return; }
      if (!opening) { await end(); return; }
      // The session stopped without settling its run: its worker died (error) or it was unloaded,
      // and the run ends as failed or interrupted. Idle is not an end by itself — answering the
      // person's confirm publishes idle for a moment before the run goes on — so a run still open
      // on an idle session ends as completed only once it has stayed idle for a while.
      if (status !== 'idle') { await close(status === 'error' ? 'failed' : 'interrupted'); await end(); return; }
      idleTimer ??= setTimeout(() => {
        idleTimer = undefined;
        queue = queue.then(async () => { if (ended || status !== 'idle' || !opening) return; await close('completed'); await end(); })
          .catch((error) => log('engine run follow failed', error));
      }, idleGraceMs);
    }).catch((error) => log('engine run follow failed', error));
    return queue;
  };
  // An engine that went away (a crash, a restart) publishes nothing more: the run ends as
  // interrupted and the follower leaves; the next inventory pass follows the session again if the
  // new engine runs it.
  const watchdog = setInterval(() => {
    if (ended || client.client?.connected !== false) return;
    queue = queue.then(async () => { if (opening) await close('interrupted'); await end(); }).catch((error) => log('engine run follow failed', error));
  }, watchMs);
  watchdog.unref?.();
  const stopWatch = () => clearInterval(watchdog);
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
  return { stop: async () => { stopped = true; await end(); }, get ended() { return ended; } };
}
