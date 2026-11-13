// Whether a companion was on a call with the person at a given moment, read from the call log the
// call service keeps (call-agent/calls.mjs: one file per call under ~/.rubato/call/calls). While a
// call is up, the call card carries what was said, so the companion's words do not also go to
// Telegram (messenger/service.mjs) or arrive as message notifications (t3-integration/src/push).
//
// Each word is judged by its own time, not by when it is mirrored: a mirror that catches up after the
// call, or after an engine restart, still holds back what was said during it. The last words of a
// call can land a few seconds after it ends (speech and turn latency), so the window runs a little past
// the end.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CALL_HOME = process.env.RUBATO_CALL_HOME ?? path.join(os.homedir(), '.rubato', 'call');
/** How long after a call ends its last words may still arrive. */
export const TAIL_MS = 15_000;
/**
 * A call with nothing new on it for this long is over, whatever the log says: the engine that carried
 * it stopped before it could write the end, and the log closes such a call only when it next loads,
 * at that moment. Its end is taken as its last sign of life, so what was said after that is not held.
 */
export const STALE_MS = 5 * 60_000;

export function createCallWindows({ dir = path.join(CALL_HOME, 'calls'), tailMs = TAIL_MS, staleMs = STALE_MS, now = Date.now } = {}) {
  let cached = { mtime: -1, calls: [] };
  function calls() {
    let mtime;
    try { mtime = statSync(dir).mtimeMs; } catch { return []; }
    // A call file is replaced (renamed over) on every change, which touches the folder.
    if (mtime === cached.mtime) return cached.calls;
    const found = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const file = path.join(dir, name);
        const call = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof call?.companion !== 'string' || !Number.isFinite(call.answeredAt)) continue;
        // The last time the call showed life: its pickup, or the last line either side said.
        const said = Array.isArray(call.transcript) ? call.transcript.map(line => line?.at).filter(Number.isFinite) : [];
        found.push({ ...call, lastSeen: Math.max(call.answeredAt, ...said) });
      } catch {}
    }
    cached = { mtime, calls: found };
    return found;
  }
  return {
    /** Whether `companion` was on an answered call at `at` (ms). */
    inCall(companion, at = now()) {
      if (typeof companion !== 'string' || !Number.isFinite(at)) return false;
      return calls().some(call => {
        if (call.companion !== companion || at < call.answeredAt) return false;
        const alive = call.lastSeen + staleMs;
        if (Number.isFinite(call.endedAt)) return at <= Math.min(call.endedAt + tailMs, alive);
        return call.status === 'active' && at <= alive;
      });
    },
  };
}

let shared;
export function inCall(companion, at) {
  shared ??= createCallWindows();
  return shared.inCall(companion, at);
}
