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

export function createCallWindows({ dir = path.join(CALL_HOME, 'calls'), tailMs = TAIL_MS, now = Date.now } = {}) {
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
        const call = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
        if (typeof call?.companion === 'string' && Number.isFinite(call.answeredAt)) found.push(call);
      } catch {}
    }
    cached = { mtime, calls: found };
    return found;
  }
  return {
    /** Whether `companion` was on an answered call at `at` (ms). */
    inCall(companion, at = now()) {
      if (typeof companion !== 'string' || !Number.isFinite(at)) return false;
      return calls().some(call => call.companion === companion && call.answeredAt <= at
        && (Number.isFinite(call.endedAt) ? at <= call.endedAt + tailMs : call.status === 'active'));
    },
  };
}

let shared;
export function inCall(companion, at) {
  shared ??= createCallWindows();
  return shared.inCall(companion, at);
}
