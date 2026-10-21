// The companion hands work to leads and never waits on them (harness/companion). Instead the
// engine follows every conversation the companion started or sent work to, and tells it with one
// notice when that work ends: the turn finished, was stopped, failed, or stopped to ask the user.
// The notice goes into the companion's conversation like a session message, so it wakes it.
//
// A turn that ends on a wait is not the end of the work. A lead often closes a turn waiting on a
// background command, a monitor or a subagent, and writes its result in the turn their completion
// wakes. While such a wait is left (`awaiting`, the same waits that keep a turn open in the app),
// the end is held; once none is left, the newest answer is told once. A stop or an error is told
// at once, as the app ends those turns at once too.
//
// After that the follower keeps watching while the lead's runtime stays loaded — pending work
// holds it (pi-server host.mjs pendingWork) — and tells any later end once, so a result written
// after a wait it could not see still arrives. It stops once the runtime unloads with no turn
// running, or the turn's runtime goes away mid-turn (told as lost).
//
// What is followed is saved (when a store is given), so an engine restart in the middle of a lead's
// turn still ends in a notice.

const BUSY = new Set(['running', 'starting', 'waiting']);
/** A followed runtime that went away mid-turn and stayed away this long has stopped. */
export const LOST_AFTER_MS = 60_000;
/**
 * A wait that ended starts the lead's next turn a moment later; a held end waits this long with
 * nothing left before it is told (the app's AWAIT_GRACE_MS, t3-integration events.mjs).
 */
export const AWAIT_GRACE_MS = 3_000;
/** A notice that cannot be delivered is dropped after this many tries. */
export const NOTICE_TRIES = 5;

/** What the companion reads about how the work ended. */
export function noticeText(outcome, current) {
  const answer = (label, part) => part?.text ? `\n\n${label}:\n${part.text}` : '';
  switch (outcome) {
    case 'completed': return `Finished its turn.${answer('Its answer', current.final)}`;
    case 'stopped': return `Was stopped before finishing.${answer('Its last words', current.final)}`;
    case 'failed': return `Ended with an error.${answer('Its last words', current.final ?? current.latestAssistant)}`;
    case 'lost': return 'Stopped mid-turn without finishing: its runtime went away.';
    case 'lost-waiting': return `Stopped while waiting on background work: its runtime went away before the work woke it.${answer('Its last words', current.final)}`;
    case 'needs-attention': return `Is waiting for the user to answer it${current.latestTool?.name ? ` (${current.latestTool.name})` : ''}.` +
      answer('What it said', current.latestAssistant);
    default: throw new TypeError(`Unknown outcome: ${outcome}`);
  }
}

/** How a followed turn stands now: undefined while it is still going. */
export function judge(record, current, at) {
  const base = record.base;
  if ((current.status === 'waiting' && !base.waiting) || current.ui.some((id) => !base.ui.includes(id))) return 'needs-attention';
  if (current.status === 'error') return 'failed';
  if (record.messageId && !BUSY.has(current.status) && current.final && current.final.entryId !== base.final) {
    // A handoff by message: the turn that read it ends with a final written after it. Both turns
    // may end between two looks, so the order in the transcript decides, not a count of finals.
    if (current.handoff === 'before') {
      if (current.final.stopReason === 'aborted') return 'stopped';
      if (current.final.stopReason === 'error') return 'failed';
      return 'completed';
    }
    // The newest final is the turn the message waited behind. Stopped or failed, the held message
    // is then written without starting a turn, so no later end would come.
    if (current.final.stopReason === 'aborted') return 'stopped';
    if (current.final.stopReason === 'error') return 'failed';
    return undefined;
  }
  if (!BUSY.has(current.status) && current.final && current.final.entryId !== base.final) {
    // A stopped or failed turn is reported even when it is the turn the handoff waited behind: the
    // message held for it is then written without starting a turn, so no later end would come.
    if (current.final.stopReason === 'aborted') return 'stopped';
    if (current.final.stopReason === 'error') return 'failed';
    if (record.skip > 0) return 'skip';
    return 'completed';
  }
  if (current.status === 'stored' && record.started && at - (record.storedSince ?? at) >= LOST_AFTER_MS) return 'lost';
  return undefined;
}

/**
 * @param {object} options
 * @param {(id: string) => Promise<{ status: string, title?: string, final?: object, latestAssistant?: object, latestTool?: object, ui: string[] }>} options.inspect
 *   the followed conversation now; throws with code `unknown_session` once it is gone
 * @param {(companionId: string, targetId: string, text: string) => Promise<unknown>} options.notify
 * @param {(id: string) => Promise<number | null>} [options.awaiting]
 *   how many waits the lead's last turn left that will wake it again (background commands,
 *   monitors, subagents); null when no runtime holds the conversation. Asked only when a turn ended.
 * @param {{ load: () => object, save: (records: object) => void, finished?: (entry: object) => void, paused?: () => boolean }} [options.store]
 *   `paused` true holds every notice (the companion is turned off) until it reads false again.
 */
