// The call log: who rang whom, whether it was picked up, and what was said. One call is one file
// under ~/.rubato/call/calls/, written on every change, so the room can draw a card for it and a
// restart forgets nothing. The service is the only writer; the worker reports through it.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** How long a companion's call rings before it counts as missed. */
export const RING_MS = 40_000;

export class CallError extends Error {
  constructor(message, status = 409) { super(message); this.name = 'CallError'; this.status = status; }
}

/**
 * `direction`: 'outgoing' when the person called the companion, 'incoming' when the companion
 * called the person. `status`: ringing → active → ended, or ringing → missed / declined.
 */
export function createCallLog({ dir, now = Date.now, ringMs = RING_MS, onChange = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const calls = new Map();
  const waiters = new Map();
  const timers = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const call = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      // A call the engine was carrying when it stopped is over; a ring nobody answered was missed.
      if (call.status === 'ringing') Object.assign(call, { status: 'missed', endedAt: call.endedAt ?? now() });
      if (call.status === 'active') Object.assign(call, { status: 'ended', endedAt: call.endedAt ?? now() });
      calls.set(call.id, call);
    } catch {}
  }

  function save(call) {
    const file = path.join(dir, `${call.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(call) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
    onChange(call);
    return call;
  }
  function settle(call) {
    clearTimeout(timers.get(call.id)); timers.delete(call.id);
    for (const resolve of waiters.get(call.id) ?? []) resolve(view(call));
    waiters.delete(call.id);
  }
  const view = call => ({ ...call, transcript: [...call.transcript] });
  function get(id) {
    const call = calls.get(id);
    if (!call) throw new CallError('no such call', 404);
    return call;
  }
  function busy(companion) {
    return [...calls.values()].some(call => call.companion === companion && ['ringing', 'active'].includes(call.status));
  }
  function open({ companion, direction, voice = null, reason = null }) {
    if (busy(companion)) throw new CallError(`${companion} is already on a call`);
    const call = { id: `call-${companion}-${now().toString(36)}-${randomUUID().slice(0, 6)}`, companion, direction, voice, reason,
      status: direction === 'incoming' ? 'ringing' : 'active', createdAt: now(), answeredAt: null, endedAt: null, transcript: [] };
    if (call.status === 'active') call.answeredAt = call.createdAt;
    calls.set(call.id, call);
    if (call.status === 'ringing') timers.set(call.id, setTimeout(() => {
      if (call.status !== 'ringing') return;
      Object.assign(call, { status: 'missed', endedAt: now() }); save(call); settle(call);
    }, ringMs));
    return view(save(call));
  }
  return {
    /** The person calls a companion: the call is live from the start. */
    dial: ({ companion, voice }) => open({ companion, direction: 'outgoing', voice }),
    /** A companion calls the person: it rings until answered, declined or `ringMs` passes. */
    ring: ({ companion, reason }) => open({ companion, direction: 'incoming', reason }),
    /** Resolves when a ring stops ringing, with how it ended. */
    outcome(id) {
      const call = get(id);
      if (call.status !== 'ringing') return Promise.resolve(view(call));
      return new Promise(resolve => waiters.set(id, [...(waiters.get(id) ?? []), resolve]));
    },
    /** The first device to answer gets the call; every other one is told it went elsewhere. */
    answer(id) {
      const call = get(id);
      if (call.status !== 'ringing') throw new CallError(call.status === 'active' ? 'answered elsewhere' : `call is ${call.status}`);
      Object.assign(call, { status: 'active', answeredAt: now() }); save(call); settle(call);
      return view(call);
    },
    decline(id) {
      const call = get(id);
      if (call.status !== 'ringing') throw new CallError(`call is ${call.status}`);
      Object.assign(call, { status: 'declined', endedAt: now() }); save(call); settle(call);
      return view(call);
    },
    say(id, who, text) {
      const call = get(id);
      if (call.status !== 'active' || !text?.trim()) return view(call);
      call.transcript.push({ who, text: text.trim(), at: now() });
      return view(save(call));
    },
    end(id) {
      const call = get(id);
      if (call.status === 'ringing') { Object.assign(call, { status: 'missed', endedAt: now() }); save(call); settle(call); }
      else if (call.status === 'active') { Object.assign(call, { status: 'ended', endedAt: now() }); save(call); }
      return view(call);
    },
    get: id => view(get(id)),
    /** Ringing and live calls, for a device to show. */
    live: () => [...calls.values()].filter(call => ['ringing', 'active'].includes(call.status)).map(view),
    /** Calls of one companion since `since`, oldest first. */
    history: ({ companion, since = 0 } = {}) => [...calls.values()]
      .filter(call => (!companion || call.companion === companion) && call.createdAt >= since)
      .sort((a, b) => a.createdAt - b.createdAt).map(view),
    close() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}
