// RPC subscriptions are evidence, not screen focus. Never resolve concurrent
// subscriptions by arrival order: reconnects can reverse that order.
export const connectionKey = ({ sessionId, rpcClientId }) => JSON.stringify([sessionId, rpcClientId]);

export function createPresenceTracker({ now = Date.now } = {}) {
  const entries = new Map();
  const get = (input) => {
    const key = connectionKey(input);
    if (!entries.has(key)) entries.set(key, {
      clientKind: 'unknown', clientId: null, lastForegroundAt: null,
      lastReportAt: now(), threads: new Map(),
    });
    return entries.get(key);
  };
  return {
    noteSubscription(input) {
      const entry = get(input);
      const threadId = input.threadId;
      entry.threads.set(threadId, (entry.threads.get(threadId) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const count = entry.threads.get(threadId) ?? 0;
        if (count > 1) entry.threads.set(threadId, count - 1);
        else entry.threads.delete(threadId);
      };
    },
    noteActivity(input) {
      const entry = get(input);
      entry.clientId = input.clientId;
      entry.clientKind = input.clientKind;
      // Device clocks are not an authority for recency.
      entry.lastReportAt = now();
      if (input.appState === 'active' || (input.visible && input.focused)) {
        entry.lastForegroundAt = now();
      }
    },
    snapshot() {
      return [...entries.values()].map((entry) => ({ ...entry, threadIds: [...entry.threads.keys()] }));
    },
    prune() {
      for (const [key, entry] of entries) {
        if (entry.threads.size === 0 && now() - entry.lastReportAt > 60_000) entries.delete(key);
      }
    },
  };
}

export function resolveTarget({ presence = [], now = Date.now(), foregroundWindowMs = 60_000 } = {}) {
  const recent = presence.filter((entry) =>
    entry.clientKind === 'mobile' && entry.lastForegroundAt !== null &&
    now - entry.lastForegroundAt <= foregroundWindowMs);
  if (!recent.length) return { target: 'new-thread' };
  const threadIds = [...new Set(recent.flatMap((entry) => entry.threadIds))];
  const devices = new Set(recent.map((entry) => entry.clientId));
  if (devices.size === 1 && threadIds.length === 1 &&
      recent.every((entry) => entry.threadIds.length === 1)) {
    return { target: 'existing-thread', threadId: threadIds[0] };
  }
  return { target: 'ambiguous', threadIds, reason: 'mobile-target-uncertain' };
}