export function createFollower({ inspect, notify, awaiting = async () => 0, store, onError = () => {}, pollMs = 2000, now = Date.now }) {
  const records = new Map(Object.entries(safe(() => store?.load(), onError) ?? {}).filter(([, record]) => valid(record)));
  let timer;
  let polling;
  let closed = false;
  const save = () => { if (store) safe(() => store.save(Object.fromEntries(records)), onError); };

  async function check(id, record) {
    let current;
    try { current = await inspect(id, record); }
    catch (error) {
      if (error?.code === 'unknown_session') { records.delete(id); return true; }
      throw error;
    }
    const at = now();
    const startedBefore = record.started;
    const askedBefore = record.asked === true;
    if (BUSY.has(current.status)) {
      // A lead woken again after its handed turn ended: the panel counts this turn from now.
      if (record.ended && !record.started) record.since = at;
      record.started = true;
      delete record.storedSince;
      delete record.emptySince;
    }
    else if (current.status === 'stored') record.storedSince ??= at;
    else delete record.storedSince;
    // Whether it waits on the person now. A question asked mid-turn leaves the turn `running`, so the
    // runtime's own unanswered questions decide (`pending`); without them, it stays asked until the
    // work ends.
    if (Array.isArray(current.pending)) {
      if (current.pending.length > 0 || current.status === 'waiting') record.asked = true;
      else delete record.asked;
    }
    let outcome = judge(record, current, at);
    if (outcome === 'completed') {
      const left = await awaiting(id);
      if (left > 0) {
        // Ended on a wait: the turn that wait wakes carries the result.
        const changed = record.holding !== true || record.emptySince !== undefined;
        record.holding = true;
        delete record.emptySince;
        return changed || record.started !== startedBefore || (record.asked === true) !== askedBefore;
      }
      if (record.holding && left === null) outcome = 'lost-waiting';
      else if (record.holding) {
        // The wait just ended; its wake starts the next turn a moment later.
        const first = record.emptySince === undefined;
        record.emptySince ??= at;
        if (at - record.emptySince < AWAIT_GRACE_MS) return first;
      }
    }
    // After an end, a runtime unloaded with nothing running cannot be woken by its own work again.
    if (!outcome && record.ended && !record.started && current.status === 'stored') { records.delete(id); return true; }
    // Saved once seen: an engine killed mid-turn leaves the lead stored, and only a saved `started`
    // lets the next engine report it lost.
    if (!outcome) return record.started !== startedBefore || (record.asked === true) !== askedBefore;
    if (outcome === 'skip') {
      record.skip -= 1;
      record.base.final = current.final.entryId;
      return true;
    }
    // A companion turned off is not woken: the notice waits, and goes once it is on again.
    if (store?.paused && safe(() => store.paused(), onError) === true) return false;
    try { await notify(record.companionId, id, noticeText(outcome, current)); }
    catch (error) {
      record.failures = (record.failures ?? 0) + 1;
      if (record.failures >= NOTICE_TRIES) records.delete(id);
      onError(error);
      return true;
    }
    if (outcome === 'needs-attention') {
      // Keep following: the turn goes on once the user answers, and its end is told too.
      record.base.waiting = current.status === 'waiting';
      record.base.ui = [...new Set([...record.base.ui, ...current.ui])];
      record.asked = true;
    } else {
      if (outcome === 'lost' || outcome === 'lost-waiting' || current.status === 'error') records.delete(id);
      else {
        // Told once: only a final written after this one is a new end. Its later turns are no
        // handoff of their own, so neither the handed message nor a busy turn's skip applies.
        record.ended = true;
        record.base.final = current.final?.entryId ?? record.base.final;
        record.base.waiting = false;
        record.base.ui = [...new Set([...record.base.ui, ...current.ui])];
        record.started = false;
        record.skip = 0;
        delete record.messageId;
        delete record.asked;
        delete record.storedSince;
        delete record.failures;
        delete record.holding;
        delete record.emptySince;
      }
      // What the companion's space lists as recently finished (harness/companion panel.json).
      if (store?.finished) safe(() => store.finished({ sessionId: id, outcome: outcome === 'lost-waiting' ? 'lost' : outcome, at: now(),
        ...(current.title ? { title: current.title } : {}), ...(current.cwd ? { cwd: current.cwd } : {}) }), onError);
    }
    return true;
  }

  async function poll() {
    let changed = false;
    for (const [id, record] of [...records]) {
      if (closed) return;
      try { changed = (await check(id, record)) || changed; }
      catch (error) { onError(error); }
    }
    if (changed) save();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (closed || !records.size) return;
    timer = setTimeout(() => { polling = poll().finally(() => { polling = undefined; }); }, pollMs);
    timer.unref?.();
  }

  schedule();
  return {
    /**
     * Follows `targetId` for the companion `companionId` until its current handoff ends. `base` is
     * how the target stood before the handoff (its last finished answer), and `busy` that it was
     * mid-turn then: that turn's end is not the end of the work just handed over. `messageId` names
     * the message that handed the work over; the inspector then says whether the newest final was
     * written after it (`current.handoff === 'before'`).
     */
    follow(targetId, companionId, { final = null, busy = false, messageId } = {}) {
      if (closed) return;
      const previous = records.get(targetId);
      // A lead followed on after its last end gets new work: that work starts now.
      const since = previous && !previous.ended ? previous.since : now();
      records.set(targetId, { companionId, base: { final: previous?.base.final ?? final, waiting: false, ui: previous?.base.ui ?? [] },
        ...(messageId ? { messageId } : { skip: busy ? 1 : 0 }), started: busy, since });
      save();
      if (!polling) schedule();
    },
    /** Every conversation still followed; `ended` true for those whose handed turn already ended. */
    following({ ended } = {}) { return [...records].filter(([, record]) => ended === undefined || Boolean(record.ended) === ended).map(([id]) => id); },
    /** Checks every followed conversation now (tests, and a caller that knows something changed). */
    poll: () => polling ??= poll().finally(() => { polling = undefined; }),
    async close() { closed = true; clearTimeout(timer); await polling; },
  };
}

function valid(record) {
  return record && typeof record.companionId === 'string' && record.base && typeof record.base === 'object'
    && Array.isArray(record.base.ui);
}

function safe(work, onError) {
  try { return work(); } catch (error) { onError(error); return undefined; }
}
